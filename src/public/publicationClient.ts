import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson, sha256Base64Url, toBase64Url, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signingEvidence, signWithContext } from "../domain/signingContext"
import type { DeviceCertificate, WorkspaceDocumentV2 } from "../domain/model"
import { blindOrigin, fetchBlind, readBlindJson } from "../sync/blindClient"
import { verifyRustyManagementCapability, type RustyManagementCapability } from "../sync/rustyManagementCapability"
import { resolveRustyManagementAuthority, rustyManagementAuthorityRevision } from "../sync/rustyManagementClient"
import type { ManagementBinding } from "../sync/rustyManagementRepository"
import { snapshotPublicBoardSource, type PublicBoardProjection } from "./publicProjection"
import { createBrowserBoardPublication as createPublicBoardPublication } from "../app/publicBoardPublication"
import type { PublicBoardDeliveryPolicyEvidence } from "./publicDeliveryPolicy"
import { includesWorkspaceHeads } from "../storageCatalog"

type Challenge = { kind: "rusty-publication-challenge"; version: 1; challengeId: string; nonce: string; serviceId: string; publicOrigin: string; boardId: string; personId: string; deviceId: string; deviceKeyId: string; expectedRevision: number; issuedAt: number; expiresAt: number; withdrawn: boolean; projectionHash: string; deliveryGeneration?: number | null; deliveryPolicyHash?: string | null; deliveryPolicyContentHash?: string | null; deliveryGrantId?: string | null; sourceHeadsHash?: string | null; currentSourceHeads?: string[] }
type Receipt = SignedEnvelope<{ kind: "rusty-publication-receipt"; version: 1; serviceId: string; boardId: string; controllerPersonId: string; revision: number; action: string; projectionHash: string; challengeId: string; authorizationHash: string; withdrawn: boolean }>
const encoder = new TextEncoder()
type PublicationService = { origin: string; serviceId: string; serviceKey: string; scopeManagement: boolean; presentation: boolean; fieldConfiguration: boolean }

async function controllerCertificates(profile: LocalProfile): Promise<DeviceCertificate[]> {
  const context = await resolveLocalSigningContext(profile, "rusty-publication-command", { personId: profile.identity.personId })
  return signingEvidence(context).certificates
}
async function service(origin: string): Promise<PublicationService> {
  const normalized = blindOrigin(origin)
  const descriptor = await readBlindJson<{ publicOrigin: string; service: { serviceId: string; publicKey: string }; capabilities: { publicBoardPublication?: { version: number; presentationVersion?: number; fieldConfigurationVersion?: number }; scopeManagement?: { version: number } } }>(
    await fetchBlind(`${normalized}/.well-known/mesh-lighthouse`, { signal: AbortSignal.timeout(10000) }), 16384)
  if (descriptor.publicOrigin !== normalized || descriptor.capabilities?.publicBoardPublication?.version !== 1 ||
      await sha256Base64Url((await import("../domain/identity")).fromBase64Url(descriptor.service.publicKey)) !== descriptor.service.serviceId) {
    throw new Error("Keeper does not support public board publication")
  }
  if (Object.hasOwn(descriptor.capabilities, "scopeManagement") && descriptor.capabilities.scopeManagement?.version !== 1) {
    throw new Error("Keeper advertises an unsupported management capability version")
  }
  return { origin: normalized, serviceId: descriptor.service.serviceId, serviceKey: descriptor.service.publicKey,
    scopeManagement: descriptor.capabilities.scopeManagement?.version === 1, presentation: descriptor.capabilities.publicBoardPublication?.presentationVersion === 1, fieldConfiguration: descriptor.capabilities.publicBoardPublication?.fieldConfigurationVersion === 1 }
}
function managementBinding(server: PublicationService, boardId: string): ManagementBinding {
  return { origin: server.origin, servicePublicKey: server.serviceKey, resourceKind: "board", resourceId: boardId }
}
async function managementAuthority(server: PublicationService, boardId: string, profile: LocalProfile, operation: string): Promise<SignedEnvelope<RustyManagementCapability> | undefined> {
  return resolveRustyManagementAuthority(managementBinding(server, boardId), profile, operation, server.scopeManagement)
}

async function challenge(origin: string, boardId: string, profile: LocalProfile, certificates: DeviceCertificate[], serviceId: string, serviceKey: string,
  capability?: SignedEnvelope<RustyManagementCapability>, currentAuthority?: () => Promise<string>, sourceHeads?: string[]) {
  await currentAuthority?.()
  const request = { version: 1, boardId, identity: profile.identity, deviceId: profile.device.deviceId, certificates,
    ...(sourceHeads?.length ? { sourceHeads } : {}),
    ...(capability ? { managementCapability: capability } : {}) }
  const response = await readBlindJson<{ challenge: SignedEnvelope<Challenge> }>(await fetchBlind(`${origin}/v1/public/challenges`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }), 16384)
  const signed = response.challenge
  const payload = await validateChallenge(signed, { origin, boardId, profile, serviceId, serviceKey, sourceHeads })
  await currentAuthority?.()
  return { envelope: signed, payload }
}
async function validateChallenge(signed: SignedEnvelope<Challenge>, input: { origin: string; boardId: string; profile: LocalProfile;
  serviceId: string; serviceKey: string; sourceHeads?: string[] }) {
  if (!signed?.payload || signed.signerKeyId !== input.serviceId || !await verifyEnvelope(signed, input.serviceKey, "RUSTY/2")) {
    throw new Error("Keeper publication challenge signature invalid")
  }
  const payload = signed.payload
  if (!challengeIdentityMatches(payload, input.origin, input.boardId, input.profile, input.serviceId) || !validChallengeTiming(payload, Date.now())) {
    throw new Error("Keeper publication challenge binding is invalid")
  }
  if (payload.deliveryPolicyContentHash != null &&
      (typeof payload.deliveryPolicyContentHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.deliveryPolicyContentHash))) {
    throw new Error("Keeper publication policy content hash is invalid")
  }
  const expectedHeadsHash = input.sourceHeads?.length
    ? await sha256Base64Url(encoder.encode(canonicalizeJson([...input.sourceHeads].sort()))) : null
  if (payload.sourceHeadsHash !== undefined && payload.sourceHeadsHash !== expectedHeadsHash) {
    throw new Error("Keeper publication challenge source frontier changed")
  }
  return payload
}
function challengeIdentityMatches(payload: Challenge, origin: string, boardId: string, profile: LocalProfile, serviceId: string): boolean {
  return payload.kind === "rusty-publication-challenge" && payload.version === 1 && payload.serviceId === serviceId && payload.publicOrigin === origin &&
    payload.boardId === boardId && payload.personId === profile.identity.personId && payload.deviceId === profile.device.deviceId && payload.deviceKeyId === profile.device.deviceId &&
    /^[A-Za-z0-9_-]{43}$/.test(payload.challengeId) && /^[A-Za-z0-9_-]{43}$/.test(payload.nonce) && typeof payload.withdrawn === "boolean" && /^[A-Za-z0-9_-]{43}$/.test(payload.projectionHash)
}
function validChallengeTiming(payload: Challenge, now: number): boolean {
  return Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0 && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt) &&
    payload.issuedAt <= now + 5000 && payload.expiresAt > now && payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= 120000
}
async function signedCommand(challengePayload: Challenge, origin: string, profile: LocalProfile, action: string, projectionHash: string,
  extra: Record<string, unknown> = {}, currentAuthority?: () => Promise<string>, sourceHeads?: string[], deliveryPolicy?: PublicBoardDeliveryPolicyEvidence) {
  const context = await resolveLocalSigningContext(profile, "rusty-publication-command", {
    serviceId: challengePayload.serviceId, publicOrigin: origin, boardId: challengePayload.boardId,
    challengeId: challengePayload.challengeId, nonce: challengePayload.nonce, action, projectionHash,
  }, { expiresAt: challengePayload.expiresAt, currentAuthority })
  return signWithContext(context, {
    kind: "rusty-publication-command", version: 1, challengeId: challengePayload.challengeId, nonce: challengePayload.nonce,
    serviceId: challengePayload.serviceId, publicOrigin: origin, boardId: challengePayload.boardId, action,
    projectionHash, expectedRevision: challengePayload.expectedRevision, expiresAt: challengePayload.expiresAt,
    ...(sourceHeads?.length ? { sourceHeadsHash: await sha256Base64Url(encoder.encode(canonicalizeJson([...sourceHeads].sort()))) } : {}),
    ...(deliveryPolicy ? { deliveryPolicyHash: await sha256Base64Url(encoder.encode(canonicalizeJson(deliveryPolicy))) } : {}), ...extra,
  })
}
async function stageAsset(server: PublicationService, boardId: string, profile: LocalProfile, certificates: DeviceCertificate[], expectedRevision: number,
  asset: { sha256: string; bytes: Uint8Array }, capability?: SignedEnvelope<RustyManagementCapability>, ensureCurrent?: () => void | Promise<void>, sourceHeads?: string[], sourceDocument?: WorkspaceDocumentV2) {
  await ensureCurrent?.()
  const { origin, serviceId, serviceKey } = server
  if (capability) await verifyRustyManagementCapability(capability, managementBinding(server, boardId), {
    personId: profile.identity.personId, deviceId: profile.device.deviceId, resourceKind: "board", resourceId: boardId,
    operation: "publication.stage-file", minimumRevision: capability.payload.revision,
  })
  const authority = rustyManagementAuthorityRevision(managementBinding(server, boardId), profile, "publication.stage-file", capability)
  const currentAuthority = async () => { await ensureCurrent?.(); return authority() }
  const challengeResult = await challenge(origin, boardId, profile, certificates, serviceId, serviceKey, capability, currentAuthority, sourceHeads)
  const challengePayload = challengeResult.payload
  if (sourceDocument) assertSourceAncestry(challengePayload, sourceDocument)
  if (challengePayload.expectedRevision !== expectedRevision) throw new Error("Publication changed while attachments were being staged; retry Update")
  const authorization = await signedCommand(challengePayload, origin, profile, "stage-file", asset.sha256, {
    byteLength: asset.bytes.byteLength, ...(capability ? { managementRevision: capability.payload.revision } : {}),
  }, currentAuthority, sourceHeads)
  await currentAuthority()
  const receipt = await readBlindJson<SignedEnvelope<Record<string, unknown>>>(await fetchBlind(`${origin}/v1/public/boards/${encodeURIComponent(boardId)}/files`, {
    method: "PUT", signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: challengeResult.envelope, identity: profile.identity, deviceId: profile.device.deviceId, certificates,
      sha256: asset.sha256, byteLength: asset.bytes.byteLength, bytes: toBase64Url(asset.bytes), authorization,
      ...(sourceHeads?.length ? { sourceHeads } : {}),
      ...(capability ? { managementCapability: capability } : {}) }),
  }), 16384)
  await currentAuthority()
  if (!assetReceiptMatches(receipt.payload, serviceId, boardId, asset)) throw new Error("Keeper asset receipt does not cover the staged file")
  const authorizationHash = await sha256Base64Url(encoder.encode(canonicalizeJson(authorization)))
  if (receipt.payload.challengeId !== challengePayload.challengeId || receipt.payload.authorizationHash !== authorizationHash || receipt.signerKeyId !== serviceId ||
      !await verifyEnvelope(receipt as SignedEnvelope<{ kind: string }>, serviceKey, "RUSTY/2")) throw new Error("Keeper asset receipt signature or challenge is invalid")
}
function assetReceiptMatches(payload: Record<string, unknown>, serviceId: string, boardId: string, asset: { sha256: string; bytes: Uint8Array }): boolean {
  return payload.kind === "rusty-public-asset-receipt" && payload.version === 1 && payload.serviceId === serviceId && payload.boardId === boardId &&
    payload.sha256 === asset.sha256 && payload.byteLength === asset.bytes.byteLength
}
export async function publishBoardSnapshot(input: { origin: string; boardId: string; workspaceId: string; document: WorkspaceDocumentV2; profile: LocalProfile; action: "publish" | "update"; expectedRevision: number; ensureCurrent?: () => void | Promise<void>; deliveryPolicy?: PublicBoardDeliveryPolicyEvidence }): Promise<{ revision: number; url: string; hash: string }> {
  const ensureCurrent = input.ensureCurrent
  // Capture authority metadata independently; limit document copying to the selected board tree.
  const snapshot = { origin: input.origin, boardId: input.boardId, workspaceId: input.workspaceId,
    profile: structuredClone(input.profile), action: input.action, expectedRevision: input.expectedRevision,
    deliveryPolicy: input.deliveryPolicy ? structuredClone(input.deliveryPolicy) : undefined }
  await ensureCurrent?.()
  const document = snapshotPublicBoardSource(input.document, snapshot.boardId)
  const sourceHeads = documentHeads(input.document)
  const profile = snapshot.profile
  if (snapshot.deliveryPolicy && (snapshot.deliveryPolicy.policy.payload.workspaceId !== snapshot.workspaceId ||
      snapshot.deliveryPolicy.policy.payload.boardId !== snapshot.boardId || snapshot.deliveryPolicy.policy.payload.enabled !== true)) {
    throw new Error("Public delivery policy does not cover the selected board")
  }
  const server = await service(snapshot.origin)
  await ensureCurrent?.()
  if (!server.presentation) throw new Error("Upgrade Rusty to publish the shared visitor presentation")
  const operation = snapshot.action === "publish" ? "publication.publish" : "publication.update"
  const capability = await managementAuthority(server, snapshot.boardId, profile, operation)
  const certificates = await controllerCertificates(profile)
  const publication = await createPublicBoardPublication(document, snapshot.workspaceId, snapshot.boardId,
    asset => stageAsset(server, snapshot.boardId, profile, certificates, snapshot.expectedRevision, asset, capability, ensureCurrent, sourceHeads, input.document))
  if (!server.fieldConfiguration && (publication.projection.board.presentation?.cardPresentation || publication.projection.fields.some(field => field.format))) {
    throw new Error("Upgrade Rusty to publish configured card fields and text formats")
  }
  await ensureCurrent?.()
  return commit(server, snapshot.boardId, profile, certificates, snapshot.action, publication.projection, snapshot.expectedRevision, capability, ensureCurrent, snapshot.deliveryPolicy, sourceHeads, input.document)
}
export async function withdrawPublicBoard(input: { origin: string; boardId: string; profile: LocalProfile; expectedRevision: number; ensureCurrent?: () => void | Promise<void> }): Promise<{ revision: number; url: string }> {
  const ensureCurrent = input.ensureCurrent
  const snapshot = structuredClone({ ...input, ensureCurrent: undefined })
  await ensureCurrent?.()
  const profile = snapshot.profile
  const server = await service(snapshot.origin)
  await ensureCurrent?.()
  const capability = await managementAuthority(server, snapshot.boardId, profile, "publication.unpublish")
  const certificates = await controllerCertificates(profile)
  return commit(server, snapshot.boardId, profile, certificates, "unpublish", null, snapshot.expectedRevision, capability, ensureCurrent)
}
export async function readPublicBoardManagementState(input: { origin: string; boardId: string; profile: LocalProfile; ensureCurrent?: () => void | Promise<void> }): Promise<{ revision: number; published: boolean; projection?: PublicBoardProjection; hash?: string; deliveryGeneration?: number | null; deliveryPolicyHash?: string | null; deliveryPolicyContentHash?: string | null }> {
  const ensureCurrent = input.ensureCurrent
  const snapshot = structuredClone({ ...input, ensureCurrent: undefined })
  await ensureCurrent?.()
  const profile = snapshot.profile
  const server = await service(snapshot.origin)
  await ensureCurrent?.()
  const { origin, serviceId, serviceKey } = server
  const capability = await managementAuthority(server, snapshot.boardId, profile, "publication.status")
  const certificates = await controllerCertificates(profile)
  const authority = rustyManagementAuthorityRevision(managementBinding(server, snapshot.boardId), profile, "publication.status", capability)
  const currentAuthority = async () => { await ensureCurrent?.(); return authority() }
  const controllerStatus = await challenge(origin, snapshot.boardId, profile, certificates, serviceId, serviceKey, capability, currentAuthority)
  const challengePayload = controllerStatus.payload
  await currentAuthority()
  const response = await fetchBlind(`${origin}/v1/public/boards/${encodeURIComponent(snapshot.boardId)}`, { cache: "no-store" })
  if (response.status === 404) {
    if (challengePayload.expectedRevision > 0 && !challengePayload.withdrawn || challengePayload.expectedRevision === 0 && challengePayload.withdrawn) throw new Error("Keeper publication status does not match its public snapshot")
    return { revision: challengePayload.expectedRevision, published: false, hash: challengePayload.projectionHash,
      deliveryGeneration: challengePayload.deliveryGeneration, deliveryPolicyHash: challengePayload.deliveryPolicyHash, deliveryPolicyContentHash: challengePayload.deliveryPolicyContentHash }
  }
  const envelope = await readBlindJson<{ boardId: string; revision: number; projection: unknown; hash: string }>(response, 3 * 1024 * 1024)
  const projection = (await import("./publicSchema")).validatePublicBoardProjection(envelope.projection)
  if (!await validManagementSnapshot(envelope, snapshot.boardId, challengePayload, projection)) throw new Error("Keeper publication integrity check failed")
  return { revision: envelope.revision, published: true, projection, hash: envelope.hash,
    deliveryGeneration: challengePayload.deliveryGeneration, deliveryPolicyHash: challengePayload.deliveryPolicyHash, deliveryPolicyContentHash: challengePayload.deliveryPolicyContentHash }
}
async function validManagementSnapshot(envelope: { boardId: string; revision: number; hash: string }, boardId: string,
  challengePayload: Challenge, projection: PublicBoardProjection): Promise<boolean> {
  if (envelope.boardId !== boardId || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1 || challengePayload.withdrawn ||
      envelope.revision !== challengePayload.expectedRevision || envelope.hash !== challengePayload.projectionHash || projection.board.id !== boardId) return false
  return await sha256Base64Url(encoder.encode(canonicalizeJson(projection))) === envelope.hash
}
export async function hasLocalPublicBoardChanges(input: { document: WorkspaceDocumentV2; workspaceId: string; boardId: string; hash: string }): Promise<boolean> {
  const document = snapshotPublicBoardSource(input.document, input.boardId)
  const publication = await createPublicBoardPublication(document, input.workspaceId, input.boardId, async () => {})
  return await sha256Base64Url(encoder.encode(canonicalizeJson(publication.projection))) !== input.hash
}
async function commit(server: PublicationService, boardId: string, profile: LocalProfile, certificates: DeviceCertificate[],
  action: "publish" | "update" | "unpublish", projection: PublicBoardProjection | null, expectedRevision: number,
  capability?: SignedEnvelope<RustyManagementCapability>, ensureCurrent?: () => void | Promise<void>, deliveryPolicy?: PublicBoardDeliveryPolicyEvidence,
  sourceHeads?: string[], sourceDocument?: WorkspaceDocumentV2) {
  const { origin, serviceId, serviceKey } = server
  const operation = `publication.${action}`
  const authority = rustyManagementAuthorityRevision(managementBinding(server, boardId), profile, operation, capability)
  const currentAuthority = async () => { await ensureCurrent?.(); return authority() }
  const challengeResult = await challenge(origin, boardId, profile, certificates, serviceId, serviceKey, capability, currentAuthority, sourceHeads)
  const challengePayload = challengeResult.payload
  if (challengePayload.expectedRevision !== expectedRevision) throw new Error("Publication revision changed; reload its current status")
  if (sourceDocument) assertSourceAncestry(challengePayload, sourceDocument)
  if (deliveryPolicy && !validPolicyGeneration(deliveryPolicy, action, boardId, challengePayload.deliveryGeneration)) {
    throw new Error("Public delivery policy generation changed; reload its current status")
  }
  const projectionHash = await sha256Base64Url(encoder.encode(projection ? canonicalizeJson(projection) : "null"))
  const authorization = await signedCommand(challengePayload, origin, profile, action, projectionHash,
    capability ? { managementRevision: capability.payload.revision } : {}, currentAuthority, sourceHeads, deliveryPolicy)
  await currentAuthority()
  const receipt = await readBlindJson<Receipt>(await fetchBlind(`${origin}/v1/public/boards/${encodeURIComponent(boardId)}`, {
    method: "PUT", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: challengeResult.envelope, identity: profile.identity, deviceId: profile.device.deviceId, certificates, action, projection,
      authorization, ...(sourceHeads?.length ? { sourceHeads } : {}), ...(capability ? { managementCapability: capability } : {}), ...(deliveryPolicy ? { deliveryPolicy } : {}) }),
  }), 16384)
  await currentAuthority()
  const payload = receipt.payload
  const authorizationHash = await sha256Base64Url(encoder.encode(canonicalizeJson(authorization)))
  if (!publicationReceiptMatches(payload, { serviceId, boardId, personId: profile.identity.personId, expectedRevision, action, projectionHash, challengeId: challengePayload.challengeId, authorizationHash })) throw new Error("Keeper publication receipt does not cover this snapshot")
  if (receipt.signerKeyId !== serviceId || !await verifyEnvelope(receipt, serviceKey, "RUSTY/2")) throw new Error("Keeper publication receipt signature is invalid")
  return { revision: payload.revision, url: `${window.location.origin}/boards/${encodeURIComponent(boardId)}`, hash: projectionHash }
}
function validPolicyGeneration(policy: PublicBoardDeliveryPolicyEvidence, action: string, boardId: string, generation?: number | null) {
  return action !== "unpublish" && policy.policy.payload.boardId === boardId && policy.policy.payload.generation === (generation ?? 0) + 1
}
function assertSourceAncestry(payload: Challenge, document: WorkspaceDocumentV2) {
  const heads = payload.currentSourceHeads ?? []
  if (!Array.isArray(heads) || heads.some(head => typeof head !== "string")) {
    throw new Error("Synchronize board before changing public access")
  }
  // The archive-aware catalog helper accepts retained lineage as well as the active Automerge frontier.
  if (documentHeads(document).length && !includesWorkspaceHeads(document, heads)) throw new Error("Synchronize board before changing public access")
}
function documentHeads(document: WorkspaceDocumentV2): string[] {
  try { return Automerge.getHeads(document).sort() } catch { return [] }
}
function publicationReceiptMatches(payload: Receipt["payload"], expected: { serviceId: string; boardId: string; personId: string; expectedRevision: number; action: string; projectionHash: string; challengeId: string; authorizationHash: string }): boolean {
  return payload.kind === "rusty-publication-receipt" && payload.version === 1 && payload.serviceId === expected.serviceId && payload.boardId === expected.boardId &&
    payload.controllerPersonId === expected.personId && payload.revision === expected.expectedRevision + 1 && payload.action === expected.action &&
    payload.projectionHash === expected.projectionHash && payload.challengeId === expected.challengeId && payload.authorizationHash === expected.authorizationHash &&
    payload.withdrawn === (expected.action === "unpublish")
}
