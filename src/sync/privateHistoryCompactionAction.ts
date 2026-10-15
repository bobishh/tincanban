import type { useTincanban } from "../state"
import type { PrivateReplicationState } from "./privateReplicationState"
import type { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import type { ReplicationLifecycle } from "./privateReplicationActions"
import type { BlindReplicaConfig } from "./blindReplication"
import { defaultStorage } from "../storage"

export function createHistoryCompactionAction(tincanban: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: ReturnType<typeof createPrivateReplicaRuntime>, lifecycle: ReplicationLifecycle, automaticHistoryCompactions: Set<string>) {
  const { configs, busy, error, notice, historyNotices } = state
  return async function compactWorkspaceHistory(workspaceId: string): Promise<void> {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const owner = lifecycle.identity(), epoch = lifecycle.epoch(), guard = runtime.captureSession(workspaceId, owner, epoch)
    guard()
    delete historyNotices.value[workspaceId]
    await lifecycle.syncNow()
    guard()
    if (error.value) throw new Error(error.value)
    const matches = configs.value.filter(config => config.workspaceId === workspaceId && !config.removalPending)
    if (matches.length !== 1) throw new Error("History compaction requires one active Rusty connection for this board")
    const config = JSON.parse(JSON.stringify(matches[0]!)) as BlindReplicaConfig
    busy.value = true
    automaticHistoryCompactions.add(workspaceId)
    error.value = ""
    notice.value = ""
    let pendingTransition: { transitionId: string; previousBaselineId: string | null } | undefined
    let attemptId = ""
    try {
      const { coordinateWorkspaceHistoryBaseline } = await import("./historyBaselineTransition")
      const { assertHistoryStorageCheckpointSupport } = await import("./blindHistoryCheckpoint")
      await assertHistoryStorageCheckpointSupport(config, guard)
      const transition = await defaultStorage.claimHistoryTransitionId(workspaceId)
      pendingTransition = transition
      const { currentHistoryCaptureAttempt } = await import("./historyCaptureAttempt")
      attemptId = await currentHistoryCaptureAttempt(workspaceId, transition.transitionId, guard)
      guard()
      await coordinateWorkspaceHistoryBaseline({ app: tincanban, config, transitionId: transition.transitionId,
        previousBaselineId: transition.previousBaselineId, ports: {
        ensureCurrent: guard,
        ensureNativeCurrent: guard,
        captureTransitionId: attemptId,
        checkpointBeforeActivation: async (candidate, wire) => {
          guard()
          const baselineId = (candidate.envelope() as { payload: { baselineId: string } }).payload.baselineId
          const replica = await runtime.replica(config)
          if (!replica.checkpointHistoryBaseline) throw new Error("History checkpoint requires a workspace replica")
          await replica.checkpointHistoryBaseline(owner, attemptId, baselineId, candidate, wire)
          guard()
        },
        checkpointPublishedBaseline: async baselineId => {
          guard()
          if (tincanban.getActiveDoc()?.id !== workspaceId) throw new Error("Keep this workspace open to finish its history checkpoint")
          await tincanban.switchWorkspace(workspaceId)
          guard()
          const replica = await runtime.replica(config)
          if (!replica.checkpointHistoryBaseline) throw new Error("History checkpoint requires a workspace replica")
          await replica.checkpointHistoryBaseline(owner, attemptId, baselineId)
          guard()
        },
        drainOwner: async () => {
          guard()
          const ownerReplica = await runtime.replica(config)
          await ownerReplica.sync()
          guard()
          if (!ownerReplica.flushCurrentSnapshot) throw new Error("Workspace history requires a workspace replica")
          await ownerReplica.flushCurrentSnapshot()
          guard()
          if (!ownerReplica.pull || !await ownerReplica.pull()) throw new Error("Rusty must catch up before capturing history. Retry sync.")
          guard()
          const { getPrivateReplicaProgress } = await import("./privateReplicaRepository")
          const progress = await getPrivateReplicaProgress(owner, config)
          guard()
          if (progress.pending) throw new Error("Original Rusty outbox is still pending before history capture")
          const { recordHistoryStorageFence } = await import("./blindHistoryCheckpoint")
          await recordHistoryStorageFence(owner, config, attemptId, progress.cursor, guard)
        },
      } })
      guard()
      if (tincanban.getActiveDoc()?.id === workspaceId) {
        await tincanban.switchWorkspace(workspaceId)
        guard()
      }
      await defaultStorage.completeHistoryTransition(workspaceId, transition.transitionId)
      guard()
      notice.value = "Older history archived. Previous versions remain available."
      historyNotices.value[workspaceId] = notice.value
    } catch (cause) {
      await recoverHistoryCaptureConflict(cause, { owner, config, workspaceId, attemptId,
        transitionId: pendingTransition?.transitionId, guard })
      if (owner === lifecycle.identity() && epoch === lifecycle.epoch() && !lifecycle.disposed()) {
        error.value = cause instanceof Error ? cause.message : "Could not compact workspace history"
      }
      throw cause
    } finally { busy.value = false; automaticHistoryCompactions.delete(workspaceId) }
  }
}

async function recoverHistoryCaptureConflict(cause: unknown, input: { owner: string; config: BlindReplicaConfig; workspaceId: string;
  attemptId: string; transitionId?: string; guard: () => void }): Promise<void> {
  if (!input.transitionId || !input.attemptId) return
  const { HistoryStorageCheckpointConflictError, historyCheckpointDeliveryPrepared } = await import("./blindHistoryCheckpoint")
  const { HistoryCaptureSourceChangedError } = await import("./historyCheckpointSource")
  let baselineId: string | undefined
  if (cause instanceof HistoryStorageCheckpointConflictError) baselineId = cause.baselineId
  else if (cause instanceof HistoryCaptureSourceChangedError &&
      !await historyCheckpointDeliveryPrepared(input.owner, input.config, input.attemptId, input.guard)) baselineId = cause.baselineId
  if (!baselineId) return
  input.guard()
  const { createReceivedHistoryBaselineRepository } = await import("./receivedHistoryBaselineRepository")
  await createReceivedHistoryBaselineRepository(input.workspaceId, input.guard).retainCheckpointConflictCandidate(baselineId)
  const { restartConflictedHistoryCapture } = await import("./historyCaptureAttempt")
  await restartConflictedHistoryCapture(input.workspaceId, input.transitionId, input.attemptId, input.guard)
}
