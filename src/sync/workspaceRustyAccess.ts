import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { parseBoardStorageAccess, type BoardStorageAccess, type BoardStorageAuthorization } from "../domain/boardStorageAccess"
import { signWithContext, signingEvidence } from "../domain/signingContext"
import { verifyDeviceChain } from "./meshRecords"
import { workspaceOwnerSigningContext, type ReadWorkspaceOwnerAuthority } from "./workspaceOwnerSigning"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { getReplicaConfigurations, setReplicaPreference, privateReplicaBinding } from "./privateReplicaRepository"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WorkspaceMeshCredential } from "./peerStore"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

type Guard = () => Promise<void>
type Role = "owner" | "editor" | "visitor"
type BoardAuthority = Pick<WorkspaceMeshCredential, "ownerPersonId" | "ownerPublicKey"> & { catalog?: unknown }
const hash = (value: string) => sha256Base64Url(new TextEncoder().encode(value))

function readingConnection(config: BlindReplicaConfig) {
  const { boardAccess, writeToken, cursor, lastUploaded, preferenceRevision, ...connection } = parseReplicaConfig(JSON.stringify(config))
  void boardAccess; void writeToken; void cursor; void lastUploaded; void preferenceRevision
  return connection
}

/** Owner management authority is used only locally; the attestation conveys board storage access. */
export async function createBoardStorageAccess(profile: LocalProfile, config: BlindReplicaConfig,
  readAuthority: ReadWorkspaceOwnerAuthority, guard: Guard): Promise<BoardStorageAccess> {
  await guard()
  if (config.boardAccess || config.removalPending) throw new Error("Only an active owner connection can be attested")
  if (config.readToken === config.writeToken) throw new Error("Separate reading and writing tokens are required before sharing storage")
  const context = await workspaceOwnerSigningContext(profile, config.workspaceId, "workspace-rusty-access", {}, readAuthority)
  const payload: BoardStorageAuthorization = { kind: "workspace-rusty-access", version: 1, workspaceId: config.workspaceId, ownerPersonId: profile.identity.personId,
    connection: readingConnection(config), writeTokenHash: await hash(config.writeToken) }
  await guard()
  const authorization = await signWithContext(context, payload)
  await guard()
  return { mode: "write", authorization, certificates: signingEvidence(context).certificates }
}

export function selectBoardStorageAccess(access: BoardStorageAccess, writeToken: string, role: Role): BlindReplicaConfig | undefined {
  if (role === "visitor" && writeToken === access.authorization.payload.connection.readToken) return undefined
  if (role !== "visitor" && (!writeToken || access.mode !== "write")) return undefined
  return { ...access.authorization.payload.connection, writeToken: role === "visitor" ? "" : writeToken,
    boardAccess: { ...structuredClone(access), mode: role === "visitor" ? "read" : "write" }, cursor: 0, lastUploaded: "" }
}

/** Verify the original owner even when a different authorized participant forwards the access. */
export async function verifyBoardStorageAccess(config: BlindReplicaConfig, workspaceId: string,
  authority: BoardAuthority, role: Role): Promise<void> {
  const access = parseBoardStorageAccess(config.boardAccess)
  const record = access.authorization
  if (config.workspaceId !== workspaceId || record.payload.workspaceId !== workspaceId || record.payload.ownerPersonId !== authority.ownerPersonId ||
    canonicalizeJson(readingConnection(config)) !== canonicalizeJson(record.payload.connection) ||
    (role === "visitor" && access.mode !== "read") || (access.mode === "read" && config.writeToken !== "")) {
    throw new Error("Board storage access does not match current workspace or role")
  }
  const key = await verifyDeviceChain({ personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
    deviceId: record.signerKeyId, certificates: access.certificates })
  if (meshRustRuntime().state.isDeviceRevoked(authority, authority.ownerPersonId, record.signerKeyId)) {
    throw new Error("Owner storage attestation device was revoked")
  }
  if (access.mode === "read" && await hash(config.readToken) === record.payload.writeTokenHash) {
    throw new Error("Separate reading and writing tokens are required for visitor storage")
  }
  if (!await verifyEnvelope(record, key) || (access.mode === "write" && await hash(config.writeToken) !== record.payload.writeTokenHash)) {
    throw new Error("Invalid owner board storage authorization")
  }
}

function sameAccess(left: BlindReplicaConfig, right: BlindReplicaConfig): boolean {
  return canonicalizeJson([readingConnection(left), left.writeToken, left.boardAccess]) ===
    canonicalizeJson([readingConnection(right), right.writeToken, right.boardAccess])
}

function shouldReplace(previous: BlindReplicaConfig | undefined, config: BlindReplicaConfig, role: Role): boolean {
  if (!previous) return true
  if (!previous.boardAccess || previous.removalPending || previous.policyRevision > config.policyRevision || sameAccess(previous, config)) return false
  if (previous.policyRevision !== config.policyRevision) return true
  if (canonicalizeJson(readingConnection(previous)) !== canonicalizeJson(readingConnection(config))) {
    throw new Error("Board storage credentials changed without a new policy revision")
  }
  return !(role !== "visitor" && previous.boardAccess.mode === "write" && config.boardAccess?.mode === "read")
}

export async function receiveBoardStorageAccess(personId: string, workspaceId: string,
  authority: BoardAuthority, role: Role, raw: unknown, guard: Guard): Promise<void> {
  await guard()
  if (!Array.isArray(raw) || raw.length > 32 || JSON.stringify(raw).length > 512 * 1024) throw new Error("Board storage transfer exceeds limit")
  const connections = raw.map(value => parseReplicaConfig(JSON.stringify(value)))
  for (const config of connections) { await verifyBoardStorageAccess(config, workspaceId, authority, role); await guard() }
  if (personId === authority.ownerPersonId) return
  for (const config of connections) {
    await withPrivateReplicaOperation(personId, config, async () => {
      await guard()
      const previous = (await getReplicaConfigurations(personId)).find(saved => saved.origin === config.origin && saved.scopeId === config.scopeId)
      await guard()
      if (!shouldReplace(previous, config, role)) return
      const expected = previous ? privateReplicaBinding(personId, previous) : null
      if (await setReplicaPreference(personId, { ...config, cursor: 0, lastUploaded: "" }, false, expected)) identityDevicePreferencesChanged(personId)
      await guard()
    })
  }
}
