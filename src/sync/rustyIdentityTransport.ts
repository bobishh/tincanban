import { createRustyIdentityRequestProof, type RustyIdentityRequestProofPayload } from "@meta-uber/mesh-replication/rusty-identity-request-proof"
import { authorizeIdentityDataDevice, createLocalRootIdentityAuthorityView, mergeIdentityAuthorityViews,
  publicKeyId, verifyIdentityAuthorityView, type VerifiedIdentityAuthorityView, type PublicIdentity, type SignedEnvelope } from "@meta-uber/mesh-identity"
import { publishRustyIdentityAuthorityView, readRustyIdentityAuthorityStatus,
  RustyIdentityAuthorityStaleError } from "@meta-uber/mesh-replication/rusty-identity-authority"
import { classifyRustyPersonIdentityScope } from "@meta-uber/mesh-replication/rusty-scope-purpose"
import { ensureRustyScopeAuthoritySnapshot } from "@meta-uber/mesh-replication/rusty-scope-authority"
import { readRustyScopeAuthorityStatus } from "@meta-uber/mesh-replication/rusty-scope-authority"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { BlindAccess } from "./blindClient"
import { defaultProofStore } from "../domain/proofs"
import { canonicalizeJson } from "../domain/identityCrypto"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import type { LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signWithContext } from "../domain/signingContext"
import { defaultStorage } from "../storage"
import { fetchBlind, type RustyRequestInit } from "./rustyHttp"
import { rustyRequestFailure } from "./replicationErrors"
import { mergeIdentityAuthorityView, mergeRustyIdentityServiceEnforcement, readIdentityAuthorityView } from "./identityAuthorityStore"
import { peerStore } from "./peerStore"

export type RustyPrincipalRequestGrant = {
  grantId: string
  policyEpoch: number
  actions: readonly ("read" | "write")[]
  scopeAuthority?: unknown
}

export type RustyWorkspaceScopeAuthority = {
  workspaceId: string
  controllerPersonId: string
  controllerPublicKey: string
  controlEpoch: number
  snapshot: unknown
  receipt?: SignedEnvelope<Record<string, unknown> & { kind: string }>
}

export type RustyIdentityScopeFetcherOptions = {
  access: BlindAccess
  identity: PublicIdentity
  deviceId: string
  devicePublicKey: string
  authorityView: () => Promise<VerifiedIdentityAuthorityView>
  signAuthorization: (payload: RustyIdentityRequestProofPayload) => Promise<SignedEnvelope<RustyIdentityRequestProofPayload>>
  ensureCurrent?: () => void | Promise<void>
  principal?: RustyPrincipalRequestGrant
  profile?: LocalProfile
  workspace?: { workspaceId: string; scopeAuthority: () => Promise<unknown>; authorityIsReadOnly?: () => boolean }
  fetcher?: (url: string, init: RustyRequestInit) => Promise<Response>
}

export type RustyIdentityProfileFetcherOptions = Omit<RustyIdentityScopeFetcherOptions,
  "authorityView" | "signAuthorization" | "identity" | "deviceId" | "devicePublicKey" | "principal"> & {
  profile: LocalProfile
  principal?: RustyPrincipalRequestGrant
}

export type EnsureRustyIdentityAuthorityOptions = Pick<RustyIdentityProfileFetcherOptions,
  "profile" | "access" | "ensureCurrent" | "fetcher">

export type EnsureRustyPersonScopeOptions = EnsureRustyIdentityAuthorityOptions

const encoder = new TextEncoder()

/** Create the one scope-data request adapter. It refuses scope/origin/token mismatches before I/O. */
export function createRustyIdentityScopeFetcher(options: RustyIdentityScopeFetcherOptions) {
  const access = structuredClone(options.access)
  const fetcher = options.fetcher ?? fetchBlind
  const origin = new URL(access.origin).origin
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    await options.ensureCurrent?.()
    const request = await prepareScopeRequest(input, init, origin, access)
    if (options.workspace) {
      if (options.principal) {
        await verifyRegisteredPrincipalScope(options, access, origin)
      } else {
        if (!options.profile) throw new Error("Workspace Rusty authority signer is unavailable")
        const snapshot = await options.workspace.scopeAuthority()
        if (!options.workspace.authorityIsReadOnly?.()) {
          await ensureRustyWorkspaceScopeAuthority(options.profile, { ...access, workspaceId: options.workspace.workspaceId },
            snapshot, options.ensureCurrent, options.fetcher)
        }
      }
    }
    const principal = options.principal
    if (principal && !principal.actions.includes(request.action)) throw new Error("Rusty principal grant does not permit this action")
    const view = await options.authorityView()
    const proof = await createRustyIdentityRequestProof({
      origin, servicePublicKey: access.servicePublicKey, identity: structuredClone(options.identity), view,
      deviceId: options.deviceId, devicePublicKey: options.devicePublicKey, scopeId: access.scopeId, token: request.token,
      method: request.method, url: request.url, bodyBytes: request.body, action: request.action,
      grantId: principal?.grantId ?? null, policyEpoch: principal?.policyEpoch ?? access.policyRevision,
      signAuthorization: options.signAuthorization,
    })
    await options.ensureCurrent?.()
    request.headers.set("Authorization", proof.headers.authorization)
    request.headers.set("X-Rusty-Identity-Proof", proof.headerValue)
    return fetcher(proof.url, { ...init, method: request.method, headers: request.headers } as RustyRequestInit)
  }
}

async function verifyRegisteredPrincipalScope(options: RustyIdentityScopeFetcherOptions, access: BlindAccess, origin: string): Promise<void> {
  await options.ensureCurrent?.()
  const scopeStatus = await readRustyScopeAuthorityStatus({ origin, servicePublicKey: access.servicePublicKey,
    scopeId: access.scopeId, fetcher: (url, init) => fetchRustyScopeAuthority(url, init, options.fetcher),
    validateSnapshot: validateWorkspaceSnapshot })
  await mergeRustyIdentityServiceEnforcement(origin, scopeStatus.status.payload.serviceId, scopeStatus.status.payload.enforcement)
  await options.ensureCurrent?.()
  const expected = await options.workspace!.scopeAuthority()
  const runtime = meshRustRuntime().state
  const grantAuthority = runtime.validateScopeAuthority(expected, Date.now()) as ValidatedScopeAuthority
  const currentAuthority = scopeStatus.authority?.snapshot
  const mergedAuthority = currentAuthority ? runtime.mergeScopeAuthoritySnapshots(expected, currentAuthority, Date.now()) : null
  const normalizedCurrent = currentAuthority ? runtime.mergeScopeAuthoritySnapshots(currentAuthority, currentAuthority, Date.now()) : null
  const mergedView = mergedAuthority ? runtime.validateScopeAuthority(mergedAuthority, Date.now()) as ValidatedScopeAuthority : null
  assertRegisteredPrincipalScope(options, scopeStatus, expected, grantAuthority, mergedAuthority, normalizedCurrent, mergedView)
}

type ValidatedScopeAuthority = { scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number }

function assertRegisteredPrincipalScope(
  options: RustyIdentityScopeFetcherOptions,
  status: Awaited<ReturnType<typeof readRustyScopeAuthorityStatus>>,
  expected: unknown,
  grantAuthority: ValidatedScopeAuthority,
  mergedAuthority: unknown,
  normalizedCurrent: unknown,
  mergedView: ValidatedScopeAuthority | null,
): void {
  const accepted = status.authority
  if (status.status.payload.state !== "ready" || !accepted ||
      status.status.payload.workspaceId !== options.workspace!.workspaceId ||
      grantAuthority.scopeId !== options.workspace!.workspaceId || !mergedView ||
      canonicalizeJson(mergedAuthority) !== canonicalizeJson(normalizedCurrent) ||
      mergedView.scopeId !== accepted.workspaceId || mergedView.controlEpoch !== accepted.controlEpoch ||
      mergedView.controller.personId !== accepted.controllerPersonId ||
      mergedView.controller.publicKey !== accepted.controllerPublicKey ||
      canonicalizeJson(options.principal!.scopeAuthority) !== canonicalizeJson(expected)) {
    throw new Error("Rusty workspace principal grant is not registered at the current scope authority")
  }
}

function validateWorkspaceSnapshot(value: unknown): RustyWorkspaceScopeAuthority {
  const checked = meshRustRuntime().state.validateScopeAuthority(value, Date.now()) as ValidatedScopeAuthority
  return { workspaceId: checked.scopeId, controllerPersonId: checked.controller.personId,
    controllerPublicKey: checked.controller.publicKey, controlEpoch: checked.controlEpoch, snapshot: value }
}

type PreparedScopeRequest = { url: string; method: string; action: "read" | "write"; token: string; body: Uint8Array; headers: Headers }

async function prepareScopeRequest(input: RequestInfo | URL, init: RequestInit, origin: string, access: BlindAccess): Promise<PreparedScopeRequest> {
  const parsed = resolveScopeUrl(input, origin, access.scopeId)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  validateMethod(method)
  const action = method === "GET" || method === "HEAD" || method === "POST" && !parsed.pathname.endsWith("/checkpoint") ? "read" : "write"
  const token = tokenForAction(headers, action, access)
  return { url: parsed.href, method, action, token, body: await requestBody(input, init), headers }
}

function resolveScopeUrl(input: RequestInfo | URL, origin: string, scopeId: string): URL {
  const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const parsed = new URL(value, origin)
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.hash ||
      !parsed.pathname.startsWith(`/v2/scopes/${scopeId}/`)) throw new Error("Rusty request escapes its pinned scope or origin")
  return parsed
}

function validateMethod(method: string): void {
  if (!/^[A-Z]{3,12}$/.test(method)) throw new Error("Invalid Rusty request method")
}

function tokenForAction(headers: Headers, action: "read" | "write", access: BlindAccess): string {
  const authorization = headers.get("Authorization") ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
  if (!token || token !== (action === "read" ? access.readToken : access.writeToken)) {
    throw new Error("Rusty request token does not match the configured access")
  }
  return token
}

/** Create a scope fetcher that refreshes Rusty's signed authority high-water before every data request. */
export function createRustyIdentityProfileScopeFetcher(options: RustyIdentityProfileFetcherOptions) {
  const profile = structuredClone(options.profile)
  const metadata = options.access as BlindAccess & { workspaceId?: string; personId?: string;
    boardAccess?: { principalGrant?: { payload?: unknown } } }
  const access = structuredClone(options.access)
  const principal = options.principal ?? principalForBoardStorageAccess(metadata.boardAccess)
  const workspace = options.workspace ?? (metadata.workspaceId && !metadata.personId ? {
    workspaceId: metadata.workspaceId,
    scopeAuthority: async () => {
      if (principal?.scopeAuthority) return principal.scopeAuthority
      await options.ensureCurrent?.()
      const stored = await peerStore.getWorkspaceAuthority(metadata.workspaceId!) ?? await peerStore.getWorkspaceCredential(metadata.workspaceId!)
      await options.ensureCurrent?.()
      const snapshot = (stored as { scopeAuthoritySnapshot?: unknown } | null)?.scopeAuthoritySnapshot
      if (!snapshot) throw new Error("Verified workspace scope authority is required before Rusty access")
      return snapshot
    },
  } : undefined)
  const currentAuthorityView = async (): Promise<VerifiedIdentityAuthorityView> => {
    if (options.workspace?.authorityIsReadOnly?.()) {
      await options.ensureCurrent?.()
      const view = await readIdentityAuthorityView(profile.identity.personId)
      await options.ensureCurrent?.()
      if (!view || view.personId !== profile.identity.personId || view.identityPublicKey !== profile.identity.publicKey ||
          !view.certificates.some(certificate => canonicalizeJson(certificate) === canonicalizeJson(profile.certificate)) ||
          await authorizeIdentityDataDevice(view, profile.device.deviceId) !== profile.device.publicKey) {
        throw new Error("Current local Identity authority does not authorize Rusty workspace reads")
      }
      return view
    }
    return ensureRustyIdentityAuthorityPublished({ ...options, profile, access })
  }
  const sign = async (payload: RustyIdentityRequestProofPayload) => {
    const view = await readIdentityAuthorityView(profile.identity.personId)
    if (!view) throw new Error("Rusty Identity authority view is unavailable for signing")
    return await signForRusty(profile, view, payload, options.ensureCurrent)
  }
  return createRustyIdentityScopeFetcher({ ...options, access, identity: profile.identity,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
    principal, workspace,
    authorityView: currentAuthorityView, signAuthorization: sign })
}

/** Require one signed current authority view, publish it durably, and merge service enforcement monotonically. */
export async function ensureRustyIdentityAuthorityPublished(
  options: EnsureRustyIdentityAuthorityOptions,
): Promise<VerifiedIdentityAuthorityView> {
  const profile = structuredClone(options.profile)
  const access = structuredClone(options.access)
  const origin = new URL(access.origin).origin
  const fetcher = options.fetcher ?? fetchBlind
  await options.ensureCurrent?.()
  const status = await readRustyIdentityAuthorityStatus({ origin, servicePublicKey: access.servicePublicKey,
    identity: profile.identity, fetcher: (url, init) => fetcher(String(url), init ?? {}) })
  await mergeRustyIdentityServiceEnforcement(origin, status.payload.serviceId, status.payload.enforcement)
  const remoteView = status.payload.view ? await verifyIdentityAuthorityView(status.payload.view) : null
  const local = await mergeStatusAuthority(profile, status.payload.state, remoteView, options.ensureCurrent)
  const current = await publishAuthorityIfNeeded(profile, access, local, status.payload.state, remoteView, options.ensureCurrent, fetcher)
  await mergeRustyIdentityServiceEnforcement(origin, status.payload.serviceId, status.payload.enforcement)
  await options.ensureCurrent?.()
  return current
}

/** Bind a private Identity replica to its immutable self-only Rusty scope purpose. */
export async function ensureRustyPersonIdentityScope(options: EnsureRustyPersonScopeOptions): Promise<SignedEnvelope<Record<string, unknown> & { kind: string }>> {
  const profile = structuredClone(options.profile)
  const access = structuredClone(options.access)
  const authorityView = await ensureRustyIdentityAuthorityPublished(options)
  const receipt = await classifyRustyPersonIdentityScope({
    origin: access.origin, servicePublicKey: access.servicePublicKey, scopeId: access.scopeId,
    policyRevision: access.policyRevision, identity: profile.identity, authorityView,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
    fetcher: options.fetcher ? (url, init) => options.fetcher!(String(url), init ?? {}) : undefined,
    ensureCurrent: options.ensureCurrent,
    signAuthorization: payload => signForRusty(profile, authorityView, payload, options.ensureCurrent),
  })
  await mergeRustyIdentityServiceEnforcement(access.origin, receipt.payload.serviceId, receipt.payload.enforcement)
  await options.ensureCurrent?.()
  return receipt
}

/** Publish the workspace's accepted control ledger before owner data access or member admission. */
export async function ensureRustyWorkspaceScopeAuthority(profile: LocalProfile,
  access: BlindAccess & { workspaceId: string }, snapshot: unknown,
  ensureCurrent?: () => void | Promise<void>, fetcher?: (url: string, init: RustyRequestInit) => Promise<Response>): Promise<RustyWorkspaceScopeAuthority> {
  const validateSnapshot = (value: unknown): RustyWorkspaceScopeAuthority => {
    const checked = meshRustRuntime().state.validateScopeAuthority(value, Date.now()) as {
      scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
    }
    return { workspaceId: checked.scopeId, controllerPersonId: checked.controller.personId,
      controllerPublicKey: checked.controller.publicKey, controlEpoch: checked.controlEpoch, snapshot: value }
  }
  const proposed = validateSnapshot(snapshot)
  if (proposed.workspaceId !== access.workspaceId || proposed.controllerPersonId !== profile.identity.personId ||
      proposed.controllerPublicKey !== profile.identity.publicKey) throw new Error("Workspace authority is not controlled by the current Identity")
  const view = await ensureRustyIdentityAuthorityPublished({ profile, access, ensureCurrent, fetcher })
  const serviceId = await publicKeyId(access.servicePublicKey)
  const published = await ensureRustyScopeAuthoritySnapshot({ origin: access.origin, servicePublicKey: access.servicePublicKey,
    scopeId: access.scopeId, workspaceId: access.workspaceId, identity: profile.identity, authorityView: view,
    deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey, scopeAuthority: proposed.snapshot,
    fetcher: (url, init) => fetchRustyScopeAuthority(url, init, fetcher), ensureCurrent, validateSnapshot,
    mergeSnapshots: (current, incoming) => meshRustRuntime().state.mergeScopeAuthoritySnapshots(current, incoming, Date.now()),
    observeEnforcement: async enforcement => { await mergeRustyIdentityServiceEnforcement(access.origin, serviceId, enforcement) },
    signAuthorization: payload => signForRusty(profile, view, payload, ensureCurrent) })
  if (published.receipt) {
    await mergeRustyIdentityServiceEnforcement(access.origin, published.receipt.payload.serviceId, published.receipt.payload.enforcement)
  }
  await ensureCurrent?.()
  return { ...published.scopeAuthority, ...(published.receipt ? { receipt: published.receipt } : {}) }
}

/** Read the accepted Rusty scope ledger without creating or updating workspace authority. */
export async function readRustyOwnerWorkspaceScopeAuthority(profile: LocalProfile,
  access: BlindAccess & { workspaceId: string }, ensureCurrent?: () => void | Promise<void>,
  fetcher?: (url: string, init: RustyRequestInit) => Promise<Response>): Promise<RustyWorkspaceScopeAuthority> {
  await ensureCurrent?.()
  const origin = new URL(access.origin).origin
  const result = await readRustyScopeAuthorityStatus({ origin, servicePublicKey: access.servicePublicKey,
    scopeId: access.scopeId, fetcher: (url, init) => fetchRustyScopeAuthority(url, init, fetcher),
    validateSnapshot: validateWorkspaceSnapshot })
  await ensureCurrent?.()
  const accepted = result.authority
  if (result.status.payload.state !== "ready" || !accepted ||
      result.status.payload.workspaceId !== access.workspaceId || accepted.workspaceId !== access.workspaceId ||
      accepted.controllerPersonId !== profile.identity.personId ||
      accepted.controllerPublicKey !== profile.identity.publicKey) {
    throw new Error("Rusty accepted workspace authority does not belong to the current Identity")
  }
  return accepted
}

async function fetchRustyScopeAuthority(url: RequestInfo | URL, init: RequestInit | undefined,
  fetcher?: (url: string, init: RustyRequestInit) => Promise<Response>): Promise<Response> {
  const response = await (fetcher ? fetcher(String(url), init ?? {}) : fetchBlind(String(url), init ?? {}))
  if (new URL(String(url)).pathname.endsWith("/authority/status") && !response.ok) {
    await response.body?.cancel()
    throw rustyRequestFailure(new Error(`Rusty workspace scope authority status failed with HTTP ${response.status}`), response.status)
  }
  return response
}

export function principalForBoardStorageAccess(boardAccess?: { principalGrant?: { payload?: unknown } }): RustyPrincipalRequestGrant | undefined {
  if (!boardAccess) return undefined
  const payload = boardAccess.principalGrant?.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Participant Rusty storage requires its signed principal grant")
  }
  const value = payload as Record<string, unknown>
  if (value.kind !== "rusty-resource-principal-grant" || typeof value.grantId !== "string" ||
      !Number.isSafeInteger(value.policyEpoch)) {
    throw new Error("Participant Rusty storage principal grant is invalid")
  }
  const actions = parsePrincipalActions(value.actions)
  if (!value.scopeAuthority || typeof value.scopeAuthority !== "object") throw new Error("Participant Rusty scope authority is required")
  return { grantId: value.grantId, policyEpoch: value.policyEpoch as number, actions, scopeAuthority: value.scopeAuthority }
}

function parsePrincipalActions(value: unknown): ("read" | "write")[] {
  if (!Array.isArray(value) || value.some(action => action !== "read" && action !== "write") ||
      !value.includes("read") || value.length > 2 || (value.length === 2 && !value.includes("write"))) {
    throw new Error("Participant Rusty storage principal grant is invalid")
  }
  return value.length === 1 ? ["read"] : ["read", "write"]
}

async function mergeStatusAuthority(profile: LocalProfile, state: "missing" | "ready", remoteView: VerifiedIdentityAuthorityView | null,
  ensureCurrent?: () => void | Promise<void>): Promise<VerifiedIdentityAuthorityView> {
  if (remoteView) {
    await ensureCurrent?.()
    await mergeIdentityAuthorityView(remoteView)
    await ensureCurrent?.()
  }
  let local = await readIdentityAuthorityView(profile.identity.personId)
  if (!local && state === "ready" && remoteView) local = await mergeIdentityAuthorityView(remoteView)
  if (!local && state === "missing") local = await createFreshLocalAuthority(profile)
  if (!local) throw new Error("Rusty Identity authority view is unavailable")
  if (local.personId !== profile.identity.personId || local.identityPublicKey !== profile.identity.publicKey) {
    throw new Error("Local Rusty Identity authority view belongs to another identity")
  }
  if (remoteView) {
    local = await mergeIdentityAuthorityViews(local, remoteView)
    await ensureCurrent?.()
    local = await mergeIdentityAuthorityView(local)
  }
  return local
}

async function createFreshLocalAuthority(profile: LocalProfile): Promise<VerifiedIdentityAuthorityView> {
  const root = await defaultStorage.loadPersonalRoot()
  if (!root || root.identity.personId !== profile.identity.personId || root.identity.publicKey !== profile.identity.publicKey ||
      !profile.privateKeys.identityPrivateKey) {
    throw new Error("Rusty has no Identity authority view; an adopted app device cannot create a new root")
  }
  const certificates = [profile.certificate, ...await defaultProofStore.listCertificates()]
    .filter(certificate => certificate.payload.personId === profile.identity.personId)
  const view = await createLocalRootIdentityAuthorityView(profile,
    { certificates, revocations: [] }, await rootIdentityProfileState(root))
  return await mergeIdentityAuthorityView(view)
}

async function publishAuthorityIfNeeded(profile: LocalProfile, access: BlindAccess, local: VerifiedIdentityAuthorityView,
  state: "missing" | "ready", remoteView: VerifiedIdentityAuthorityView | null,
  ensureCurrent?: () => void | Promise<void>, fetcher?: (url: string, init: RustyRequestInit) => Promise<Response>): Promise<VerifiedIdentityAuthorityView> {
  if (state === "ready" && remoteView && remoteView.viewDigest === local.viewDigest &&
      remoteView.revocationHead.recordHash === local.revocationHead.recordHash) return local
  try {
    const receipt = await publishAuthorityView(profile, access, local, ensureCurrent, fetcher)
    await mergeRustyIdentityServiceEnforcement(access.origin, receipt.payload.serviceId, receipt.payload.enforcement)
    return local
  } catch (cause) {
    if (!(cause instanceof RustyIdentityAuthorityStaleError)) throw cause
    const merged = await mergeIdentityAuthorityViews(local, cause.view)
    await ensureCurrent?.()
    const persisted = await mergeIdentityAuthorityView(merged)
    const receipt = await publishAuthorityView(profile, access, persisted, ensureCurrent, fetcher)
    await mergeRustyIdentityServiceEnforcement(access.origin, receipt.payload.serviceId, receipt.payload.enforcement)
    return persisted
  }
}

async function publishAuthorityView(profile: LocalProfile, access: BlindAccess, view: VerifiedIdentityAuthorityView,
  ensureCurrent?: () => void | Promise<void>, fetcher?: (url: string, init: RustyRequestInit) => Promise<Response>) {
  return await publishRustyIdentityAuthorityView({ origin: access.origin, servicePublicKey: access.servicePublicKey,
    identity: profile.identity, deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey, view,
    fetcher: (url, init) => (fetcher ?? fetchBlind)(String(url), init ?? {}), ensureCurrent,
    signAuthorization: payload => signForRusty(profile, view, payload, ensureCurrent) })
}

async function signForRusty<T extends { kind: string; origin?: string; serviceId?: string; personId?: string; deviceId?: string;
  scopeId?: string; workspaceId?: string; resourceId?: string }>(profile: LocalProfile, view: VerifiedIdentityAuthorityView,
  payload: T, ensureCurrent?: () => void | Promise<void>): Promise<SignedEnvelope<T>> {
  const binding: Record<string, string | number> = {}
  for (const field of ["origin", "serviceId", "personId", "deviceId", "scopeId", "workspaceId", "resourceId"] as const) {
    const value = payload[field]
    if (typeof value === "string" || typeof value === "number") binding[field] = value
  }
  const context = await resolveLocalSigningContext(profile, payload.kind, binding, { certificates: view.certificates,
    ensureCurrent, currentAuthority: async () => {
      await ensureCurrent?.()
      const current = await readIdentityAuthorityView(profile.identity.personId)
      if (!current || current.viewDigest !== view.viewDigest) throw new Error("Rusty Identity authority changed while signing")
      return current.viewDigest
    } })
  return await signWithContext(context, payload)
}

async function requestBody(input: RequestInfo | URL, init: RequestInit): Promise<Uint8Array> {
  const body = init.body !== undefined ? init.body : input instanceof Request ? input.body : null
  if (body === null) return new Uint8Array()
  if (typeof body === "string") return encoder.encode(body)
  if (body instanceof URLSearchParams) return encoder.encode(body.toString())
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
  throw new Error("Rusty request body must be replayable bytes")
}
