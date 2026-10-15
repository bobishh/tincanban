import { canonicalizeJson } from "../domain/identity"
import { withWorkspaceMutation } from "../workspaceMutation"
import { peerStore } from "../sync/peerStore"
import { workspaceAuthorityFingerprint } from "../sync/authorityFingerprint"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { getChatProjectionAccess, notifyChatProfileProjection } from "./service"
import { chatStore, doesProfileWin, type StoredChatProfile } from "./store"
import { verifyChatRecord, type ChatRecord } from "./records"

async function currentAuthority(workspaceId: string, record: ChatRecord): Promise<string> {
  const access = await getChatProjectionAccess(workspaceId)
  const [credential, authority, peers] = typeof indexedDB === "undefined" ? [null, null, []] : await Promise.all([
    peerStore.getWorkspaceCredential(workspaceId), peerStore.getWorkspaceAuthority(workspaceId), peerStore.listPeers(workspaceId),
  ])
  const stored = credential ?? authority
  if (stored && stored.ownerPersonId !== access.ownerPersonId) throw new Error("Workspace owner evidence is not current")
  const payload = record.signed.payload
  if (peers.some(peer => peer.personId === payload.personId && peer.revokedAt) ||
    (stored && (meshRustRuntime().state.isGrantRevoked(stored, payload.personId, record.authority?.grant ?? null) ||
      meshRustRuntime().state.isDeviceRevoked(stored, payload.personId, payload.deviceId)))) {
    throw new Error("Workspace profile access is revoked")
  }
  return canonicalizeJson([access, workspaceAuthorityFingerprint(credential ? [credential] : [], authority ? [authority] : [])])
}

/** Read-only replay check. Saved flags alone never prove that shared profile admission succeeded. */
export async function isPrivateProfileObservationMaterialized(workspaceId: string, value: ChatRecord): Promise<boolean> {
  const record = structuredClone(value)
  try {
    const before = await currentAuthority(workspaceId, record), access = await getChatProjectionAccess(workspaceId)
    const verified = await verifyChatRecord(record, access.scope, access.ownerPersonId, workspaceId)
    if (verified.signed.payload.kind !== "chat-profile") return false
    const payload = verified.signed.payload
    const saved = (await chatStore.loadProfiles(access.scope)).find(profile => profile.personId === payload.personId)
    if (!saved) return false
    const original = await verifyChatRecord(saved.record, access.scope, access.ownerPersonId, workspaceId)
    const incoming: StoredChatProfile = { workspaceId: access.scope, personId: payload.personId, name: payload.text,
      revision: payload.revision, record: verified }
    return original.signed.payload.kind === "chat-profile" && saved.name === original.signed.payload.text &&
      saved.revision === original.signed.payload.revision &&
      (canonicalizeJson(saved.record) === canonicalizeJson(verified) || doesProfileWin(saved, incoming)) &&
      before === await currentAuthority(workspaceId, record)
  } catch {
    // Unavailable or rejected shared evidence remains in the private queue for normal guarded projection.
    return false
  }
}

/** Private authorship alone never supplies the owner or room used by shared chat admission. */
export async function projectPrivateProfileObservation(workspaceId: string, value: ChatRecord, ensureCurrent: () => void): Promise<void> {
  const record = structuredClone(value)
  await withWorkspaceMutation(workspaceId, async () => {
    ensureCurrent()
    const before = await currentAuthority(workspaceId, record), access = await getChatProjectionAccess(workspaceId)
    const verified = await verifyChatRecord(record, access.scope, access.ownerPersonId, workspaceId)
    if (verified.signed.payload.kind !== "chat-profile") throw new Error("Private profile projection requires a profile record")
    ensureCurrent()
    if (before !== await currentAuthority(workspaceId, record)) throw new Error("Workspace authority changed during profile projection")
    const payload = verified.signed.payload
    const profile: StoredChatProfile = { workspaceId: access.scope, personId: payload.personId, name: payload.text,
      revision: payload.revision, record: verified }
    const result = await chatStore.merge(access.scope, [], [profile])
    ensureCurrent()
    if (before !== await currentAuthority(workspaceId, record)) throw new Error("Workspace authority changed before profile confirmation")
    const saved = (await chatStore.loadProfiles(access.scope)).find(value => value.personId === payload.personId)
    if (!saved) throw new Error("Shared profile was not retained")
    const savedRecord = await verifyChatRecord(saved.record, access.scope, access.ownerPersonId, workspaceId)
    if (saved.name !== savedRecord.signed.payload.text || saved.revision !== savedRecord.signed.payload.revision ||
      (canonicalizeJson(saved.record) !== canonicalizeJson(verified) && !doesProfileWin(saved, profile))) {
      throw new Error("Shared profile confirmation does not cover the observation")
    }
    ensureCurrent()
    if (before !== await currentAuthority(workspaceId, record)) throw new Error("Workspace authority changed before profile confirmation")
    if (result.changed) notifyChatProfileProjection(workspaceId)
  })
}
