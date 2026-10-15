import { load, getHeads, free } from "@automerge/automerge/slim"
import { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import { createArchiveRemote } from "@meta-uber/mesh-replication/history-archive-remote"
import { readArchiveIndex, type ArchiveTreeContext, type ArchiveIndexRoot } from "@meta-uber/mesh-replication/history-archive"
import { createLocatedArchiveStore, type ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"
import { captureArchiveCoverageAuthority } from "@meta-uber/mesh-replication/history-archive-coverage"
import type { useTincanban } from "../state"
import { readWorkspaceBasisSnapshot } from "../storageJournal"
import { defaultStorage } from "../storage"
import { decodeBlindBytes } from "./blindEnvelope"
import { contentKeysForEpoch, openWithReplicaContentKeys } from "./replicaContentKeys"
import { fetchBlind } from "./blindClient"
import { peerStore } from "./peerStore"
import { mergeCurrentBlindHistory } from "./blindCurrentHistory"
import { receiveBrowserHistoryBaseline } from "./browserHistoryBaselineReceive"
import type { BlindReplicaConfig } from "./blindReplication"
import type { getPrivateReplicaProgress } from "./privateReplicaRepository"
import type { createBlindSnapshotRevision } from "./blindSnapshotRevision"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { WireHistoryBaseline } from "./historyBaselineReceiver"

type ActiveRouteRepository = { recordActiveWireRoute(id: string, signedJson: Uint8Array, wire: WireHistoryBaseline): Promise<void> }

function persistCurrentWireRoute(repository: ActiveRouteRepository, previous: WasmVerifiedReceivedHistoryBaseline | undefined,
  wire: WireHistoryBaseline) {
  return async () => {
    if (!previous) throw new Error("Current Native history baseline is unavailable")
    const baselineId = (previous.envelope() as { payload?: { baselineId?: unknown } }).payload?.baselineId
    if (typeof baselineId !== "string") throw new Error("Current Native history baseline is malformed")
    await repository.recordActiveWireRoute(baselineId, previous.originalJson(), wire)
  }
}

export type ReceiveContext = { config: BlindReplicaConfig; tincanban: ReturnType<typeof useTincanban>; owner: string;
  guardIdentity: () => void; readReplicaProgress: () => ReturnType<typeof getPrivateReplicaProgress>;
  readSnapshotRevision: ReturnType<typeof createBlindSnapshotRevision> }

/** The history receiver shares the exact private replica generation and current-device guards. */
export async function receiveBlindReplicaHistory(context: ReceiveContext, id: string, bytes: Uint8Array, authorization: unknown, history: unknown) {
  const { config, tincanban, owner, guardIdentity, readReplicaProgress, readSnapshotRevision } = context
  guardIdentity()
  if (id !== config.workspaceId) throw new Error("History baseline workspace changed during Rusty replication")
  const trustedRecord = await peerStore.getWorkspaceAuthority(id) ?? await peerStore.getWorkspaceCredential(id)
  guardIdentity()
  const trustedScopeAuthority = trustedRecord?.scopeAuthoritySnapshot
  if (!trustedScopeAuthority) throw new Error("Received history requires an independently admitted signed scope authority")
  const admittedScope = WasmStateCore.validateScopeAuthority(trustedScopeAuthority, Date.now()) as { scopeId?: unknown }
  if (admittedScope.scopeId !== config.workspaceId) throw new Error("Admitted workspace authority differs from the requested board")
  const repositoryModule = await import("./receivedHistoryBaselineRepository")
  guardIdentity()
  const repository = repositoryModule.createReceivedHistoryBaselineRepository(id, guardIdentity)
  let previous = await defaultStorage.getVerifiedReceivedHistoryBaseline(id, guardIdentity)
  let ownedPrevious = false
  if (!previous && await repository.readActive()) {
    previous = await (await import("./historyBaselineStartup")).reverifyActiveHistoryForWorkspace(id, owner, guardIdentity) ?? undefined
    ownedPrevious = Boolean(previous)
  }
  guardIdentity()
  if (previous) assertCurrentHistoryStorage(previous, config)
  const remote = createArchiveRemote({ origin: config.origin, scopeId: config.scopeId, servicePublicKey: config.servicePublicKey,
    readToken: config.readToken, writeToken: config.writeToken, policyRevision: config.policyRevision },
    { fetch: fetchBlind, ensureCurrent: async () => { guardIdentity(); await readReplicaProgress(); guardIdentity() } })
  const archiveFetch = { ensureCurrent: async () => { guardIdentity(); await readReplicaProgress(); guardIdentity() },
    download: async (ciphertextId: string) => {
      guardIdentity(); await readReplicaProgress(); guardIdentity()
      const object = await remote.download(ciphertextId)
      guardIdentity(); await readReplicaProgress(); guardIdentity()
      return object
    } }
  const wire = (await import("./historyBaselineReceiver")).parseWireHistoryBaseline(history)
  try {
    if (await mergeCurrentBlindHistory({ previous, signedJson: wire.signedJson, document: bytes, authorization,
      ensureCurrent: async () => { guardIdentity(); await readReplicaProgress(); guardIdentity() },
      onSameBaseline: persistCurrentWireRoute(repository, previous, wire),
      merge: (document, evidence, basis) => tincanban.mergeAuthorizedWorkspace(id, document, evidence, undefined, basis) })) return
    await receiveBrowserHistoryBaseline({ workspaceId: id, config, wire, document: bytes, authorization,
    trustedScopeAuthority, previous, fetch: archiveFetch, ports: {
      ensureCurrent: async () => { guardIdentity(); await readReplicaProgress(); guardIdentity() },
      readLocal: async () => {
        guardIdentity()
        const [localBytes, revision, historyRevision, progress] = await Promise.all([
          tincanban.readWorkspaceBytes(id), readSnapshotRevision(id),
          (async () => {
            const publications = await import("./historyBaselinePublicationRepository")
            return (await publications.readPublishedHistoryBaseline(id, config, guardIdentity))?.baselineId
          })(), readReplicaProgress(),
        ])
        guardIdentity()
        const document = load(localBytes)
        let heads: string[]
        try { heads = getHeads(document).sort() } finally { free(document) }
        if (revision === undefined) throw new Error("Local workspace revision is unavailable during history receive")
        return { bytes: localBytes.slice(), heads, revision,
          catalogRevision: historyRevision ?? undefined,
          pending: Boolean(progress.pending) }
      },
      verify: async input => {
        const parsed = (await import("./historyBaselineReceiver")).parseWireHistoryBaseline(input.wire)
        const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBlindBytes(parsed.signedJson))) as {
          payload?: { workspaceId?: unknown; storage?: { keyEpoch?: unknown; authority?: unknown } }
        }
        const payload = envelope.payload
        const storage = payload?.storage
        if (payload?.workspaceId !== id || !storage || !Number.isSafeInteger(storage.keyEpoch) ||
            (storage.keyEpoch as number) < 1 || !storage.authority) {
          throw new Error("History baseline routing is invalid for the pinned workspace")
        }
        const keyEpoch = storage.keyEpoch as number
        const pinnedStorage = captureArchiveCoverageAuthority(storage.authority as Parameters<typeof captureArchiveCoverageAuthority>[0])
        if (pinnedStorage.scopeId !== config.scopeId || pinnedStorage.servicePublicKey !== config.servicePublicKey ||
            pinnedStorage.policyRevision > config.policyRevision) throw new Error("History baseline is outside the pinned Rusty scope")
        const candidates = contentKeysForEpoch(config, keyEpoch)
        let failure: unknown
        for (const contentKey of candidates) {
          guardIdentity(); await readReplicaProgress(); guardIdentity()
          const key = decodeBlindBytes(contentKey)
          try {
            return await (await import("./historyBaselineReceiver")).verifyReceivedWireHistoryBaseline({ wire: parsed,
              scope: { scopeId: config.scopeId, keyEpoch, key }, pinnedStorage,
              trustedScopeAuthority, previous, fetch: archiveFetch,
              ensureCurrent: () => { guardIdentity() } })
          } catch (error) { failure = error } finally { key.fill(0) }
        }
        throw failure ?? new Error("History baseline content key is unavailable")
      },
      coversHeads: async (candidate, heads) => {
        const envelope = candidate.envelope() as { payload: { archive: { context: ArchiveTreeContext; root: ArchiveIndexRoot };
          locatorRoot: ArchiveLocatorRoot; storage: { keyEpoch: number } } }
        const payload = envelope.payload
        await openWithReplicaContentKeys(config, payload.storage.keyEpoch, async contentKey => {
          const key = decodeBlindBytes(contentKey)
          try {
            const scope = { scopeId: config.scopeId, keyEpoch: payload.storage.keyEpoch, key }
            const archiveStore = createLocatedArchiveStore(scope, payload.locatorRoot, archiveFetch)
            for (const head of heads) {
              guardIdentity(); await readReplicaProgress(); guardIdentity()
              const entryKey = `change/${head}`
              const page = await readArchiveIndex(payload.archive.context, payload.archive.root, archiveStore, { prefix: entryKey, limit: 2 })
              if (!page.entries.some(entry => entry.key === entryKey)) throw new Error("Owner baseline does not cover a local workspace head")
            }
          } finally { key.fill(0) }
        })
        guardIdentity()
      },
      repository, readExpectedSnapshot: async () => (await readWorkspaceBasisSnapshot(id)) ?? null,
      accept: candidate => defaultStorage.acceptVerifiedReceivedHistoryBaseline(candidate, guardIdentity),
      merge: async (document, authorization, candidate) => {
        guardIdentity()
        await tincanban.mergeAuthorizedWorkspace(id, document, authorization, undefined, candidate)
        guardIdentity()
      },
    } })
  } finally { if (ownedPrevious) previous?.free() }
  guardIdentity()
}

function assertCurrentHistoryStorage(basis: NonNullable<Awaited<ReturnType<typeof defaultStorage.getVerifiedReceivedHistoryBaseline>>>, config: BlindReplicaConfig) {
  const payload = (basis.envelope() as { payload?: { workspaceId?: unknown; storage?: { authority?: {
    scopeId?: unknown; servicePublicKey?: unknown; policyRevision?: unknown } } } }).payload
  const storage = payload?.storage?.authority
  if (payload?.workspaceId !== config.workspaceId || storage?.scopeId !== config.scopeId ||
      storage.servicePublicKey !== config.servicePublicKey || !Number.isSafeInteger(storage.policyRevision) ||
      (storage.policyRevision as number) > config.policyRevision) throw new Error("Current history is outside the pinned Rusty scope")
}
