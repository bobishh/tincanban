import { bootstrapIdentity, canonicalizeJson, sha256Base64Url } from "../domain/identity"
import type { KeeperDiscovery } from "./keeperDiscovery"
import { requestKeeperJson, signKeeperControllerRequest, verifyKeeperServiceEnvelope } from "./keeperPairing"
import type { KeeperSettingsReceipt, KeeperSettingsScope } from "./keeperIntegrationStatus"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function signedSettingsRequest(discovery: KeeperDiscovery, integrationId: string,
  expectedRevision: number, operationId: string, scopes: KeeperSettingsScope[], futureBoards: boolean) {
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, discovery, "keeper-integration-settings", {
    integrationId, operationId, controllerPersonId: profile.identity.personId,
    controllerDeviceId: profile.device.deviceId, servicePersonId: discovery.personId,
    serviceDeviceId: discovery.deviceId, serviceOrigin: discovery.origin, expectedRevision,
    policy: { futureBoards }, scopes: scopes.map(scope => ({ ...scope })),
  })
  const semantic = { ...(signed.signed.payload as Record<string, unknown>) }
  delete semantic.controllerDeviceId
  delete semantic.issuedAt
  delete semantic.expiresAt
  const requestHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(semantic)))
  return { profile, signed, requestHash }
}

function parseReceiptScopes(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.scopes)) throw new Error("Rusty returned malformed keeper settings scopes.")
  return payload.scopes.map(raw => {
    const scope = record(raw)
    if (!scope || typeof scope.workspaceId !== "string" || !Number.isSafeInteger(scope.grantEpoch)
      || !["removed", "pending"].includes(String(scope.state))
      || !["complete", "pending"].includes(String(scope.cleanup))) {
      throw new Error("Rusty returned malformed keeper settings scope state.")
    }
    return { workspaceId: scope.workspaceId, grantEpoch: scope.grantEpoch as number,
      state: scope.state as "removed" | "pending", cleanup: scope.cleanup as "complete" | "pending" }
  })
}

function validateReceipt(payload: Record<string, unknown>, integrationId: string, operationId: string,
  requestHash: string, expectedRequestHash: string | undefined,
  profilePersonId: string, deviceId: string, scopes: KeeperSettingsScope[], futureBoards: boolean): KeeperSettingsReceipt {
  if (expectedRequestHash && expectedRequestHash !== requestHash) throw new Error("Pending keeper settings differ from saved intent.")
  assertReceiptHeader(payload, { integrationId, operationId, requestHash, profilePersonId, deviceId, futureBoards })
  const receiptScopes = parseReceiptScopes(payload)
  assertReceiptScopeDelta(scopes, receiptScopes)
  if (payload.status === "updated" && receiptScopes.some(scope => scope.state !== "removed" || scope.cleanup !== "complete")) {
    throw new Error("Rusty confirmed keeper settings before cleanup completed.")
  }
  const rawBaseline = record(payload.policy)?.baselineWorkspaceIds
  const baseline = Array.isArray(rawBaseline) ? rawBaseline : []
  if (baseline.some(id => typeof id !== "string")) throw new Error("Rusty returned malformed keeper settings baseline.")
  return { integrationId, operationId, requestHash, revision: payload.revision as number,
    status: payload.status as "updated" | "pending", futureBoards,
    baselineWorkspaceIds: baseline as string[], scopes: receiptScopes }
}

function assertReceiptHeader(payload: Record<string, unknown>, expected: {
  integrationId: string; operationId: string; requestHash: string; profilePersonId: string; deviceId: string; futureBoards: boolean
}) {
  if (payload.version !== 1 || payload.integrationId !== expected.integrationId || payload.operationId !== expected.operationId
    || payload.requestHash !== expected.requestHash || payload.controllerPersonId !== expected.profilePersonId
    || payload.controllerDeviceId !== expected.deviceId || !Number.isSafeInteger(payload.revision)
    || !["updated", "pending"].includes(String(payload.status)) || record(payload.policy)?.futureBoards !== expected.futureBoards) {
    throw new Error("Rusty returned a receipt for different keeper settings.")
  }
}

function assertReceiptScopeDelta(requestedScopes: KeeperSettingsScope[], receiptScopes: ReturnType<typeof parseReceiptScopes>) {
  const requested = [...requestedScopes].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
  const received = [...receiptScopes].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
  if (requested.length !== received.length || requested.some((scope, index) => scope.workspaceId !== received[index]?.workspaceId
    || scope.expectedGrantEpoch !== received[index]?.grantEpoch)) {
    throw new Error("Rusty settings receipt does not match exact requested boards.")
  }
}

export async function updateKeeperIntegrationSettings(discovery: KeeperDiscovery, integrationId: string,
  expectedRevision: number, operationId: string, scopes: KeeperSettingsScope[], futureBoards: boolean,
  expectedRequestHash?: string): Promise<KeeperSettingsReceipt> {
  if (!integrationId || !operationId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || new Set(scopes.map(scope => scope.workspaceId)).size !== scopes.length
    || scopes.some(scope => !scope.workspaceId || !Number.isSafeInteger(scope.expectedGrantEpoch) || scope.expectedGrantEpoch < 1)) {
    throw new Error("Keeper settings request is invalid.")
  }
  const request = await signedSettingsRequest(discovery, integrationId, expectedRevision, operationId, scopes, futureBoards)
  const response = await requestKeeperJson<unknown>(`${discovery.origin}/v1/integrations/${encodeURIComponent(integrationId)}/settings`, {
    method: "POST", body: JSON.stringify(request.signed),
  })
  const payload = await verifyKeeperServiceEnvelope(discovery, response, "keeper-integration-settings-receipt")
  return validateReceipt(payload, integrationId, operationId, request.requestHash, expectedRequestHash,
    request.profile.identity.personId, request.profile.device.deviceId, scopes, futureBoards)
}

export async function keeperIntegrationSettingsRequestHash(discovery: KeeperDiscovery, integrationId: string,
  expectedRevision: number, operationId: string, scopes: KeeperSettingsScope[], futureBoards: boolean) {
  return (await signedSettingsRequest(discovery, integrationId, expectedRevision, operationId, scopes, futureBoards)).requestHash
}
