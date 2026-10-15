import { createDeviceAccessRefresh } from "./privateDeviceAccessRefresh"
import { createReplicationState,clearReplicationSessionState } from "./privateReplicationState"
import { createPrivateReplicationActions } from "./privateReplicationActions"
import { onBeforeUnmount,watch } from "vue"
import type { useTincanban } from "../state"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { subscribeChat } from "../chat/service"
import { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import { defaultStorage } from "../storage"
import { requiresRustyPermissionMigration } from "./rustyPermissionMigration"
import { HISTORY_ACTIVE_BYTE_LIMIT,HISTORY_ACTIVE_CHANGE_LIMIT } from "../storageJournalRecords"

export type BlindReplicationController = ReturnType<typeof useBlindReplication>

/** Credentials remain in private local storage, never in the shared board. */
export function useBlindReplication(tincanban: ReturnType<typeof useTincanban>) {
  const state = createReplicationState()
  const { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, registeredDevices,
    pendingDeviceRevocations, revokedDeviceAccess, currentDeviceId, statuses, attachmentCoverage, now, busy, error, notice, historyNotices } = state
  let identity = ""
  let session = 0
  let running: Promise<void> | undefined
  let disposed = false
  const automaticHistoryCompactions = new Set<string>()
  const runtime = createPrivateReplicaRuntime(tincanban, { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, statuses, attachmentCoverage }, {
    identity: () => identity, epoch: () => session, disposed: () => disposed,
  })
  const deviceAccess = createDeviceAccessRefresh(tincanban, state, runtime,
    (owner, epoch) => identity === owner && session === epoch && !disposed)
  const { personId, profileBinding, replica, fetchAttachment } = runtime
  const canCompact = (owner: string, epoch: number) => identity === owner && session === epoch && !disposed && !busy.value
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
      void compactWorkspaceHistory(workspaceId).catch(() => undefined).finally(() => automaticHistoryCompactions.delete(workspaceId))
      return
    }
  }
  async function reload(owner: string, epoch: number) {
    await runtime.reload(owner, epoch)
    await deviceAccess.refresh(owner, epoch)
  }
  function syncNow(): Promise<void> {
    if (running) return running
    if (busy.value || !identity || disposed || configs.value.length + identityConfigs.value.length === 0) return Promise.resolve()
    busy.value = true
    error.value = ""
    notice.value = ""
    const owner = identity
    const epoch = session
    const isCurrent = () => !disposed && identity === owner && session === epoch
    const run = async () => {
      const { syncReplicaConnections, recordReplicaHealth } = await import("./replicaHealthRun")
      if (!isCurrent()) return
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
        }, isCurrent), "Profile"))
      if (!isCurrent()) return
      // A personal snapshot may introduce a workspace connection. Use it in this same pass.
      await reload(owner, epoch)
      failures.push(...await syncReplicaConnections([...configs.value], isCurrent, config =>
        recordReplicaHealth(config, statuses, async () => {
          if (config.purpose === "identity") throw new Error("Workspace scope required")
          return config.removalPending ? revoke(config) : (await replica(config)).sync()
        }, isCurrent), "Board"))
      if (!isCurrent()) return
      if (failures.length) error.value = failures.join("; ")
      else notice.value = "Configured encrypted replicas synchronized."
    }
    running = run().catch(cause => {
      if (isCurrent()) error.value = cause instanceof Error ? cause.message : "Rusty settings unavailable"
    }).finally(() => {
      running = undefined
      busy.value = false
      void maybeCompactActiveHistory(owner, epoch)
    })
    return running
  }
  const { attach, updateDeviceAccess, revokeIdentityDevice, recoverCredentialConflict, revoke, remove,
    exportAutomationAccess, compactWorkspaceHistory } = createPrivateReplicationActions(tincanban, state, runtime, {
      identity: () => identity, epoch: () => session, disposed: () => disposed, reload, syncNow,
    }, automaticHistoryCompactions)
  const stop = watch(profileBinding, async () => {
    const owner = tincanban.ready.value ? personId() : ""
    const epoch = ++session
    identity = owner
    clearReplicationSessionState(state)
    deviceAccess.reset()
    runtime.clear()
    if (!owner) return
    try {
      await running?.catch(() => {})
      await reload(owner, epoch)
      if (identity !== owner || session !== epoch || disposed) return
      await syncNow()
    } catch (cause) { error.value = cause instanceof Error ? cause.message : "Rusty settings unavailable" }
  }, { immediate: true })
  const healthClock = setInterval(() => { now.value = Date.now() }, 1000)
  const timer = setInterval(() => { void syncNow() }, 15000)
  const stopWorkspace = tincanban.subscribeLocalChanges(() => { void syncNow() })
  const stopChat = subscribeChat(() => { void syncNow() })
  const stopPreferences = subscribeIdentityDevicePreferences(owner => {
    if (owner !== identity || disposed) return
    const epoch = session
    void (async () => {
      await running?.catch(() => {})
      await reload(owner, epoch)
      if (owner === identity && session === epoch && !disposed) await syncNow()
    })().catch(cause => { if (owner === identity && session === epoch && !disposed) error.value = cause instanceof Error ? cause.message : "Rusty settings unavailable" })
  })
  onBeforeUnmount(() => { disposed = true; stop(); clearInterval(timer); clearInterval(healthClock); stopWorkspace(); stopChat(); stopPreferences() })
  return { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, registeredDevices,
    pendingDeviceRevocations, revokedDeviceAccess, currentDeviceId, statuses, attachmentCoverage, now, busy, error, notice, historyNotices,
    attach, updateDeviceAccess, revokeIdentityDevice, recoverCredentialConflict, exportAutomationAccess, compactWorkspaceHistory,
    remove, syncNow, fetchAttachment }
}
