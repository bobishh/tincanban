import { defaultStorage } from "../storage"
import { HistoryCaptureSourceChangedError } from "./historyCheckpointSource"
import { load, getHeads, free } from "@automerge/automerge/slim"
import { createArchiveRemote } from "@meta-uber/mesh-replication/history-archive-remote"
import { captureArchiveCoverageAuthority } from "@meta-uber/mesh-replication/history-archive-coverage"
import type { useTincanban } from "../state"
import { readWorkspaceBasisSnapshot } from "../storageJournal"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { openWithReplicaContentKeys } from "./replicaContentKeys"
import { readPublishedHistoryBaseline, readPreparedHistoryPublication, commitPreparedHistoryPublication } from "./historyBaselinePublicationRepository"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { verifyReceivedWireHistoryBaseline } from "../product-replica"
import { reverifyActiveHistoryForWorkspace } from "./historyBaselineStartup"
import type { BlindReplicaConfig } from "./blindReplication"
import type { CaptureCheckpointPort } from "./historyBaselineCapture"

type Input = { tincanban: ReturnType<typeof useTincanban>; config: BlindReplicaConfig; transitionId: string;
  previousBaselineId: string | null; scopeAuthority: unknown; ensureCurrent(): void | Promise<void>;
  ensureNativeCurrent(): void; fetch: typeof fetch; checkpointBeforeActivation?: CaptureCheckpointPort }
function heads(bytes: Uint8Array): string[] {
  const document = load(bytes)
  try { return getHeads(document).sort() } finally { free(document) }
}

/** Resume exact signed publication after a lost checkpoint reply; never mint a new baseline or widen its source fence. */
export async function resumePublishedHistoryBaseline(input: Input) {
  const prepared = await readPreparedHistoryPublication(input.config.workspaceId, input.transitionId, input.ensureNativeCurrent)
  const publication = prepared ? { wire: prepared.wire, baselineId: (JSON.parse(new TextDecoder().decode(decodeBlindBytes(prepared.wire.signedJson))) as { payload: { baselineId: string } }).payload.baselineId } :
    await readPublishedHistoryBaseline(input.config.workspaceId, input.config, input.ensureNativeCurrent)
  if (!publication) return undefined
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBlindBytes(publication.wire.signedJson))) as {
    payload: { transitionId: string; baselineId: string; previousBaselineId: string | null; sourceHeads: string[];
      storage: { keyEpoch: number; authority: Parameters<typeof captureArchiveCoverageAuthority>[0] } }
  }
  if (envelope.payload.transitionId !== input.transitionId) return undefined
  const payload = envelope.payload
  const config = input.config
  const pin = captureArchiveCoverageAuthority(payload.storage.authority)
  if (payload.previousBaselineId !== input.previousBaselineId || pin.scopeId !== config.scopeId ||
      pin.servicePublicKey !== config.servicePublicKey || pin.policyRevision > config.policyRevision) {
    throw new Error("Pending published history differs from its original transition")
  }
  const repository = createReceivedHistoryBaselineRepository(config.workspaceId, input.ensureNativeCurrent)
  const active = await repository.readActive()
  const previous = active && active.baselineId !== publication.baselineId
    ? await reverifyActiveHistoryForWorkspace(config.workspaceId, input.tincanban.getCurrentProfile()!.identity.personId, input.ensureNativeCurrent) : null
  try {
    const remote = createArchiveRemote(config, { fetch: input.fetch, ensureCurrent: input.ensureCurrent })
    return await openWithReplicaContentKeys(config, payload.storage.keyEpoch, async contentKey => {
      const key = decodeBlindBytes(contentKey)
      const candidate = await verifyReceivedWireHistoryBaseline({ wire: publication.wire,
        scope: { scopeId: config.scopeId, keyEpoch: payload.storage.keyEpoch, key }, pinnedStorage: pin,
        trustedScopeAuthority: input.scopeAuthority, previous, fetch: { download: remote.download, ensureCurrent: input.ensureCurrent },
        ensureCurrent: input.ensureNativeCurrent })
      try {
        await defaultStorage.withWorkspaceTransaction(config.workspaceId, async transaction => {
          const currentActive = await repository.readActive()
          if (currentActive?.baselineId !== publication.baselineId) {
            await assertSourceUnchanged(input, payload.sourceHeads, publication.baselineId)
            const staged = await repository.readStaged()
            if (staged && staged.baselineId !== publication.baselineId) throw new Error("Another history basis is staged")
            const stageId = staged?.stageId ?? await repository.stage(candidate,
              await readWorkspaceBasisSnapshot(config.workspaceId) ?? null, publication.wire)
            await input.checkpointBeforeActivation?.(candidate, publication.wire)
            await assertSourceUnchanged(input, payload.sourceHeads, publication.baselineId)
            if (prepared) await commitPreparedHistoryPublication(config.workspaceId, input.transitionId, input.ensureNativeCurrent)
            await repository.activate(stageId, candidate, transaction)
          }
        })
        await input.ensureCurrent()
        return publication
      } finally { candidate.free(); key.fill(0) }
    })
  } finally { previous?.free() }
}
async function assertSourceUnchanged(input: Input, expectedHeads: string[], baselineId: string) {
  const bytes = await input.tincanban.readWorkspaceBytes(input.config.workspaceId)
  await input.ensureCurrent()
  if (heads(bytes).join() !== [...expectedHeads].sort().join()) {
    throw new HistoryCaptureSourceChangedError(baselineId)
  }
}
