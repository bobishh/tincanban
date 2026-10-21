import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url, verifyEnvelope, type SignedEnvelope } from "@meta-uber/mesh-identity"
import { fetchRusty, readRustyJson } from "@meta-uber/mesh-replication/rusty-replica"
import type { Context } from "@opentelemetry/api"
import type { DeviceCertificate, PublicIdentity, WorkspaceGrant } from "../domain/model"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { validatePublicBoardProjection, type PublicBoardProjection } from "./publicSchema"

type PublicDeliveryHttpPort = {
  request: (url: string, init: RequestInit, diagnosticContext?: Context) => Promise<Response>
  readJson: <T>(response: Response, maximumBytes: number) => Promise<T>
}

export type PublicDeliveryCommand = {
  kind: "rusty-publication-command"; version: 1; challengeId: string; nonce: string; serviceId: string
  publicOrigin: string; boardId: string; action: "update" | "stage-file"; projectionHash: string
  expectedRevision: number; expiresAt: number; deliveryGeneration: number; deliveryGrantId: string
  sourceHeadsHash: string; byteLength?: number
}
type PublicDeliverySource = {
  origin: string; boardId: string; workspaceId: string; identity: PublicIdentity; deviceId: string
  sourceHeads: string[]
  client?: "tincanban" | "automation"
  diagnosticContext?: Context
  http?: PublicDeliveryHttpPort
  ensureCurrent: () => void | Promise<void>
  ensureSourceCovers: (heads: string[]) => void | Promise<void>
  sign: (payload: PublicDeliveryCommand) => Promise<SignedEnvelope<PublicDeliveryCommand>>
  buildProjection: (current: PublicBoardProjection, stageAsset: (asset: { sha256: string; bytes: Uint8Array }) => Promise<void>) => Promise<PublicBoardProjection>
}
type PublicDeliveryProof = { certificates: DeviceCertificate[]; grant: WorkspaceGrant }
export type PublicDeliveryInput = PublicDeliverySource & (
  (PublicDeliveryProof & { resolveWriter?: never }) |
  { resolveWriter: () => Promise<PublicDeliveryProof>; certificates?: never; grant?: never }
)
type AuthorizedDeliveryInput = PublicDeliverySource & PublicDeliveryProof
type Challenge = {
  kind: "rusty-publication-challenge"; version: 1; challengeId: string; nonce: string; serviceId: string
  publicOrigin: string; boardId: string; personId: string; deviceId: string; deviceKeyId: string
  expectedRevision: number; issuedAt: number; expiresAt: number; withdrawn: boolean; projectionHash: string
  deliveryGeneration: number; deliveryGrantId: string; sourceHeadsHash: string
  currentSourceHeads: string[]
}
const encoder = new TextEncoder()
const hash = (value: unknown) => sha256Base64Url(encoder.encode(canonicalizeJson(value)))
const hashPattern = /^[A-Za-z0-9_-]{43}$/

/** Retry from durable admitted source in either a browser writer or an automation Worker. */
export async function deliverPublicBoard(source: PublicDeliveryInput): Promise<{ revision: number; hash: string } | null> {
  const origin = blindOrigin(source.origin)
  const sourceHeads = admittedSourceHeads(source.sourceHeads)
  await source.ensureCurrent()
  const endpoint = `${origin}/v1/public/boards/${encodeURIComponent(source.boardId)}`
  const http = source.http ?? {
    request: (url: string, init: RequestInit) => fetchRusty(url, init),
    readJson: async <T>(response: Response, maximumBytes: number) => await readRustyJson(response, maximumBytes) as T,
  }
  const request: PublicDeliveryHttpPort["request"] = (url, init, diagnosticContext) => {
    const headers = new Headers(init.headers)
    headers.set("X-Rusty-Client", source.client ?? "tincanban")
    return http.request(url, { ...init, headers }, diagnosticContext ?? source.diagnosticContext)
  }
  const current = await readCurrentBoard(request, endpoint, source, http.readJson)
  if (!current) return null
  const proof: PublicDeliveryProof = source.resolveWriter ? await source.resolveWriter() : source
  const input: AuthorizedDeliveryInput = { ...source, ...proof }
  await input.ensureCurrent()
  const service = await readDeliveryService(origin, request, http.readJson)
  const writer = deliveryWriter(input, sourceHeads)
  const sourceHeadsHash = await hash(sourceHeads)
  const context = { input, origin, endpoint, request, http, current, service, writer, sourceHeadsHash }
  let generation: number | undefined
  const challenge = async () => {
    const envelope = await requestDeliveryChallenge(context)
    const payload = envelope.payload
    if (generation !== undefined && payload.deliveryGeneration !== generation) throw new Error("Public delivery challenge changed or is invalid")
    generation = payload.deliveryGeneration
    return envelope
  }
  const signCommand = (envelope: SignedEnvelope<Challenge>, action: PublicDeliveryCommand["action"], projectionHash: string, byteLength?: number) =>
    signDeliveryCommand(context, envelope, action, projectionHash, byteLength)
  const verifyReceipt = (receipt: SignedEnvelope<Record<string, unknown>>, envelope: SignedEnvelope<Challenge>, authorization: SignedEnvelope<PublicDeliveryCommand>) =>
    verifyDeliveryReceipt(context, receipt, envelope, authorization)

  const staged = new Set<string>()
  const initialChallenge = await challenge()
  const next = validatePublicBoardProjection(await input.buildProjection(current.projection, async asset => {
    if (staged.has(asset.sha256)) return
    await stagePublicAsset(context, asset, writer, challenge, signCommand, verifyReceipt)
    staged.add(asset.sha256)
  }))
  if (next.board.id !== input.boardId) throw new Error("Public delivery changed source board")
  const nextHash = await hash(next)
  if (nextHash === current.hash) { await input.ensureCurrent(); return { revision: current.revision, hash: current.hash } }
  const envelope = staged.size ? await challenge() : initialChallenge
  const authorization = await signCommand(envelope, "update", nextHash)
  const receipt = await http.readJson<SignedEnvelope<Record<string, unknown>>>(await request(endpoint, {
    method: "PUT", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: envelope, ...writer, action: "update", projection: next, authorization }),
  }), 16384)
  await verifyReceipt(receipt, envelope, authorization)
  const p = receipt.payload
  if (p.kind !== "rusty-publication-receipt" || p.controllerPersonId !== input.identity.personId || p.action !== "update" || p.withdrawn !== false ||
    p.projectionHash !== nextHash || p.revision !== current.revision + 1) throw new Error("Public delivery receipt does not cover the new revision")
  return { revision: current.revision + 1, hash: nextHash }
}

type CurrentPublicBoard = { revision: number; hash: string; projection: PublicBoardProjection }
type PublicDeliveryService = { serviceId: string; publicKey: string }
type PublicDeliveryWriter = { identity: PublicIdentity; deviceId: string; certificates: DeviceCertificate[]; deliveryGrant: WorkspaceGrant; sourceHeads: string[] }
type DeliveryContext = { input: AuthorizedDeliveryInput; origin: string; endpoint: string; request: PublicDeliveryHttpPort["request"];
  http: PublicDeliveryHttpPort;
  current: CurrentPublicBoard; service: PublicDeliveryService; writer: PublicDeliveryWriter; sourceHeadsHash: string }
type DeliveryAsset = { sha256: string; bytes: Uint8Array }

function admittedSourceHeads(value: string[] | undefined): string[] {
  const heads = [...new Set(value ?? [])].sort()
  if (!heads.length || heads.length > 256 || heads.some(head => !/^[0-9a-f]{64}$/.test(head))) {
    throw new Error("Public delivery requires an admitted source frontier")
  }
  return heads
}

async function readCurrentBoard(request: PublicDeliveryHttpPort["request"], endpoint: string, input: PublicDeliverySource,
  readJson: PublicDeliveryHttpPort["readJson"]): Promise<CurrentPublicBoard | null> {
  const response = await request(endpoint, { cache: "no-store", signal: AbortSignal.timeout(15000) })
  if (response.status === 404) { await response.body?.cancel(); await input.ensureCurrent(); return null }
  const current = await readJson<{ boardId: string; revision: number; projection: unknown; hash: string }>(response, 3 * 1024 * 1024)
  const projection = validatePublicBoardProjection(current.projection)
  if (current.boardId !== input.boardId || projection.board.id !== input.boardId || !Number.isSafeInteger(current.revision) || current.revision < 1 ||
      await hash(projection) !== current.hash) throw new Error("Public delivery source integrity check failed")
  await input.ensureCurrent()
  return { revision: current.revision, hash: current.hash, projection }
}

async function readDeliveryService(origin: string, request: PublicDeliveryHttpPort["request"],
  readJson: PublicDeliveryHttpPort["readJson"]): Promise<PublicDeliveryService> {
  const descriptor = await readJson<{ publicOrigin: string; service: PublicDeliveryService; capabilities: { publicBoardPublication?: { deliveryVersion?: number } } }>(
    await request(`${origin}/.well-known/mesh-lighthouse`, { signal: AbortSignal.timeout(10000) }), 16384)
  const service = descriptor.service
  if (descriptor.publicOrigin !== origin || descriptor.capabilities.publicBoardPublication?.deliveryVersion !== 1 ||
      !service || await sha256Base64Url(fromBase64Url(service.publicKey)) !== service.serviceId) throw new Error("Rusty needs automatic public delivery support")
  return service
}

function deliveryWriter(input: AuthorizedDeliveryInput, sourceHeads: string[]): PublicDeliveryWriter {
  const identity = structuredClone(input.identity)
  const grant = structuredClone(input.grant)
  if (grant.payload.workspaceId !== input.workspaceId || grant.payload.personId !== identity.personId ||
      !["editor", "automation"].includes(grant.payload.role)) throw new Error("Public delivery grant does not cover this writer")
  return { identity, deviceId: input.deviceId, certificates: structuredClone(input.certificates), deliveryGrant: grant, sourceHeads }
}

async function requestDeliveryChallenge(context: DeliveryContext): Promise<SignedEnvelope<Challenge>> {
  const { input, origin, writer, request, http } = context
  await input.ensureCurrent()
  const { challenge } = await http.readJson<{ challenge: SignedEnvelope<Challenge> }>(await request(`${origin}/v1/public/challenges`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, boardId: input.boardId, ...writer }),
  }), 16384)
  if (!await validDeliveryChallenge(context, challenge)) throw new Error("Public delivery challenge changed or is invalid")
  await input.ensureSourceCovers(challenge.payload.currentSourceHeads)
  await input.ensureCurrent()
  return challenge
}

async function validDeliveryChallenge(context: DeliveryContext, challenge: SignedEnvelope<Challenge>): Promise<boolean> {
  const { service } = context
  const p = challenge?.payload
  const now = Date.now()
  if (!p || challenge.signerKeyId !== service.serviceId || !await verifyEnvelope(challenge, service.publicKey, "RUSTY/2")) return false
  return validChallengeIdentity(context, p) && validChallengeRevision(context, p) && validChallengeAuthorization(context, p) &&
    validChallengeGeneration(p) && validChallengeLifetime(p, now) && validSourceFrontier(p.currentSourceHeads)
}

function validChallengeIdentity(context: DeliveryContext, p: Challenge): boolean {
  const { input, origin, service, writer } = context
  return p.kind === "rusty-publication-challenge" && p.version === 1 && p.serviceId === service.serviceId && p.publicOrigin === origin &&
    p.boardId === input.boardId && p.personId === writer.identity.personId && p.deviceId === writer.deviceId && p.deviceKeyId === writer.deviceId
}

function validChallengeRevision(context: DeliveryContext, p: Challenge): boolean {
  const { current } = context
  return p.expectedRevision === current.revision && p.projectionHash === current.hash && !p.withdrawn &&
    hashPattern.test(p.challengeId) && hashPattern.test(p.nonce)
}

function validChallengeAuthorization(context: DeliveryContext, p: Challenge): boolean {
  const { writer, sourceHeadsHash } = context
  return p.deliveryGrantId === writer.deliveryGrant.payload.grantId && p.sourceHeadsHash === sourceHeadsHash
}

function validChallengeGeneration(p: Challenge): boolean {
  return Number.isSafeInteger(p.deliveryGeneration) && p.deliveryGeneration >= 1
}

function validChallengeLifetime(p: Challenge, now: number): boolean {
  return Number.isSafeInteger(p.issuedAt) && Number.isSafeInteger(p.expiresAt) && p.issuedAt <= now + 5000 && p.expiresAt > now &&
    p.expiresAt > p.issuedAt && p.expiresAt - p.issuedAt <= 120000
}

function validSourceFrontier(heads: string[]): boolean {
  return Array.isArray(heads) && heads.length <= 256 && heads.every(head => /^[0-9a-f]{64}$/.test(head))
}

async function signDeliveryCommand(context: DeliveryContext, envelope: SignedEnvelope<Challenge>, action: PublicDeliveryCommand["action"],
  projectionHash: string, byteLength?: number): Promise<SignedEnvelope<PublicDeliveryCommand>> {
  const { input, origin, current, service, writer, sourceHeadsHash } = context
  const p = envelope.payload
  const payload: PublicDeliveryCommand = {
    kind: "rusty-publication-command", version: 1, challengeId: p.challengeId, nonce: p.nonce,
    serviceId: service.serviceId, publicOrigin: origin, boardId: input.boardId, action, projectionHash,
    expectedRevision: current.revision, expiresAt: p.expiresAt, deliveryGeneration: p.deliveryGeneration,
    deliveryGrantId: p.deliveryGrantId, sourceHeadsHash, ...(byteLength === undefined ? {} : { byteLength }),
  }
  await input.ensureCurrent()
  const authorization = await input.sign(payload)
  await input.ensureCurrent()
  if (canonicalizeJson(authorization.payload) !== canonicalizeJson(payload) || authorization.signerKeyId !== writer.deviceId) {
    throw new Error("Public delivery signer changed the command")
  }
  return authorization
}

async function verifyDeliveryReceipt(context: DeliveryContext, receipt: SignedEnvelope<Record<string, unknown>>,
  envelope: SignedEnvelope<Challenge>, authorization: SignedEnvelope<PublicDeliveryCommand>): Promise<void> {
  const { input, service } = context
  const p = receipt.payload
  if (receipt.signerKeyId !== service.serviceId || !await verifyEnvelope(receipt as SignedEnvelope<{ kind: string }>, service.publicKey, "RUSTY/2") ||
      p.serviceId !== service.serviceId || p.boardId !== input.boardId || p.version !== 1 || p.challengeId !== envelope.payload.challengeId ||
      p.authorizationHash !== await hash(authorization)) throw new Error("Public delivery receipt signature or binding is invalid")
  await input.ensureCurrent()
}

async function stagePublicAsset(context: DeliveryContext, asset: DeliveryAsset, writer: PublicDeliveryWriter,
  challenge: () => Promise<SignedEnvelope<Challenge>>,
  signCommand: (envelope: SignedEnvelope<Challenge>, action: PublicDeliveryCommand["action"], hash: string, byteLength?: number) => Promise<SignedEnvelope<PublicDeliveryCommand>>,
  verifyReceipt: (receipt: SignedEnvelope<Record<string, unknown>>, envelope: SignedEnvelope<Challenge>, authorization: SignedEnvelope<PublicDeliveryCommand>) => Promise<void>): Promise<void> {
  const { input, endpoint, request } = context
  if (asset.bytes.byteLength > 16 * 1024 * 1024 || await sha256Base64Url(asset.bytes) !== asset.sha256) throw new Error("Public delivery file bytes changed")
  const envelope = await challenge()
  const authorization = await signCommand(envelope, "stage-file", asset.sha256, asset.bytes.byteLength)
  const receipt = await context.http.readJson<SignedEnvelope<Record<string, unknown>>>(await request(`${endpoint}/files`, {
    method: "PUT", signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: envelope, ...writer, sha256: asset.sha256, byteLength: asset.bytes.byteLength, bytes: toBase64Url(asset.bytes), authorization }),
  }), 16384)
  await verifyReceipt(receipt, envelope, authorization)
  if (receipt.payload.kind !== "rusty-public-asset-receipt" || receipt.payload.sha256 !== asset.sha256 || receipt.payload.byteLength !== asset.bytes.byteLength) {
    throw new Error("Public delivery file receipt does not cover these bytes")
  }
  await input.ensureCurrent()
}
