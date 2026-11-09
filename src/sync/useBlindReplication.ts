import { createDeviceAccessRefresh } from "./privateDeviceAccessRefresh"
import { createReplicationState,clearReplicationSessionState,reportDeviceSyncProblem } from "./privateReplicationState"
import { createPrivateReplicationActions } from "./privateReplicationActions"
import { createPrivateReplicaUserActions } from "./privateReplicaUserActions"
import { createReplicationFollowUp, startPrivateReplicationTriggers } from "./privateReplicationTriggers"
import { computed,onBeforeUnmount,shallowRef,watch } from "vue"
import type { useTincanban } from "../state"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import type { createBoardFreshness } from "./replicaHealthRun"
import type { BoardFreshness } from "./replicationHealth"
import { defaultStorage } from "../storage"
import { requiresRustyPermissionMigration } from "./rustyPermissionMigration"
import { HISTORY_ACTIVE_BYTE_LIMIT,HISTORY_ACTIVE_CHANGE_LIMIT } from "../storageJournalRecords"

export type BlindReplicationController = ReturnType<typeof useBlindReplication>

/** Credentials remain in private local storage, never in the shared board. */
export function useBlindReplication(tincanban: ReturnType<typeof useTincanban>) {
  const state = createReplicationState()
  const { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, registeredDevices,
    pendingDeviceRevocations, revokedDeviceAccess, currentDeviceId, pendingRustyOperations, statuses, deviceSyncIssues, attachmentCoverage, now, busy, error, notice, historyNotices } = state
  let identity = "", session = 0, disposed = false
  let running: Promise<void> | undefined, automaticCompaction: Promise<void> | undefined
  const freshness = shallowRef<ReturnType<typeof createBoardFreshness>>()
  const followUp = createReplicationFollowUp()
  const automaticHistoryCompactions = new Set<string>()
  const runtime = createPrivateReplicaRuntime(tincanban, { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, statuses, deviceSyncIssues, attachmentCoverage }, {
    identity: () => identity, epoch: () => session, disposed: () => disposed,
  })
  const deviceAccess = createDeviceAccessRefresh(tincanban, state, runtime,
    (owner, epoch) => identity === owner && session === epoch && !disposed)
  const { personId, profileBinding, replica, fetchAttachment } = runtime
  const { busy: actionBusy, protect, syncNow: requestSyncNow } = createPrivateReplicaUserActions(
    () => Promise.all([running, automaticCompaction]), () => runtime.captureSession(tincanban.activeWorkspace.id),
    () => syncNow(true), () => { void maybeCompactActiveHistory(identity, session) })
  const canCompact = (owner: string, epoch: number) => identity === owner && session === epoch && !disposed && !busy.value && !actionBusy.value && !automaticCompaction && !hasActiveTextEditor()
  async function maybeCompactActiveHistory(owner: string, epoch: number) {
    if (!canCompact(owner, epoch)) return
    const workspaces = [...new Set(configs.value.filter(config => !config.removalPending).map(config => config.workspaceId))]
    for (const workspaceId of workspaces) {
      if (!canCompact(owner, epoch)) return
      const matches = configs.value.filter(config => config.workspaceId === workspaceId && !config.removalPending)
      if (matches.length !== 1 || automaticHistoryCompactions.has(workspaceId)) continue
      const progress = await defaultStorage.ensureHistoryProgress(workspaceId)
      if (!canCompact(owner, epoch)) return
      if (!progress.transitionId && (progress.admittedChanges < HISTORY_ACTIVE_CHANGE_LIMIT &&
          progress.encodedBytes < HISTORY_ACTIVE_BYTE_LIMIT)) continue
      automaticHistoryCompactions.add(workspaceId)
      automaticCompaction = compactWorkspaceHistory(workspaceId).catch(() => undefined).finally(() => {
        automaticHistoryCompactions.delete(workspaceId); automaticCompaction = undefined
      })
      return
    }
  }
  async function reload(owner: string, epoch: number) {
    await runtime.reload(owner, epoch)
    await deviceAccess.refresh(owner, epoch)
  }
  function syncNow(duringAction = false): Promise<void> {
    if (running) { followUp.request(); return running }
    if (busy.value || (actionBusy.value && !duringAction) || !identity || disposed || (configs.value.length + identityConfigs.value.length === 0 && !deviceSyncIssues.value.session)) return Promise.resolve()
    busy.value = true; error.value = ""
    deviceSyncIssues.value = Object.fromEntries(Object.entries(deviceSyncIssues.value).filter(([key]) => key !== "session"))
    notice.value = ""
    const owner = identity, epoch = session
    const isCurrent = () => !disposed && identity === owner && session === epoch
    const run = async () => {
      const { syncReplicaConnections, recordReplicaHealth, createBoardFreshness } = await import("./replicaHealthRun")
      if (!isCurrent()) return
      const boardChecks = freshness.value ??= createBoardFreshness(configs, now, () => identity, () => tincanban.activeWorkspace.id)
      if (!configs.value.length && !identityConfigs.value.length) await reload(owner, epoch)
      const failures = await runtime.provision(owner, epoch)
      failures.push(...await syncReplicaConnections([...identityConfigs.value], isCurrent, config =>
        recordReplicaHealth(config, statuses, async () => {
          if (config.removalPending) throw new Error("Private connection removal is pending")
          try { return await (await replica(config)).sync() }
          catch (cause) {
            if (isCurrent() && requiresRustyPermissionMigration(cause)) {
              profilePermissionUpdates.value = [...new Set([...profilePermissionUpdates.value, config.origin])]
            }
            throw cause
          }
        }, isCurrent, deviceSyncIssues), "Profile"))
      if (!isCurrent()) return
      // A personal snapshot may introduce a workspace connection. Use it in this same pass.
      await reload(owner, epoch)
      failures.push(...await syncReplicaConnections([...configs.value], isCurrent, config =>
        recordReplicaHealth(config, statuses, () => config.removalPending ? revoke(config)
          : boardChecks.check(config, isCurrent, async observeRead => (await replica(config)).sync(observeRead)), isCurrent, deviceSyncIssues), "Board"))
      if (!isCurrent()) return
      void runtime.runWriterMaintenance(owner, epoch)
      if (failures.length) error.value = failures.join("; ")
      else if (!Object.keys(deviceSyncIssues.value).length) notice.value = "Configured encrypted replicas synchronized."
    }
    running = run().catch(cause => { if (isCurrent()) reportDeviceSyncProblem(state, cause) }).finally(() => {
      running = undefined
      busy.value = false
      const retry = followUp.next(Object.values(statuses.value).some(status => status.phase === "catching-up"))
      void maybeCompactActiveHistory(owner, epoch)
      if (isCurrent() && retry) void syncNow()
    })
    return running
  }
  const actions = createPrivateReplicationActions(tincanban, state, runtime, {
      identity: () => identity, epoch: () => session, disposed: () => disposed, reload, syncNow: () => syncNow(true),
    }, automaticHistoryCompactions)
  const { revoke, compactWorkspaceHistory, exportAutomationAccess } = actions
  // SDK approval refresh can replace the active profile without changing its credentials.
  const stop = watch([profileBinding, () => tincanban.getCurrentProfile()], async ([binding], previous) => {
    const owner = tincanban.ready.value ? personId() : ""
    const epoch = ++session
    identity = owner
    freshness.value?.reset()
    if (!binding || binding !== previous?.[0]) clearReplicationSessionState(state)
    deviceAccess.reset()
    runtime.clear()
    if (!owner) return
    try {
      await running?.catch(() => {})
      await reload(owner, epoch)
      if (identity !== owner || session !== epoch || disposed) return
      await syncNow()
    } catch (cause) { if (identity === owner && session === epoch && !disposed) reportDeviceSyncProblem(state, cause) }
  }, { immediate: true })
  const stopTriggers = startPrivateReplicationTriggers(tincanban, now, syncNow, () => freshness.value?.reset())
  const stopPreferences = subscribeIdentityDevicePreferences(owner => {
    if (owner !== identity || disposed) return
    const epoch = session
    void (async () => {
      await running?.catch(() => {})
      await reload(owner, epoch)
      if (owner === identity && session === epoch && !disposed) await syncNow()
    })().catch(cause => { if (owner === identity && session === epoch && !disposed) reportDeviceSyncProblem(state, cause) })
  })
  onBeforeUnmount(() => { disposed = true; stop(); stopTriggers(); stopPreferences() })
  return { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, registeredDevices,
    pendingDeviceRevocations, revokedDeviceAccess, currentDeviceId, pendingRustyOperations, statuses, deviceSyncIssues, attachmentCoverage, boardFreshness: computed<BoardFreshness>(() => freshness.value?.status.value ?? { phase: "unknown" }), now, busy, actionBusy, error, notice, historyNotices,
    ...protect(actions), exportAutomationAccess, syncNow: requestSyncNow, fetchAttachment }
}

/** Automatic archive work waits while the user is editing; replica delivery keeps running. */
function hasActiveTextEditor(): boolean {
  const element = typeof document === "undefined" ? null : document.activeElement
  if (!element) return false
  if ("isContentEditable" in element && element.isContentEditable === true) return true
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true
  return element.tagName === "INPUT" && !/^(button|checkbox|radio|range|reset|submit|file|color|hidden|image)$/.test((element as HTMLInputElement).type)
}
