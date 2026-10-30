import { bootstrapIdentity, canonicalizeJson, sha256Base64Url } from "../domain/identity"
import {
  requestKeeperJson,
  signKeeperControllerRequest,
  verifyKeeperServiceEnvelope,
  verifyProvisionedScopes,
  type KeeperPairing,
  type KeeperPairingStatus,
  type KeeperPairingStatusInfo,
  type KeeperPairingWithdrawal,
  type KeeperProvisionedScope,
  type KeeperWithdrawalGrantProof,
  type KeeperWithdrawalScopeProof,
} from "./keeperPairing"
import { assertOwnerOriginAdmission } from "./keeperOriginAdmission"

type SignedPayload = Record<string, unknown>

function asRecord(value: unknown): SignedPayload | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SignedPayload : undefined
}

function statusValue(value: unknown): KeeperPairingStatus {
  const values: KeeperPairingStatus[] = ["pending", "approved", "provisioning", "active", "rejected", "expired", "cancel_pending", "cancelled"]
  if (typeof value !== "string" || !values.includes(value as KeeperPairingStatus)) {
    throw new Error("Keeper returned a status for another pairing or an unsupported state.")
  }
  return value as KeeperPairingStatus
}

function parseWithdrawal(value: unknown, expectedOperationId?: string): KeeperPairingWithdrawal | undefined {
  if (value === undefined || value === null) return undefined
  const withdrawal = asRecord(value)
  if (!withdrawal || typeof withdrawal.operationId !== "string" || !withdrawal.operationId
    || (expectedOperationId && withdrawal.operationId !== expectedOperationId)
    || typeof withdrawal.requestHash !== "string" || !withdrawal.requestHash
    || !["cancel_pending", "cancelled"].includes(String(withdrawal.status))) {
    throw new Error("Keeper returned a malformed cancellation status.")
  }
  return { operationId: withdrawal.operationId, requestHash: withdrawal.requestHash,
    status: withdrawal.status as KeeperPairingWithdrawal["status"] }
}

function validateStatusPayload(payload: SignedPayload, pairing: KeeperPairing, controllerPersonId: string, controllerDeviceId: string): KeeperPairingStatus {
  if (payload.pairingId !== pairing.pairingId || payload.integrationId !== pairing.integrationId
    || payload.transcriptHash !== pairing.transcriptHash || payload.serviceOrigin !== pairing.discovery.origin) {
    throw new Error("Keeper returned a status for another pairing or an unsupported state.")
  }
  const status = statusValue(payload.status)
  if (pairing.controllerOrigin && ["approved", "provisioning", "active"].includes(status)) {
    assertOwnerOriginAdmission(payload, pairing, controllerPersonId, controllerDeviceId)
  }
  return status
}

function parseProvisioning(payload: SignedPayload, pairing: KeeperPairing, status: KeeperPairingStatus): KeeperProvisionedScope[] | undefined {
  if (!payload.provisioning && status !== "active" && status !== "provisioning") return undefined
  return verifyProvisionedScopes(payload, pairing, status === "cancel_pending" || status === "cancelled")
}

function validateStatusConsistency(status: KeeperPairingStatus, withdrawal?: KeeperPairingWithdrawal) {
  if ((status === "cancel_pending" || status === "cancelled") !== Boolean(withdrawal)
    || (withdrawal && withdrawal.status !== status)) {
    throw new Error("Keeper cancellation state does not match its signed status.")
  }
}

function validateTerminalScopes(status: KeeperPairingStatus, scopes?: KeeperProvisionedScope[]) {
  if (status === "cancelled" && scopes?.some(scope => scope.status === "active")) {
    throw new Error("Keeper reported cancellation before every board was detached.")
  }
}

export async function getKeeperPairingStatusInfo(pairing: KeeperPairing, expectedWithdrawalOperationId?: string): Promise<KeeperPairingStatusInfo> {
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, pairing.discovery, "keeper-pairing-status", {
    pairingId: pairing.pairingId,
    transcriptHash: pairing.transcriptHash,
    ...(expectedWithdrawalOperationId ? { withdrawalOperationId: expectedWithdrawalOperationId } : {}),
  })
  const envelope = await requestKeeperJson<unknown>(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/status`, {
    method: "POST", body: JSON.stringify(signed),
  })
  const payload = await verifyKeeperServiceEnvelope(pairing.discovery, envelope, "keeper-pairing-status")
  const status = validateStatusPayload(payload, pairing, profile.identity.personId, profile.device?.deviceId ?? "")
  const withdrawal = parseWithdrawal(payload.withdrawal, expectedWithdrawalOperationId)
  validateStatusConsistency(status, withdrawal)
  const provisioningScopes = parseProvisioning(payload, pairing, status)
  validateTerminalScopes(status, provisioningScopes)
  return { status, ...(withdrawal ? { withdrawal } : {}), ...(provisioningScopes ? { provisioningScopes } : {}) }
}

async function withdrawalRequestHash(payload: SignedPayload) {
  const semantic = { ...payload }
  delete semantic.issuedAt
  delete semantic.expiresAt
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(semantic)))
}

function validateWithdrawalProofs(pairing: KeeperPairing, proofs: KeeperWithdrawalGrantProof[]) {
  const expected = pairing.workspaces.map(workspace => workspace.id).sort()
  const actual = proofs.map(proof => proof.workspaceId).sort()
  if (new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) {
    throw new Error("Keeper cancellation proof contains an unapproved board.")
  }
}

function signedScopeProof(proof: KeeperWithdrawalScopeProof | KeeperWithdrawalGrantProof) {
  return { workspaceId: proof.workspaceId, document: proof.document, authorizationBundle: proof.authorizationBundle,
    ...("grant" in proof ? { grant: proof.grant } : {}) }
}

export async function requestKeeperPairingWithdrawal(pairing: KeeperPairing, operationId: string,
  grantScopes: KeeperWithdrawalGrantProof[] = []): Promise<KeeperPairingWithdrawal> {
  validateWithdrawalProofs(pairing, grantScopes)
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, pairing.discovery, "keeper-pairing-withdrawal", {
    pairingId: pairing.pairingId, transcriptHash: pairing.transcriptHash,
    challengeNonce: pairing.challengeNonce, operationId,
    servicePersonId: pairing.discovery.personId, serviceDeviceId: pairing.discovery.deviceId,
    serviceOrigin: pairing.discovery.origin,
    ...(grantScopes.length ? { grantScopes: grantScopes.map(signedScopeProof) } : {}),
  })
  const requestPayload = signed.signed.payload as SignedPayload
  const requestHash = await withdrawalRequestHash(requestPayload)
  const response = await requestKeeperJson<unknown>(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/withdraw`, {
    method: "POST", body: JSON.stringify(signed),
  })
  const payload = await verifyKeeperServiceEnvelope(pairing.discovery, response, "keeper-pairing-status")
  const withdrawal = parseWithdrawal(payload.withdrawal, operationId)
  if (!withdrawal || withdrawal.requestHash !== requestHash || payload.pairingId !== pairing.pairingId
    || payload.integrationId !== pairing.integrationId || payload.transcriptHash !== pairing.transcriptHash
    || payload.status !== withdrawal.status) {
    throw new Error("Keeper returned a cancellation receipt for another request.")
  }
  return withdrawal
}

export async function completeKeeperPairingWithdrawal(pairing: KeeperPairing, operationId: string,
  scopes: KeeperWithdrawalScopeProof[], expectedRequestHash?: string): Promise<KeeperPairingWithdrawal> {
  const expected = pairing.workspaces.map(workspace => workspace.id).sort()
  const actual = scopes.map(scope => scope.workspaceId).sort()
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
    || actual.join("\0") !== expected.join("\0")) {
    throw new Error("Keeper cancellation proof does not cover the exact approved boards.")
  }
  const profile = await bootstrapIdentity()
  const signed = await signKeeperControllerRequest(profile, pairing.discovery, "keeper-pairing-withdrawal-complete", {
    pairingId: pairing.pairingId, withdrawalOperationId: operationId, operationId,
    transcriptHash: pairing.transcriptHash, challengeNonce: pairing.challengeNonce,
    servicePersonId: pairing.discovery.personId, serviceDeviceId: pairing.discovery.deviceId,
    serviceOrigin: pairing.discovery.origin,
    scopes: scopes.map(signedScopeProof),
  })
  const response = await requestKeeperJson<unknown>(`${pairing.discovery.origin}/v1/pairings/${encodeURIComponent(pairing.pairingId)}/withdraw/complete`, {
    method: "POST", body: JSON.stringify(signed),
  })
  const payload = await verifyKeeperServiceEnvelope(pairing.discovery, response, "keeper-pairing-status")
  const withdrawal = parseWithdrawal(payload.withdrawal, operationId)
  if (!withdrawal || payload.pairingId !== pairing.pairingId || payload.integrationId !== pairing.integrationId
    || payload.transcriptHash !== pairing.transcriptHash || payload.status !== withdrawal.status
    || (expectedRequestHash && withdrawal.requestHash !== expectedRequestHash)) {
    throw new Error("Keeper returned an invalid cancellation completion status.")
  }
  return withdrawal
}
