import { load, getHeads, getChangesMetaSince, free } from "@automerge/automerge/slim"
import { createArchiveRemote } from "@meta-uber/mesh-replication/history-archive-remote"
import { defaultStorage } from "../storage"
import { decodeBlindBytes } from "./blindEnvelope"
import { fetchBlind } from "./blindClient"
import { openWithReplicaContentKeys } from "./replicaContentKeys"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

function descendsFromBasis(document: Uint8Array, basis: WasmVerifiedReceivedHistoryBaseline): boolean {
  const compact = load(basis.document()), incoming = load(document)
  try {
    const roots = getHeads(compact)
    if (roots.length !== 1) throw new Error("Verified compact basis has an invalid root")
    return getChangesMetaSince(incoming, []).some(change => change.hash === roots[0])
  } finally { free(compact); free(incoming) }
}

/** Cold cursors may encounter original snapshots retained before the installed compact epoch. */
export async function isCoveredBlindHistoricalSnapshot(input: {
  config: BlindReplicaConfig; owner: string; document: Uint8Array; guardIdentity(): void; ensureCurrent(): Promise<void>
}): Promise<boolean> {
  const document = input.document.slice()
  await input.ensureCurrent()
  let basis = await defaultStorage.getVerifiedReceivedHistoryBaseline(input.config.workspaceId, input.guardIdentity)
  let owned = false
  if (!basis) {
    basis = await (await import("./historyBaselineStartup")).reverifyActiveHistoryForWorkspace(
      input.config.workspaceId, input.owner, input.guardIdentity) ?? undefined
    owned = Boolean(basis)
  }
  try {
    await input.ensureCurrent()
    if (!basis || descendsFromBasis(document, basis)) return false
    const payload = (basis.envelope() as { payload: { workspaceId: string; storage: {
      keyEpoch: number; authority: { scopeId: string; servicePublicKey: string; policyRevision: number } } } }).payload
    const { config } = input
    if (payload.workspaceId !== config.workspaceId || payload.storage.authority.scopeId !== config.scopeId ||
        payload.storage.authority.servicePublicKey !== config.servicePublicKey || payload.storage.authority.policyRevision > config.policyRevision) {
      throw new Error("Historical snapshot archive differs from the pinned Rusty scope")
    }
    const remote = createArchiveRemote(config, { fetch: fetchBlind, ensureCurrent: input.ensureCurrent })
    await openWithReplicaContentKeys(config, payload.storage.keyEpoch, async contentKey => {
      const key = decodeBlindBytes(contentKey)
      const reader = (await import("./historyArchiveReader")).createHistoryArchiveReader({ basis: basis!,
        scope: { scopeId: config.scopeId, keyEpoch: payload.storage.keyEpoch, key },
        fetch: { download: remote.download, ensureCurrent: input.ensureCurrent }, ensureCurrent: input.guardIdentity })
      try { await reader.verifyArchivedSnapshot(document) }
      finally { reader.dispose(); key.fill(0) }
    })
    await input.ensureCurrent()
    return true
  } finally { if (owned) basis?.free() }
}
