import { peerStore } from "./peerStore"
import { reverifyStoredHistoryBaseline } from "./historyBaselineReceiver"
import { reverifyStoredPeerHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { openWithReplicaContentKeys } from "./replicaContentKeys"
import { decodeBlindBytes } from "./blindEnvelope"
import { getPrivateReplicaConfigurations } from "./privateReplicaRepository"

/** Rebuild the active compact Owner-attested basis before any workspace read. */
export async function reverifyActiveHistoryForWorkspace(workspaceId: string, owner: string, ensureCurrent: () => void) {
  const repository = createReceivedHistoryBaselineRepository(workspaceId, ensureCurrent)
  const active = await repository.readActive()
  if (!active) return null
  const [configurations, authority, credential] = await Promise.all([
    getPrivateReplicaConfigurations(owner), peerStore.getWorkspaceAuthority(workspaceId),
    peerStore.getWorkspaceCredential(workspaceId),
  ])
  ensureCurrent()
  const storedAuthority = authority ?? credential
  const trustedScopeAuthority = storedAuthority?.scopeAuthoritySnapshot
  if (!trustedScopeAuthority) {
    throw new Error("Received workspace history requires an admitted signed scope authority")
  }
  if (active.peerProofs) {
    if (active.encryptedObjects.length !== 0) throw new Error("Saved peer history unexpectedly contains Rusty ciphertext")
    return reverifyStoredPeerHistoryBaseline({ stored: active, trustedScopeAuthority, ensureCurrent })
  }
  const matches = configurations.filter(config => config.purpose !== "identity" && config.workspaceId === workspaceId &&
    config.scopeId === active.scopeId)
  if (matches.length !== 1) throw new Error("Received workspace history requires one matching saved Rusty scope configuration")
  const config = matches[0]!
  ensureCurrent()
  return openWithReplicaContentKeys(config, active.keyEpoch, async contentKey => {
    ensureCurrent()
    return reverifyStoredHistoryBaseline({ stored: active,
      scope: { scopeId: active.scopeId, keyEpoch: active.keyEpoch, key: decodeBlindBytes(contentKey) },
      trustedScopeAuthority, ensureCurrent })
  })
}
