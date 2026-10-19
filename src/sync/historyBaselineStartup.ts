import { peerStore } from "./peerStore"
import { reverifyStoredHistoryBaseline } from "../product-replica"
import { reverifyStoredPeerHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { openWithReplicaContentKeys } from "./replicaContentKeys"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { getPrivateReplicaConfigurations } from "./privateReplicaRepository"
import { traceStorageRead, type StorageReadTrace } from "../storageReadTrace"

/** Rebuild the active compact Owner-attested basis before any workspace read. */
export async function reverifyActiveHistoryForWorkspace(workspaceId: string, owner: string, ensureCurrent: () => void,
  trace?: StorageReadTrace) {
  const repository = createReceivedHistoryBaselineRepository(workspaceId, ensureCurrent)
  const active = await traceStorageRead(trace, "activebaseline-read", () => repository.readActive(), { workspaceId })
  if (!active) return null
  const [configurations, authority, credential] = await traceStorageRead(trace, "credentials-authority-read", () => Promise.all([
    getPrivateReplicaConfigurations(owner), peerStore.getWorkspaceAuthority(workspaceId),
    peerStore.getWorkspaceCredential(workspaceId),
  ]), { workspaceId })
  ensureCurrent()
  const storedAuthority = authority ?? credential
  const trustedScopeAuthority = storedAuthority?.scopeAuthoritySnapshot
  if (!trustedScopeAuthority) {
    throw new Error("Received workspace history requires an admitted signed scope authority")
  }
  if (active.peerProofs) {
    if (active.encryptedObjects.length !== 0) throw new Error("Saved peer history unexpectedly contains Rusty ciphertext")
    return traceStorageRead(trace, "peer-native-reverify", () =>
      reverifyStoredPeerHistoryBaseline({ stored: active, trustedScopeAuthority, ensureCurrent }),
    { workspaceId, bytes: active.document.byteLength })
  }
  const matches = configurations.filter(config => config.purpose !== "identity" && config.workspaceId === workspaceId &&
    config.scopeId === active.scopeId)
  if (matches.length !== 1) throw new Error("Received workspace history requires one matching saved Rusty scope configuration")
  const config = matches[0]!
  ensureCurrent()
  return traceStorageRead(trace, "rusty-native-reverify", () => openWithReplicaContentKeys(config, active.keyEpoch, async contentKey => {
    ensureCurrent()
    return reverifyStoredHistoryBaseline({ stored: active,
      scope: { scopeId: active.scopeId, keyEpoch: active.keyEpoch, key: decodeBlindBytes(contentKey) },
      trustedScopeAuthority, ensureCurrent })
  }), { workspaceId, bytes: active.document.byteLength })
}
