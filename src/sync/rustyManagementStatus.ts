import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type SignedEnvelope } from "../domain/identity"
import { decodeBlindBytes } from "./blindEnvelope"
import { blindOrigin } from "./blindOrigin"
import type { BlindAccess } from "./blindClient"
import { verifyRustyManagementCapability, type ExpectedManagementAuthority, type RustyManagementCapability } from "./rustyManagementCapability"

export type ManagementStatusAuthorization = {
  kind: "rusty-management-policy-status"
  version: 1
  serviceId: string
  origin: string
  personId: string
  deviceId: string
  resourceKind: "scope" | "board" | "person"
  resourceId: string
  requestId: string
  issuedAt: number
  expiresAt: number
}

export type ManagementStatusReceipt = {
  kind: "rusty-management-policy-status-receipt"
  version: 1
  serviceId: string
  origin: string
  personId: string
  deviceId: string
  resourceKind: "scope" | "board" | "person"
  resourceId: string
  requestId: string
  authorizationHash: string
  capabilityHash: string | null
  revision: number
  migrationPending: boolean
  issuedAt: number
}

export type RustyManagementStatusResponse = {
  capability: SignedEnvelope<RustyManagementCapability> | null
  migrationPending: boolean
  receipt: SignedEnvelope<ManagementStatusReceipt>
}

export type VerifiedManagementStatus = {
  capability: RustyManagementCapability | null
  migrationPending: boolean
  revision: number
}

const responseFields = ["capability", "migrationPending", "receipt"]
const envelopeFields = ["payload", "signerKeyId", "signature"]
const authorizationFields = ["kind", "version", "serviceId", "origin", "personId", "deviceId", "resourceKind", "resourceId", "requestId", "issuedAt", "expiresAt"]
const receiptFields = ["kind", "version", "serviceId", "origin", "personId", "deviceId", "resourceKind", "resourceId", "requestId",
  "authorizationHash", "capabilityHash", "revision", "migrationPending", "issuedAt"]

/** Verify a status response against the exact request authorization and current local authority floor. */
export async function verifyRustyManagementStatus(
  value: unknown,
  access: Pick<BlindAccess, "origin" | "servicePublicKey">,
  expected: ExpectedManagementAuthority,
  authorization: SignedEnvelope<ManagementStatusAuthorization>,
): Promise<VerifiedManagementStatus> {
  let responseSnapshot: unknown
  let accessSnapshot: Pick<BlindAccess, "origin" | "servicePublicKey">
  let expectedSnapshot: ExpectedManagementAuthority
  let authorizationSnapshot: SignedEnvelope<ManagementStatusAuthorization>
  try {
    responseSnapshot = structuredClone(value)
    accessSnapshot = { origin: access.origin, servicePublicKey: access.servicePublicKey }
    expectedSnapshot = structuredClone(expected)
    authorizationSnapshot = structuredClone(authorization)
  } catch {
    throw new Error("Invalid management status input")
  }

  const response = asRecord(responseSnapshot)
  exactKeys(response, responseFields, "Invalid management status response")
  if (typeof response.migrationPending !== "boolean") throw new Error("Invalid management status response")
  const receiptEnvelope = asRecord(response.receipt)
  exactKeys(receiptEnvelope, envelopeFields, "Invalid management status receipt")
  const receiptPayload = asRecord(receiptEnvelope.payload)
  exactKeys(receiptPayload, receiptFields, "Invalid management status receipt")
  const receipt = receiptPayload as unknown as ManagementStatusReceipt
  validateExpected(expectedSnapshot)
  const pinnedServiceId = await sha256Base64Url(decodeBlindBytes(accessSnapshot.servicePublicKey))
  validateAuthorization(authorizationSnapshot, expectedSnapshot, accessSnapshot, pinnedServiceId)
  validateReceipt(receipt, response.migrationPending as boolean, expectedSnapshot, authorizationSnapshot)

  if (receipt.serviceId !== pinnedServiceId || receiptEnvelope.signerKeyId !== pinnedServiceId ||
    typeof receiptEnvelope.signature !== "string" || !isSignature(receiptEnvelope.signature) ||
    !await verifyServiceReceipt(response.receipt, accessSnapshot.servicePublicKey)) {
    throw new Error("Rusty management status signature or service pin invalid")
  }

  const authorizationHash = await hashJson(authorizationSnapshot)
  if (receipt.authorizationHash !== authorizationHash) throw new Error("Rusty management status does not cover this request")
  const capabilityValue = response.capability
  if (capabilityValue === null) {
    if (receipt.capabilityHash !== null || receipt.revision !== 0 || expectedSnapshot.minimumRevision > 0) {
      throw new Error("Rusty management capability is missing or rolled back")
    }
    return { capability: null, migrationPending: response.migrationPending as boolean, revision: 0 }
  }
  const capabilityHash = await hashJson(capabilityValue)
  if (receipt.capabilityHash !== capabilityHash) throw new Error("Rusty management status capability hash mismatch")
  const capability = await verifyRustyManagementCapability(capabilityValue, accessSnapshot, expectedSnapshot)
  if (capability.revision !== receipt.revision) throw new Error("Rusty management status revision mismatch")
  return { capability, migrationPending: response.migrationPending as boolean, revision: receipt.revision }
}

function validateExpected(expected: ExpectedManagementAuthority): void {
  if (!validId(expected.personId) || !validId(expected.deviceId) || !validId(expected.resourceId) ||
    !Number.isSafeInteger(expected.minimumRevision) || expected.minimumRevision < 0 ||
    typeof expected.operation !== "string" || expected.operation.length === 0 ||
    (expected.resourceKind !== "scope" && expected.resourceKind !== "board" && expected.resourceKind !== "person") ||
    (expected.resourceKind === "person" && expected.resourceId !== expected.personId)) throw new Error("Invalid expected management authority")
}

function validateAuthorization(
  authorization: SignedEnvelope<ManagementStatusAuthorization>,
  expected: ExpectedManagementAuthority,
  access: Pick<BlindAccess, "origin" | "servicePublicKey">,
  serviceId: string,
): void {
  const envelope = asRecord(authorization)
  exactKeys(envelope, envelopeFields, "Invalid management status authorization")
  const payload = asRecord(authorization.payload)
  exactKeys(payload, authorizationFields, "Invalid management status authorization")
  const auth = payload as unknown as ManagementStatusAuthorization
  if (!statusAuthorizationMatches(auth, authorization, expected, serviceId, blindOrigin(access.origin))) throw new Error("Rusty management status request binding invalid")
  if (!validStatusTiming(auth)) throw new Error("Rusty management status request timing invalid")
}

function statusAuthorizationMatches(
  auth: ManagementStatusAuthorization,
  envelope: SignedEnvelope<ManagementStatusAuthorization>,
  expected: ExpectedManagementAuthority,
  serviceId: string,
  origin: string,
): boolean {
  return auth.kind === "rusty-management-policy-status" && auth.version === 1 && auth.serviceId === serviceId && auth.origin === origin &&
    auth.personId === expected.personId && auth.deviceId === expected.deviceId && auth.resourceKind === expected.resourceKind &&
    auth.resourceId === expected.resourceId && validId(auth.requestId) && envelope.signerKeyId === expected.deviceId && isSignature(envelope.signature)
}

function validStatusTiming(auth: ManagementStatusAuthorization): boolean {
  const now = Date.now()
  return Number.isSafeInteger(auth.issuedAt) && auth.issuedAt >= 0 && auth.issuedAt <= now + 30_000 &&
    Number.isSafeInteger(auth.expiresAt) && auth.expiresAt > now && auth.expiresAt <= Number.MAX_SAFE_INTEGER &&
    auth.expiresAt > auth.issuedAt && auth.expiresAt - auth.issuedAt <= 120_000
}

function validateReceipt(
  receipt: ManagementStatusReceipt,
  responsePending: boolean,
  expected: ExpectedManagementAuthority,
  authorization: SignedEnvelope<ManagementStatusAuthorization>,
): void {
  const auth = authorization.payload
  if (!statusReceiptMatches(receipt, responsePending, auth, expected)) throw new Error("Rusty management status receipt binding invalid")
  if (!validStatusReceiptMetadata(receipt)) throw new Error("Rusty management status receipt metadata invalid")
}

function statusReceiptMatches(
  receipt: ManagementStatusReceipt,
  responsePending: boolean,
  auth: ManagementStatusAuthorization,
  expected: ExpectedManagementAuthority,
): boolean {
  return receipt.kind === "rusty-management-policy-status-receipt" && receipt.version === 1 && receipt.origin === auth.origin &&
    receipt.personId === expected.personId && receipt.deviceId === expected.deviceId && receipt.resourceKind === expected.resourceKind &&
    receipt.resourceId === expected.resourceId && receipt.requestId === auth.requestId &&
    receipt.migrationPending === responsePending && typeof receipt.migrationPending === "boolean"
}

function validStatusReceiptMetadata(receipt: ManagementStatusReceipt): boolean {
  return Number.isSafeInteger(receipt.issuedAt) && receipt.issuedAt >= 0 &&
    Number.isSafeInteger(receipt.revision) && receipt.revision >= 0 &&
    (receipt.capabilityHash === null || isDigest(receipt.capabilityHash)) && isDigest(receipt.authorizationHash)
}

async function verifyServiceReceipt(value: unknown, publicKey: string): Promise<boolean> {
  try { return await verifyEnvelope(value as SignedEnvelope<ManagementStatusReceipt>, publicKey, "RUSTY/2") } catch { return false }
}

async function hashJson(value: unknown): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid management status data")
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, fields: string[], message: string): void {
  const keys = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(message)
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isDigest(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
  try { return decodeBlindBytes(value).length === 32 } catch { return false }
}

function isSignature(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) return false
  try { return decodeBlindBytes(value).length === 64 } catch { return false }
}
