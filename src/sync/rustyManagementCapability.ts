import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { sha256Base64Url, verifyEnvelope, type SignedEnvelope } from "../domain/identity"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindAccess } from "./blindClient"

export type RustyManagementCapability = {
  kind: "rusty-scope-management-capability" | "rusty-person-management-capability"
  version: 1
  serviceId: string
  origin: string
  personId: string
  resourceKind: "scope" | "board" | "person"
  resourceId: string
  revision: number
  operations: string[]
  revokedDeviceIds: string[]
  requestId: string
  authorizationHash: string
  issuedAt: number
}

export type ExpectedManagementAuthority = {
  personId: string
  deviceId: string
  resourceKind: "scope" | "board" | "person"
  resourceId: string
  operation: string
  minimumRevision: number
}

export type ExpectedManagementEvidence = Omit<ExpectedManagementAuthority, "deviceId" | "operation">

const capabilityFields = ["kind", "version", "serviceId", "origin", "personId", "resourceKind", "resourceId", "revision",
  "operations", "revokedDeviceIds", "requestId", "authorizationHash", "issuedAt"]
const envelopeFields = ["payload", "signerKeyId", "signature"]
const scopeOperations = ["management.update", "scope.policy", "snapshot.checkpoint"]
const boardOperations = ["management.update", "publication.status", "publication.publish", "publication.update", "publication.unpublish", "publication.stage-file"]
const personOperations = ["management.update", "resource.create"]

/** Verify strict, pinned evidence before a caller uses it for management authorization. */
export async function verifyRustyManagementCapability(
  value: unknown,
  access: Pick<BlindAccess, "origin" | "servicePublicKey">,
  expected: ExpectedManagementAuthority,
): Promise<RustyManagementCapability> {
  let expectedSnapshot: ExpectedManagementAuthority
  try {
    expectedSnapshot = structuredClone(expected)
  } catch {
    throw new Error("Invalid management capability input")
  }
  validateExpected(expectedSnapshot)
  const cap = await verifyRustyManagementEvidence(value, access, expectedSnapshot)
  validateOperation(expectedSnapshot)
  if (!cap.operations.includes(expectedSnapshot.operation) || cap.revokedDeviceIds.includes(expectedSnapshot.deviceId)) {
    throw new Error("Management capability does not authorize this device or operation")
  }
  return cap
}

/** Verify signed policy evidence for storage/import, including revoked-device entries. */
export async function verifyRustyManagementEvidence(
  value: unknown,
  access: Pick<BlindAccess, "origin" | "servicePublicKey">,
  expected: ExpectedManagementEvidence,
): Promise<RustyManagementCapability> {
  let valueSnapshot: unknown
  let accessSnapshot: Pick<BlindAccess, "origin" | "servicePublicKey">
  let expectedSnapshot: ExpectedManagementEvidence
  try {
    valueSnapshot = structuredClone(value)
    accessSnapshot = { origin: access.origin, servicePublicKey: access.servicePublicKey }
    expectedSnapshot = structuredClone(expected)
  } catch {
    throw new Error("Invalid management capability input")
  }
  const envelope = record(valueSnapshot)
  exactKeys(envelope, envelopeFields, "Invalid management capability envelope")
  const payload = record(envelope.payload)
  exactKeys(payload, capabilityFields, "Invalid management capability")

  const cap = payload as unknown as RustyManagementCapability
  const expectedOrigin = blindOrigin(accessSnapshot.origin)
  validateEvidenceExpected(expectedSnapshot)
  validateCapability(cap, expectedSnapshot.minimumRevision)
  if (!isEvidenceFor(cap, expectedSnapshot, expectedOrigin)) {
    throw new Error("Management capability does not match this evidence target")
  }
  if (cap.serviceId !== await sha256Base64Url(decodeBlindBytes(accessSnapshot.servicePublicKey))) {
    throw new Error("Management capability service pin mismatch")
  }
  if (envelope.signerKeyId !== cap.serviceId || typeof envelope.signature !== "string" || !isSignature(envelope.signature)) {
    throw new Error("Management capability signer is invalid")
  }
  if (!await hasValidSignature(valueSnapshot as SignedEnvelope<RustyManagementCapability>, accessSnapshot.servicePublicKey)) {
    throw new Error("Management capability signature invalid")
  }
  return structuredClone(cap)
}

function validateExpected(expected: ExpectedManagementAuthority): void {
  if (!validId(expected.personId) || !validId(expected.deviceId) || !validId(expected.resourceId) ||
    !Number.isSafeInteger(expected.minimumRevision) || expected.minimumRevision < 0 ||
    typeof expected.operation !== "string" || expected.operation.length === 0) throw new Error("Invalid expected management authority")
}

function validateEvidenceExpected(expected: ExpectedManagementEvidence): void {
  if (!validId(expected.personId) || !validId(expected.resourceId) ||
    !Number.isSafeInteger(expected.minimumRevision) || expected.minimumRevision < 0 ||
    (expected.resourceKind !== "scope" && expected.resourceKind !== "board" && expected.resourceKind !== "person") ||
    (expected.resourceKind === "person" && expected.resourceId !== expected.personId)) throw new Error("Invalid expected management evidence target")
}

function validateOperation(expected: ExpectedManagementAuthority): void {
  const allowed = expected.resourceKind === "scope" ? scopeOperations : expected.resourceKind === "board" ? boardOperations : personOperations
  if (!allowed.includes(expected.operation)) throw new Error("Invalid expected management operation")
}

function validateCapability(cap: RustyManagementCapability, minimumRevision: number): void {
  if (!validCapabilityMetadata(cap, minimumRevision) || !validCapabilityWire(cap)) throw new Error("Invalid management capability")
  validateRights(cap)
}

function validCapabilityMetadata(cap: RustyManagementCapability, minimumRevision: number): boolean {
  const correctKind = cap.resourceKind === "person" ? cap.kind === "rusty-person-management-capability" : cap.kind === "rusty-scope-management-capability"
  return correctKind && cap.version === 1 && validId(cap.serviceId) &&
    validId(cap.personId) && validId(cap.resourceId) && validId(cap.requestId) &&
    Number.isSafeInteger(cap.revision) && cap.revision > 0 && cap.revision >= minimumRevision &&
    Number.isSafeInteger(cap.issuedAt) && cap.issuedAt >= 0
}

function validCapabilityWire(cap: RustyManagementCapability): boolean {
  return (cap.resourceKind === "scope" || cap.resourceKind === "board" || cap.resourceKind === "person") && typeof cap.origin === "string" &&
    typeof cap.authorizationHash === "string" && isDigest(cap.authorizationHash) &&
    Array.isArray(cap.operations) && Array.isArray(cap.revokedDeviceIds)
}

function validateRights(cap: RustyManagementCapability): void {
  const allowed = cap.resourceKind === "scope" ? scopeOperations : cap.resourceKind === "board" ? boardOperations : personOperations
  if (!isSortedUniqueStrings(cap.operations) || cap.operations.length === 0 ||
    cap.operations.length > allowed.length || cap.operations.some(operation => !allowed.includes(operation)) ||
    !cap.operations.includes("management.update") || !isSortedUniqueIds(cap.revokedDeviceIds) || cap.revokedDeviceIds.length > 4096) {
    throw new Error("Invalid management capability rights")
  }
}

function isEvidenceFor(cap: RustyManagementCapability, expected: ExpectedManagementEvidence, origin: string): boolean {
  return cap.origin === origin && cap.personId === expected.personId && cap.resourceKind === expected.resourceKind &&
    (cap.resourceKind === "person" ? cap.kind === "rusty-person-management-capability" && cap.resourceId === cap.personId : cap.kind === "rusty-scope-management-capability") &&
    cap.resourceId === expected.resourceId
}

async function hasValidSignature(value: SignedEnvelope<RustyManagementCapability>, servicePublicKey: string): Promise<boolean> {
  try { return await verifyEnvelope(value, servicePublicKey, "RUSTY/2") } catch { return false }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid management capability")
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: string[], message: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(message)
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isDigest(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value) && (() => {
    try { return decodeBlindBytes(value).length === 32 } catch { return false }
  })()
}

function isSignature(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) return false
  try { return decodeBlindBytes(value).length === 64 } catch { return false }
}

function isSortedUniqueStrings(values: unknown[]): values is string[] {
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (typeof value !== "string" || value.length === 0 || (index > 0 && (values[index - 1] as string) >= value)) return false
  }
  return true
}

function isSortedUniqueIds(values: unknown[]): values is string[] {
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (!validId(value) || (index > 0 && (values[index - 1] as string) >= value)) return false
  }
  return true
}
