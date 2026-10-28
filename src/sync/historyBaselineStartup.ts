import { peerStore } from "./peerStore"
import { reverifyStoredHistoryBaseline } from "../product-replica"
import { reverifyStoredPeerHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { openWithReplicaContentKeys } from "./replicaContentKeys"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { getPrivateReplicaConfigurations } from "./privateReplicaRepository"
import { readHistoryBaselineKeyCandidates } from "./historyBaselineReadingKeys"
import { retainWorkspaceRecoveryArchives } from "./workspaceHistoryRecoveryArchives"
import { toBase64Url } from "../domain/identity"
import type { BlindReplicaConfig } from "./blindReplication"
import type { ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"
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
  const keys = await readHistoryBaselineKeyCandidates(owner, active, configurations, ensureCurrent)
  if (!keys.length) throw new Error("Saved workspace history reading key is unavailable; recover its original private history evidence")
  let failure: unknown
  for (const contentKey of keys) {
    ensureCurrent()
    try {
      return await traceStorageRead(trace, "rusty-native-reverify", () => reverifyStoredHistoryBaseline({ stored: active,
        scope: { scopeId: active.scopeId, keyEpoch: active.keyEpoch, key: decodeBlindBytes(contentKey) },
        trustedScopeAuthority, ensureCurrent }), { workspaceId, bytes: active.document.byteLength })
    } catch (error) { ensureCurrent(); failure = error }
  }
  throw failure
}

/** Persist only the authenticated local archive reading key before removing remote delivery access. */
export async function retainHistoryForReplicaDisconnect(config: BlindReplicaConfig, owner: string,
  ensureCurrent: () => void): Promise<void> {
  const active = await createReceivedHistoryBaselineRepository(config.workspaceId, ensureCurrent).readActive()
  if (!active || active.peerProofs || active.scopeId !== config.scopeId ||
      active.pinnedStorage.servicePublicKey !== config.servicePublicKey) return
  const authority = await peerStore.getWorkspaceAuthority(config.workspaceId) ?? await peerStore.getWorkspaceCredential(config.workspaceId)
  ensureCurrent()
  if (!authority?.scopeAuthoritySnapshot) throw new Error("Saved workspace history requires its admitted signed scope authority")
  const reading = await openWithReplicaContentKeys(config, active.keyEpoch, async contentKey => {
    const verified = await reverifyStoredHistoryBaseline({ stored: active,
      scope: { scopeId: active.scopeId, keyEpoch: active.keyEpoch, key: decodeBlindBytes(contentKey) },
      trustedScopeAuthority: authority.scopeAuthoritySnapshot, ensureCurrent })
    try {
      const envelope = verified.envelope() as { payload: { locatorRoot: ArchiveLocatorRoot } }
      return { contentKey, root: envelope.payload.locatorRoot }
    } finally { verified.free() }
  })
  ensureCurrent()
  await retainWorkspaceRecoveryArchives(owner, config.workspaceId, active.stageId, [{ kind: "archive-source",
    id: `offline:${active.baselineId}`, workspaceId: config.workspaceId, scopeId: active.scopeId, keyEpoch: active.keyEpoch,
    key: reading.contentKey, signedJson: toBase64Url(active.signedJson), roots: [reading.root],
    authorityEvidence: { pinnedStorage: structuredClone(active.pinnedStorage) } }], ensureCurrent)
}
