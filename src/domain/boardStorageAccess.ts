import type { SignedEnvelope } from "./identityCrypto"
import type { DeviceCertificate } from "./model"
import type { BlindReplicaConfig } from "../product-replica/config"

export type BoardStorageConnection = Omit<BlindReplicaConfig, "boardAccess" | "writeToken" | "cursor" | "lastUploaded" | "preferenceRevision">
export type BoardStorageAuthorization = {
  kind: "workspace-rusty-access"
  version: 1
  ownerPersonId: string
  workspaceId: string
  connection: BoardStorageConnection
  writeTokenHash: string
}
export type BoardStorageAccess = {
  mode: "read" | "write"
  authorization: SignedEnvelope<BoardStorageAuthorization>
  certificates: DeviceCertificate[]
}

/** Structural parsing only; the current board authority verifies signatures before use. */
export function parseBoardStorageAccess(value: unknown): BoardStorageAccess {
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 32_768) throw new Error("Invalid board storage access")
  const access = value as BoardStorageAccess
  if (!["read", "write"].includes(access.mode) || !Array.isArray(access.certificates) || access.certificates.length > 64) {
    throw new Error("Invalid board storage access")
  }
  assertAuthorization(access.authorization)
  return structuredClone(access)
}

function assertAuthorization(authorization: BoardStorageAccess["authorization"]): void {
  const payload = authorization?.payload
  if (typeof authorization?.signature !== "string" || typeof authorization.signerKeyId !== "string" ||
    payload?.kind !== "workspace-rusty-access" || payload.version !== 1 || typeof payload.ownerPersonId !== "string" ||
    !payload.connection || typeof payload.connection !== "object" || !/^[A-Za-z0-9_-]{43}$/.test(payload.writeTokenHash)) {
    throw new Error("Invalid board storage access")
  }
}
