import type { SignedEnvelope } from "./identityCrypto"
import type { DeviceCertificate, WorkspaceGrant } from "./model"
import type { BlindReplicaConfig } from "../product-replica/config"
import type { RustyResourcePrincipalGrant } from "@meta-uber/mesh-replication/rusty-principal-grant"

type BoardStorageConnection = Omit<BlindReplicaConfig, "boardAccess" | "writeToken" | "cursor" | "lastUploaded" | "preferenceRevision">
export type BoardStorageAuthorization = {
  kind: "workspace-rusty-access"
  version: 1 | 2
  ownerPersonId: string
  workspaceId: string
  connection: BoardStorageConnection
  readTokenHash?: string
  writeTokenHash?: string
  subjectPersonId?: string
  subjectPublicKey?: string
  grantId?: string
  policyEpoch?: number
  actions?: ("read" | "write")[]
  workspaceGrant?: WorkspaceGrant
  scopeAuthority?: unknown
}
export type BoardStorageAccess = {
  mode: "read" | "write"
  authorization: SignedEnvelope<BoardStorageAuthorization>
  certificates: DeviceCertificate[]
  principalGrant?: RustyResourcePrincipalGrant
}

/** Structural parsing only; the current board authority verifies signatures before use. */
export function parseBoardStorageAccess(value: unknown): BoardStorageAccess {
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 32_768) throw new Error("Invalid board storage access")
  const access = value as BoardStorageAccess
  if (!["read", "write"].includes(access.mode) || !Array.isArray(access.certificates) || access.certificates.length > 64) {
    throw new Error("Invalid board storage access")
  }
  assertAuthorization(access.authorization)
  if (access.authorization.payload.version === 2 && !validPrincipalGrant(access.principalGrant)) {
    throw new Error("Rusty principal grant is required for participant storage")
  }
  return structuredClone(access)
}

function validPrincipalGrant(value: unknown): value is NonNullable<BoardStorageAccess["principalGrant"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (typeof envelope.signature !== "string" || typeof envelope.signerKeyId !== "string" || !envelope.payload ||
      typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return false
  const payload = envelope.payload as Record<string, unknown>
  return validPrincipalPayload(payload)
}

function validPrincipalPayload(payload: Record<string, unknown>): boolean {
  const fields = ["kind", "version", "serviceId", "origin", "workspaceId", "resourceKind", "resourceId", "scopeId",
    "ownerPersonId", "subjectPersonId", "subjectPublicKey", "grantId", "policyEpoch", "readTokenHash", "actions", "workspaceGrant", "scopeAuthority"]
  if (Object.keys(payload).some(key => !fields.includes(key) && key !== "writeTokenHash") ||
      fields.some(field => !Object.hasOwn(payload, field))) return false
  return payload.kind === "rusty-resource-principal-grant" && payload.version === 1 && validHash(payload.serviceId) &&
    ["origin", "workspaceId", "resourceId", "scopeId", "ownerPersonId", "subjectPersonId", "subjectPublicKey", "grantId"]
      .every(field => typeof payload[field] === "string") && payload.resourceKind === "scope" &&
    Number.isSafeInteger(payload.policyEpoch) && validHash(payload.readTokenHash) && validOptionalWriteHash(payload) &&
    validPrincipalActions(payload.actions) && validAuthorityObjects(payload)
}

function assertAuthorization(authorization: BoardStorageAccess["authorization"]): void {
  const payload = authorization?.payload
  const validVersion = payload?.version === 1 ? validHash(payload.writeTokenHash) : validParticipantAuthorization(payload)
  if (typeof authorization?.signature !== "string" || typeof authorization.signerKeyId !== "string" ||
    payload?.kind !== "workspace-rusty-access" || (payload.version !== 1 && payload.version !== 2) || typeof payload.ownerPersonId !== "string" ||
    !payload.connection || typeof payload.connection !== "object" || !validVersion) {
    throw new Error("Invalid board storage access")
  }
}

function validHash(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) }

function validOptionalWriteHash(payload: Record<string, unknown>): boolean {
  return payload.writeTokenHash === undefined || validHash(payload.writeTokenHash)
}

function validPrincipalActions(actions: unknown): boolean {
  return Array.isArray(actions) && (actions.length === 1 && actions[0] === "read" ||
    actions.length === 2 && actions[0] === "read" && actions[1] === "write")
}

function validAuthorityObjects(payload: Record<string, unknown>): boolean {
  return Boolean(payload.workspaceGrant && typeof payload.workspaceGrant === "object") &&
    Boolean(payload.scopeAuthority && typeof payload.scopeAuthority === "object")
}

function validParticipantAuthorization(payload: BoardStorageAuthorization | undefined): boolean {
  if (!payload || payload.version !== 2 || !validHash(payload.readTokenHash) ||
      ![payload.subjectPersonId, payload.subjectPublicKey, payload.grantId].every(value => typeof value === "string") ||
      !Number.isSafeInteger(payload.policyEpoch) || !Array.isArray(payload.actions)) return false
  return payload.actions.every(action => action === "read" || action === "write") &&
    (payload.actions.includes("write") ? validHash(payload.writeTokenHash) : payload.writeTokenHash === undefined) &&
    payload.workspaceGrant !== undefined && Boolean(payload.scopeAuthority && typeof payload.scopeAuthority === "object")
}
