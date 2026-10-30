import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, canonicalizeJson, sha256Base64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { signingEvidence, signWithContext } from "../domain/signingContext"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { peerStore } from "./peerStore"
import type { DeviceCertificate } from "../domain/model"
import type { KeeperIntegrationReference } from "../domain/model"
import type { KeeperWorkspace, KeeperDiscovery } from "./keeperDiscovery"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { rememberActivatedKeeper, saveKeeperIntegrationReference } from "./ownerKeeper"
import { parseKeeperIntegrationStatus, type KeeperDisconnectReceipt, type KeeperDisconnectScope,
  assertKeeperGrantFloorRefreshAllowed, keeperIntegrationSettingsSupported, type KeeperIntegrationStatus } from "./keeperIntegrationStatus"
import { keeperServiceGrantFloors } from "./keeperGrantEpoch"
import { KeeperHttpError } from "./keeperHttpError"
import { assertOwnerOriginAdmission, ownerOriginForDiscovery } from "./keeperOriginAdmission"
import { validateKeeperPairingChallenge } from "./keeperPairingChallenge"
import { canonicalKeeperIntegrationId, selectCanonicalServiceIntegration } from "./keeperIntegrationSelection"
export type { KeeperDisconnectReceipt, KeeperDisconnectScope, KeeperIntegrationStatus } from "./keeperIntegrationStatus"
export type { KeeperSettingsReceipt, KeeperSettingsScope } from "./keeperIntegrationStatus"

const CONTROL_DOMAIN = "MESH-LIGHTHOUSE/1"

export type KeeperPairing = {
  pairingId: string
  integrationId: string
  operatorUrl: string
  comparisonCode: string
  expiresAt: number
  transcriptHash: string
  controllerOrigin?: string
  challengeNonce: string
  controllerFingerprint: string
  discovery: KeeperDiscovery
  integrationSettingsSupported?: boolean
  workspaces: KeeperWorkspace[]
  serviceGrantFloors?: Record<string, number>
  futureBoards?: boolean
  futureBoardBaselineIds?: string[]
  expectedIntegrationRevision?: number
  integrationUpdate?: { integrationId: string; expectedRevision: number; scopeWorkspaceIds: string[]; policy: { futureBoards: boolean; baselineWorkspaceIds: string[] }; policyOnly?: boolean }
}

export type KeeperPairingStatus = "pending" | "approved" | "provisioning" | "active" | "rejected" | "expired" | "cancel_pending" | "cancelled"
export type KeeperPairingWithdrawal = { operationId: string; requestHash: string; status: "cancel_pending" | "cancelled" }
export type KeeperProvisionedScope = { workspaceId: string; status: "pending" | "active"; grantEpoch?: number; error?: "join_failed" | "runtime_unavailable" }
export type KeeperPairingStatusInfo = { status: KeeperPairingStatus; withdrawal?: KeeperPairingWithdrawal; provisioningScopes?: KeeperProvisionedScope[] }
export type KeeperWithdrawalScopeProof = { workspaceId: string; document: string; authorizationBundle: unknown }
export type KeeperWithdrawalGrantProof = KeeperWithdrawalScopeProof & { grant: unknown }
const provisionRequests = new WeakMap<KeeperPairing, string>()

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function operationId(): string { return base64Url(crypto.getRandomValues(new Uint8Array(16))) }
export function newKeeperOperationId(): string { return operationId() }
function unixSeconds(): number { return Math.floor(Date.now() / 1000) }

function checkedRequestBody(payload: Record<string, unknown>) {
  const now = unixSeconds()
  const issuedAt = payload.issuedAt ?? now
  const expiresAt = payload.expiresAt ?? (now + 600)
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || (expiresAt as number) <= (issuedAt as number)
    || (expiresAt as number) > (issuedAt as number) + 600) {
    throw new Error("Controller request timestamps are invalid.")
  }
  return { ...payload, operationId: payload.operationId ?? operationId(), issuedAt, expiresAt }
}

async function publicKeyFingerprint(publicKey: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKey)))
  return [...bytes].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g)?.join(":") ?? "unavailable"
}

export async function getEligibleKeeperWorkspaces(workspaces: KeeperWorkspace[]): Promise<KeeperWorkspace[]> {
  const profile = await bootstrapIdentity()
  const checked = await Promise.all(workspaces.map(async workspace => {
    const authority = await peerStore.getWorkspaceAuthority(workspace.id) ?? await peerStore.getWorkspaceCredential(workspace.id)
    const snapshot = (authority as { scopeAuthoritySnapshot?: { genesis?: unknown } } | null)?.scopeAuthoritySnapshot
    if (!authority || !snapshot?.genesis) return false
    try {
      const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as { scopeId: string; controller: { personId: string; publicKey: string } }
      return validated.scopeId === workspace.id && validated.controller.personId === profile.identity.personId && validated.controller.publicKey === authority.ownerPublicKey && authority.ownerPersonId === profile.identity.personId
    } catch { return false }
  }))
  return workspaces.filter((_, index) => checked[index])
}

export async function signKeeperControllerRequest(profile: LocalProfile, discovery: KeeperDiscovery, kind: string, body: Record<string, unknown>) {
  const requestProfile = structuredClone(profile)
  const requestDiscovery = structuredClone(discovery)
  const requestBody = structuredClone(body)
  const payload = {
    ...checkedRequestBody(requestBody),
    kind,
    version: 1,
    protocolVersion: 1,
    servicePersonId: requestDiscovery.personId,
    serviceOrigin: requestDiscovery.origin,
    controllerPersonId: requestProfile.identity.personId,
    controllerDeviceId: requestProfile.device.deviceId,
  }
  const expiresAtMs = Number(payload.expiresAt) * 1000
  if (!Number.isSafeInteger(expiresAtMs) || typeof payload.operationId !== "string" || !payload.operationId) {
    throw new Error("Controller request timestamps are invalid.")
  }
  const binding = {
    servicePersonId: requestDiscovery.personId, serviceOrigin: requestDiscovery.origin,
    controllerPersonId: requestProfile.identity.personId, controllerDeviceId: requestProfile.device.deviceId,
    operationId: payload.operationId, issuedAt: Number(payload.issuedAt), expiresAt: Number(payload.expiresAt),
  }
  const context = await resolveLocalSigningContext(requestProfile, kind, binding,
    { domain: CONTROL_DOMAIN, expiresAt: expiresAtMs })
  const evidence = signingEvidence(context)
  return {
    identity: evidence.identity,
    deviceId: context.deviceId,
    certificates: evidence.certificates,
    signed: await signWithContext(context, payload),
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json", ...init.headers } })
  const body = await response.json().catch(() => null) as { message?: string } | null
  if (!response.ok) {
    if (response.status === 503 && new URL(url).pathname === "/v1/integrations/status") {
      throw new Error("Rusty could not verify its saved board access (HTTP 503). Local access can still be revoked; Rusty confirmation remains pending.")
    }
    throw new KeeperHttpError(response.status, url, body?.message || `Keeper pairing failed (${response.status}).`)
  }
  if (!body) throw new Error("Keeper returned an invalid pairing response.")
  return body as T
}

export { request as requestKeeperJson }

export async function verifyKeeperServiceEnvelope(discovery: KeeperDiscovery, envelope: unknown, expectedKind: string) {
  if (!envelope || typeof envelope !== "object") throw new Error("Keeper returned an invalid signed challenge.")
  const signed = envelope as { payload?: Record<string, unknown>; signerKeyId?: string; signature?: string }
  if (!signed.payload || typeof signed.signerKeyId !== "string" || typeof signed.signature !== "string" || signed.signerKeyId !== discovery.deviceId || signed.payload.kind !== expectedKind) {
    throw new Error("Keeper signed challenge does not match advertised device.")
  }
  const identity = { personId: discovery.personId, publicKey: discovery.publicKey, displayName: discovery.displayName }
  const certificates = discovery.certificates as DeviceCertificate[]
  const key = await verifyDeviceCertificateChain(identity, discovery.deviceId, certificates)
  if (!await verifyEnvelope(signed as never, key, CONTROL_DOMAIN)) throw new Error("Keeper challenge signature is invalid.")
  return signed.payload
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export async function getKeeperIntegrationStatus(discovery: KeeperDiscovery) {
  const profile = await bootstrapIdentity()
  const signedRequest = await signKeeperControllerRequest(profile, discovery, "keeper-integration-status-request", {
    controllerPersonId: profile.identity.personId,
    controllerDeviceId: profile.device.deviceId,
    servicePersonId: discovery.personId,
    serviceDeviceId: discovery.deviceId,
    serviceOrigin: discovery.origin,
  })
  const envelope = await request<unknown>(`${discovery.origin}/v1/integrations/status`, {
    method: "POST", body: JSON.stringify(signedRequest),
  })
  const payload = await verifyKeeperServiceEnvelope(discovery, envelope, "keeper-integration-status")
  const requestPayload = signedRequest.signed.payload as Record<string, unknown>
  if (payload.operationId !== requestPayload.operationId || payload.controllerPersonId !== profile.identity.personId
    || payload.controllerDeviceId !== profile.device.deviceId) {
    throw new Error("Rusty status does not match this controller request.")
  }
  const integrations = parseKeeperIntegrationStatus(payload, discovery)
  const signedEnvelope = envelope as { signerKeyId: string; signature: string }
  return { integrations, integrationSettingsSupported: keeperIntegrationSettingsSupported(payload),
    signerKeyId: signedEnvelope.signerKeyId, signature: signedEnvelope.signature, revision: payload.revision as number,
    signedStatus: JSON.parse(JSON.stringify({ payload, signerKeyId: signedEnvelope.signerKeyId,
      signature: signedEnvelope.signature })) as { payload: Record<string, unknown>; signerKeyId: string; signature: string } }
}

export async function refreshKeeperGrantFloors(discovery: KeeperDiscovery, workspaceIds: string[], previous: Record<string, number> = {},
  excludeActiveIntegrationId?: string) {
  const { integrations } = await getKeeperIntegrationStatus(discovery)
  assertKeeperGrantFloorRefreshAllowed(integrations, workspaceIds, excludeActiveIntegrationId)
  const current = keeperServiceGrantFloors(integrations, workspaceIds, excludeActiveIntegrationId)
  return Object.fromEntries(workspaceIds.map(workspaceId => [workspaceId,
    Math.max(previous[workspaceId] ?? 0, current[workspaceId] ?? 0)]))
}

export async function rememberActiveKeeperIntegration(pairing: KeeperPairing) {
  const status = await getKeeperIntegrationStatus(pairing.discovery)
  const { integrations } = status
  const integration = integrations.find(candidate => candidate.integrationId === pairing.integrationId)
  const approvedBaseline = [...(pairing.futureBoardBaselineIds ?? [])].sort()
  const confirmedBaseline = [...(integration?.baselineWorkspaceIds ?? [])].sort()
  if (!integration
    || pairing.workspaces.some(workspace => !integration.scopes.some(scope => scope.workspaceId === workspace.id))
    || (pairing.expectedIntegrationRevision !== undefined && integration.revision <= pairing.expectedIntegrationRevision)
    || !integration.baselineWorkspaceIds || JSON.stringify(confirmedBaseline) !== JSON.stringify(approvedBaseline)
    || integration.futureBoards !== (pairing.futureBoards === true)) {
    throw new Error("Rusty has not confirmed every approved board as active.")
  }
  const profile = await bootstrapIdentity()
  const serviceCertificates = JSON.parse(JSON.stringify(pairing.discovery.certificates)) as DeviceCertificate[]
  const descriptor: KeeperIntegrationReference = {
    integrationId: integration.integrationId,
    serviceOrigin: pairing.discovery.origin,
    servicePersonId: pairing.discovery.personId,
    serviceDeviceId: pairing.discovery.deviceId,
    servicePublicKey: pairing.discovery.publicKey,
    serviceCertificates,
    workspaceIds: integration.scopes.map(scope => scope.workspaceId),
    scopeReceipts: integration.scopes.map(scope => ({ workspaceId: scope.workspaceId,
      grantEpoch: scope.grantEpoch, activationOperationId: scope.activationOperationId })),
    futureBoards: integration.futureBoards,
    integrationSettingsSupported: status.integrationSettingsSupported,
    futureBoardBaselineIds: integration.baselineWorkspaceIds,
    revision: integration.revision,
    state: "active",
    verifiedAt: new Date().toISOString(),
  }
  await saveKeeperIntegrationReference(descriptor)
  await rememberActivatedKeeper(profile.identity.personId, pairing.discovery.personId, {
    origin: pairing.discovery.origin,
    boardIds: descriptor.workspaceIds,
    futureBoards: descriptor.futureBoards,
    futureBoardBaselineIds: descriptor.futureBoardBaselineIds,
    integrationId: descriptor.integrationId,
    servicePersonId: descriptor.servicePersonId,
    serviceDeviceId: descriptor.serviceDeviceId,
    servicePublicKey: descriptor.servicePublicKey,
    serviceCertificates: descriptor.serviceCertificates,
    revision: descriptor.revision,
  })
  return descriptor
}

function validateDisconnectRequest(integrationId: string, expectedRevision: number, operationId: string, scopes: KeeperDisconnectScope[]) {
  const workspaceIds = scopes.map(scope => scope.workspaceId)
  if (!integrationId || !operationId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !scopes.length || new Set(workspaceIds).size !== workspaceIds.length
    || scopes.some(scope => !scope.workspaceId || !Number.isSafeInteger(scope.expectedGrantEpoch) || scope.expectedGrantEpoch < 1)) {
    throw new Error("Keeper removal request is invalid.")
  }
}

async function disconnectRequestHash(payload: Record<string, unknown>) {
  const semanticPayload = { ...payload }
  delete semanticPayload.controllerDeviceId
  delete semanticPayload.issuedAt
  delete semanticPayload.expiresAt
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(semanticPayload)))
}

function validDisconnectReceiptHeader(payload: Record<string, unknown>, discovery: KeeperDiscovery, profile: LocalProfile,
  integrationId: string, operationId: string, requestHash: string): boolean {
  return payload.version === 1 && payload.integrationId === integrationId && payload.operationId === operationId
    && ["removed", "pending"].includes(String(payload.status)) && Number.isSafeInteger(payload.revision)
    && payload.requestHash === requestHash && payload.controllerPersonId === profile.identity.personId
    && payload.servicePersonId === discovery.personId && payload.serviceDeviceId === discovery.deviceId
    && payload.serviceOrigin === discovery.origin && Array.isArray(payload.scopes)
}

function parseDisconnectScopes(receiptScopes: unknown[]): KeeperDisconnectReceipt["scopes"] {
  return receiptScopes.map(raw => {
    const scope = record(raw)
    if (typeof scope?.workspaceId !== "string" || !Number.isSafeInteger(scope.grantEpoch)
      || (scope.grantEpoch as number) < 1 || !["removed", "pending"].includes(String(scope.state))
      || !["complete", "pending"].includes(String(scope.cleanup))) {
      throw new Error("Rusty removal receipt has a malformed scope.")
    }
    return { workspaceId: scope.workspaceId, grantEpoch: scope.grantEpoch as number,
      state: scope.state as "removed" | "pending", cleanup: scope.cleanup as "complete" | "pending" }
  })
}

function assertExactReceiptScopes(parsedScopes: KeeperDisconnectReceipt["scopes"], requestedScopes: KeeperDisconnectScope[]) {
  const requestedIds = requestedScopes.map(scope => scope.workspaceId).sort()
  const receiptIds = parsedScopes.map(scope => scope.workspaceId).sort()
  if (new Set(receiptIds).size !== requestedScopes.length || receiptIds.length !== requestedScopes.length
    || receiptIds.join("\0") !== requestedIds.join("\0")) {
    throw new Error("Rusty removal receipt does not cover the exact requested boards.")
  }
  if (parsedScopes.some(received => requestedScopes.find(requested => requested.workspaceId === received.workspaceId)?.expectedGrantEpoch !== received.grantEpoch)) {
    throw new Error("Rusty removal receipt references another grant generation.")
  }
}

function parseDisconnectReceipt(payload: Record<string, unknown>, discovery: KeeperDiscovery, profile: LocalProfile,
  integrationId: string, operationId: string, scopes: KeeperDisconnectScope[], requestHash: string): KeeperDisconnectReceipt {
  if (!validDisconnectReceiptHeader(payload, discovery, profile, integrationId, operationId, requestHash)) {
    throw new Error("Rusty returned a receipt for a different keeper removal.")
  }
  const parsedScopes = parseDisconnectScopes(payload.scopes as unknown[])
  assertExactReceiptScopes(parsedScopes, scopes)
  if (payload.status === "removed" && parsedScopes.some(scope => scope.state !== "removed" || scope.cleanup !== "complete")) {
    throw new Error("Rusty reported removal before every selected board was cleaned up.")
  }
  return { integrationId, operationId, requestHash, revision: payload.revision as number,
    status: payload.status as "removed" | "pending", scopes: parsedScopes }
}

export async function disconnectKeeperIntegration(discovery: KeeperDiscovery, integrationId: string,
  expectedRevision: number, operationId: string, scopes: KeeperDisconnectScope[], expectedRequestHash?: string): Promise<KeeperDisconnectReceipt> {
  validateDisconnectRequest(integrationId, expectedRevision, operationId, scopes)
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, discovery, "keeper-integration-disconnect", {
    integrationId,
    operationId,
    controllerPersonId: profile.identity.personId,
    controllerDeviceId: profile.device.deviceId,
    servicePersonId: discovery.personId,
    serviceDeviceId: discovery.deviceId,
    serviceOrigin: discovery.origin,
    expectedRevision,
    scopes: scopes.map(scope => ({ ...scope })),
  })
  const requestPayload = signed.signed.payload as Record<string, unknown>
  const requestHash = await disconnectRequestHash(requestPayload)
  if (expectedRequestHash && expectedRequestHash !== requestHash) {
    throw new Error("Pending Rusty removal request differs from the persisted operation.")
  }
  const response = await request<unknown>(`${discovery.origin}/v1/integrations/${encodeURIComponent(integrationId)}/disconnect`, {
    method: "POST", body: JSON.stringify(signed),
  })
  const payload = await verifyKeeperServiceEnvelope(discovery, response, "keeper-integration-disconnect-receipt")
  return parseDisconnectReceipt(payload, discovery, profile, integrationId, operationId, scopes, requestHash)
}

async function keeperScope(workspace: KeeperWorkspace, profile: LocalProfile) {
  const authority = await peerStore.getWorkspaceAuthority(workspace.id) ?? await peerStore.getWorkspaceCredential(workspace.id)
  const snapshot = (authority as { scopeAuthoritySnapshot?: { genesis?: unknown } } | null)?.scopeAuthoritySnapshot
  if (!authority || !snapshot?.genesis || authority.ownerPersonId !== profile.identity.personId) {
    throw new Error(`Owner proof unavailable for ${workspace.title}. Reopen Sync on that board and retry.`)
  }
  const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as { scopeId: string; controller: { personId: string; publicKey: string } }
  if (validated.scopeId !== workspace.id || validated.controller.personId !== profile.identity.personId
    || validated.controller.publicKey !== authority.ownerPublicKey) {
    throw new Error(`Owner proof unavailable for ${workspace.title}. Reopen Sync on that board and retry.`)
  }
  return { workspaceId: workspace.id, title: workspace.title, genesisAnchor: canonicalizeJson(snapshot.genesis), mode: "replicate" }
}

export function verifyProvisionedScopes(payload: Record<string, unknown>, pairing: KeeperPairing, allowPendingFailure = false): KeeperProvisionedScope[] {
  const provisioned = payload.provisioning as { scopes?: unknown } | undefined
  if (!provisioned || !Array.isArray(provisioned.scopes)) throw new Error("Keeper omitted durable per-board provisioning state.")
  const expected = pairing.workspaces.map(workspace => workspace.id)
  const actual = provisioned.scopes as { workspaceId?: unknown; status?: unknown; grantEpoch?: unknown; error?: unknown; errorDetail?: unknown }[]
  if (actual.length !== expected.length || actual.some((scope, index) => {
    const epochValid = scope.grantEpoch === undefined || (Number.isSafeInteger(scope.grantEpoch) && (scope.grantEpoch as number) > 0)
    return scope.workspaceId !== expected[index]
      || !["pending", "active"].includes(String(scope.status))
      || !epochValid
      || (scope.error !== undefined && scope.error !== null && !["join_failed", "runtime_unavailable"].includes(String(scope.error)))
  })) {
    throw new Error("Keeper provisioning state does not match the approved board set.")
  }
  if (payload.status === "active" && actual.some(scope => scope.status !== "active" || scope.error !== undefined)) {
    throw new Error("Keeper reported active before every approved board was committed.")
  }
  if (!allowPendingFailure && payload.status === "provisioning" && actual.some(scope => scope.error === "join_failed")) {
    const failed = actual.find(scope => scope.error === "join_failed")!
    const detail = typeof failed.errorDetail === "string" ? failed.errorDetail.slice(0, 1024) : "No error detail returned by Rusty"
    throw new Error(`Rusty could not join the selected boards: ${detail}. Keep this tab open and retry board setup.`)
  }
  if (!allowPendingFailure && payload.status === "provisioning" && actual.some(scope => scope.error === "runtime_unavailable")) {
    throw new Error("Rusty replication runtime is unavailable. Retry board setup after the service recovers.")
  }
  return actual.map(scope => ({ workspaceId: scope.workspaceId as string, status: scope.status as "pending" | "active",
    ...(scope.grantEpoch === undefined ? {} : { grantEpoch: scope.grantEpoch as number }),
    ...(scope.error === undefined || scope.error === null ? {} : { error: scope.error as KeeperProvisionedScope["error"] }) }))
}

type KeeperPairingOptions = {
  futureBoards: boolean
  futureBoardBaselineIds: string[]
  policyOnly?: boolean
}

function validatePairingBaseline(workspaces: KeeperWorkspace[], values: string[]) {
  const baselineIds = [...values].sort()
  if (baselineIds.length > 512 || new Set(baselineIds).size !== baselineIds.length || baselineIds.some(id => !id)
    || workspaces.some(workspace => !baselineIds.includes(workspace.id))) {
    throw new Error("Future-board baseline must include every selected owner board exactly once.")
  }
  return baselineIds
}

async function selectPairingIntegration(current: Awaited<ReturnType<typeof getKeeperIntegrationStatus>>,
  controllerPersonId: string, servicePersonId: string, workspaces: KeeperWorkspace[],
  options: KeeperPairingOptions, baselineIds: string[]) {
  const canonicalId = await canonicalKeeperIntegrationId(controllerPersonId, servicePersonId)
  const existing = selectCanonicalServiceIntegration(current.integrations, canonicalId)
  if (existing?.pendingOperation) throw new Error("Rusty has board cleanup pending. Finish it before requesting settings changes.")
  if (options.policyOnly) validatePolicyOnlySelection(current, existing, options, baselineIds)
  if (existing && workspaces.some(workspace => existing.scopes.some(scope => scope.workspaceId === workspace.id))) {
    throw new Error("Select only boards that are not already active for this keeper.")
  }
  return existing
}

function validatePolicyOnlySelection(current: Awaited<ReturnType<typeof getKeeperIntegrationStatus>>,
  existing: KeeperIntegrationStatus | undefined, options: KeeperPairingOptions, baselineIds: string[]) {
  if (!current.integrationSettingsSupported || !existing || existing.futureBoards || !options.futureBoards) {
    throw new Error("Policy-only approval requires an existing integration with future boards currently off.")
  }
  const known = new Set([...existing.scopes.map(scope => scope.workspaceId),
    ...existing.tombstones.map(scope => scope.workspaceId)])
  if ([...known].some(id => !baselineIds.includes(id))) {
    throw new Error("Future-board baseline must include every active and previously removed board.")
  }
}

function pairingIntegrationUpdate(existing: KeeperIntegrationStatus | undefined, workspaces: KeeperWorkspace[],
  options: KeeperPairingOptions, baselineIds: string[]) {
  if (!existing) return undefined
  return {
    integrationId: existing.integrationId, expectedRevision: existing.revision,
    scopeWorkspaceIds: workspaces.map(workspace => workspace.id).sort(),
    policy: { futureBoards: options.futureBoards, baselineWorkspaceIds: baselineIds },
    ...(options.policyOnly ? { policyOnly: true } : {}),
  }
}

export async function beginKeeperPairing(discovery: KeeperDiscovery, workspaces: KeeperWorkspace[],
  options: KeeperPairingOptions): Promise<KeeperPairing> {
  const profile = await bootstrapIdentity()
  if (!workspaces.length && options.policyOnly !== true) throw new Error("Choose at least one owner board.")
  const baselineIds = validatePairingBaseline(workspaces, options.futureBoardBaselineIds)
  const scopes = await Promise.all(workspaces.map(workspace => keeperScope(workspace, profile)))
  const serviceGrantFloors = await refreshKeeperGrantFloors(discovery, workspaces.map(workspace => workspace.id))
  const current = await getKeeperIntegrationStatus(discovery)
  const existing = await selectPairingIntegration(current, profile.identity.personId, discovery.personId,
    workspaces, options, baselineIds)
  const integrationUpdate = pairingIntegrationUpdate(existing, workspaces, options, baselineIds)
  const controllerOrigin = ownerOriginForDiscovery(discovery)
  const signedRequestBody = await signKeeperControllerRequest(profile, discovery, "keeper-pairing-offer", {
    body: { scopes, policy: { futureBoards: options.futureBoards, baselineWorkspaceIds: baselineIds },
      ...(integrationUpdate ? { integrationUpdate } : {}) },
    ...(controllerOrigin ? { controllerOrigin } : {}),
  })
  const transcriptHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(signedRequestBody.signed.payload)))
  const result = await request<{
    pairingId: string; expiresAt: number; operatorUrl: string; comparisonCode: string;
    transcriptHash: string; challenge: unknown
  }>(`${discovery.origin}/v1/pairings`, { method: "POST", body: JSON.stringify(signedRequestBody) })
  const challengeEnvelope = result.challenge as Record<string, unknown>
  await verifyKeeperServiceEnvelope(discovery, challengeEnvelope, "keeper-pairing-challenge")
  const verified = validateKeeperPairingChallenge({ pairingId: result.pairingId, transcriptHash: result.transcriptHash,
    expiresAt: result.expiresAt, comparisonCode: result.comparisonCode }, discovery,
  { ...challengeEnvelope, operatorUrl: result.operatorUrl }, transcriptHash)
  return { ...verified, comparisonCode: result.comparisonCode, expiresAt: result.expiresAt, transcriptHash,
    ...(controllerOrigin ? { controllerOrigin } : {}),
    controllerFingerprint: await publicKeyFingerprint(profile.identity.publicKey), discovery,
    integrationSettingsSupported: current.integrationSettingsSupported,
    workspaces: workspaces.map(workspace => ({ ...workspace })), futureBoards: options.futureBoards,
    futureBoardBaselineIds: baselineIds, expectedIntegrationRevision: existing?.revision,
    integrationUpdate, serviceGrantFloors }
}

export async function decideKeeperPairing(pairing: KeeperPairing, approve: boolean): Promise<void> {
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, pairing.discovery, "keeper-pairing-decision", {
    pairingId: pairing.pairingId,
    transcriptHash: pairing.transcriptHash,
    challengeNonce: pairing.challengeNonce,
    decision: approve ? "approve" : "decline",
  })
  await request(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/decision`, { method: "POST", body: JSON.stringify(signed) })
}

export async function deliverKeeperInvitation(pairing: KeeperPairing, invitation?: WorkspaceJoinInvitation): Promise<KeeperPairingStatus> {
  let body = provisionRequests.get(pairing)
  if (!body) {
    const policyOnly = pairing.integrationUpdate?.policyOnly === true
    if (policyOnly !== (pairing.workspaces.length === 0) || (policyOnly && invitation)) {
      throw new Error("Policy-only approval cannot include workspace invitations.")
    }
    const profile = await bootstrapIdentity()
    const approvedScopes = pairing.workspaces.map(workspace => ({ workspaceId: workspace.id, mode: "replicate" }))
    const signed = await signKeeperControllerRequest(profile, pairing.discovery, "keeper-pairing-provision", {
      body: {
        pairingId: pairing.pairingId,
        transcriptHash: pairing.transcriptHash,
        servicePersonId: pairing.discovery.personId,
        approvedScopes,
        futureBoards: pairing.futureBoards === true,
        baselineWorkspaceIds: pairing.futureBoardBaselineIds,
        ...(pairing.integrationUpdate ? { integrationUpdate: pairing.integrationUpdate } : {}),
        ...(policyOnly ? { policyOnly: true } : {}),
        ...(invitation ? { invitation } : {}),
      },
    })
    body = JSON.stringify(signed)
    provisionRequests.set(pairing, body)
  }
  const result = await request<unknown>(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/provision`, {
    method: "POST",
    body,
  })
  const payload = await verifyKeeperServiceEnvelope(pairing.discovery, result, "keeper-pairing-status")
  const profile = await bootstrapIdentity()
  if (payload.pairingId !== pairing.pairingId
    || payload.integrationId !== pairing.integrationId
    || payload.transcriptHash !== pairing.transcriptHash
    || payload.serviceOrigin !== pairing.discovery.origin
    || !["provisioning", "active"].includes(String(payload.status))) {
    throw new Error("Keeper returned a provisioning state for another pairing or scope set.")
  }
  if (["provisioning", "active"].includes(String(payload.status))) {
    assertOwnerOriginAdmission(payload, pairing, profile.identity.personId, profile.device.deviceId)
  }
  verifyProvisionedScopes(payload, pairing)
  return payload.status as KeeperPairingStatus
}
