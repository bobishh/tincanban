import { createDeviceAccessRefresh } from "./privateDeviceAccessRefresh"
import { createReplicationState, clearReplicationSessionState, reportDeviceSyncProblem, type PrivateReplicationState } from "./privateReplicationState"
import { createPrivateReplicationActions } from "./privateReplicationActions"
import { createPrivateReplicaUserActions } from "./privateReplicaUserActions"
import { startPrivateReplicationTriggers } from "./privateReplicationTriggers"
import { computed, onBeforeUnmount, shallowRef, watch, type Ref } from "vue"
import type { useTincanban } from "../state"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import type { createBoardFreshness } from "./replicaHealthRun"
import type { BoardFreshness } from "./replicationHealth"
import { defaultStorage } from "../storage"
import type { BlindReplicaConfig } from "./blindReplication"
import { HISTORY_ACTIVE_BYTE_LIMIT, HISTORY_ACTIVE_CHANGE_LIMIT } from "../storageJournalRecords"
import type { createConfiguredRustyDelivery } from "./rustyDelivery"

export type BlindReplicationController = ReturnType<typeof useBlindReplication>
type App = ReturnType<typeof useTincanban>
type ReplicaRuntime = ReturnType<typeof createPrivateReplicaRuntime>
type Freshness = ReturnType<typeof createBoardFreshness>
type RustyDelivery = ReturnType<typeof createConfiguredRustyDelivery>

/** Credentials remain in private local storage, never in the shared board. */
export function useBlindReplication(tincanban: App) {
  const state = createReplicationState()
  const { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, registeredDevices,
    pendingDeviceRevocations, revokedDeviceAccess, currentDeviceId, pendingRustyOperations, statuses, deviceSyncIssues, attachmentCoverage, now, busy, error, notice, historyNotices } = state
  let identity = "", session = 0, disposed = false
  let isReserved = () => false
  const isLive = (owner: string, epoch: number) => identity === owner && session === epoch && !disposed
  const freshness = shallowRef<Freshness>()
  const runtime = createPrivateReplicaRuntime(tincanban, { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, statuses, deviceSyncIssues, attachmentCoverage }, {
    identity: () => identity, epoch: () => session, disposed: () => disposed,
  })
  const deviceAccess = createDeviceAccessRefresh(tincanban, state, runtime, (owner, epoch) => isLive(owner, epoch))
  const { personId, profileBinding, replica, fetchAttachment } = runtime
  const history = createActiveHistoryCompaction({ configs, busy, reserved: () => isReserved(), live: isLive })
  const reload = async (owner: string, epoch: number) => { await runtime.reload(owner, epoch); await deviceAccess.refresh(owner, epoch) }
  const link: { full: (duringAction?: boolean) => Promise<void> } = { full: () => Promise.resolve() }
  const actions = createPrivateReplicationActions(tincanban, state, runtime, {
    identity: () => identity, epoch: () => session, disposed: () => disposed, reload, syncNow: () => link.full(true),
  }, history.automatic)
  const { revoke, compactWorkspaceHistory, exportAutomationAccess } = actions
  const delivery = lazyRustyDelivery({
    state, activeWorkspaceId: () => tincanban.activeWorkspace.id, freshness,
    hasConfiguredWork: () => configs.value.length + identityConfigs.value.length > 0 || Boolean(deviceSyncIssues.value.session),
    capture: () => ({ owner: identity, epoch: session }), live: isLive, reserved: () => isReserved(), replica, revoke, reload,
    provision: (owner, epoch) => runtime.provision(owner, epoch),
    maintainWriters: (owner, epoch) => { void runtime.runWriterMaintenance(owner, epoch) },
    afterFullPass: (owner, epoch) => { void history.compact(owner, epoch, compactWorkspaceHistory) },
  })
  link.full = delivery.deliverFull
  const { busy: actionBusy, protect, syncNow: requestSyncNow } = createPrivateReplicaUserActions(
    () => Promise.all([delivery.currentPass(), history.pending()]), () => runtime.captureSession(tincanban.activeWorkspace.id),
    () => delivery.deliverFull(true), () => { void history.compact(identity, session, compactWorkspaceHistory) }, () => { delivery.releaseReservation() })
  isReserved = () => actionBusy.value
  const sessionView = () => ({ identity, session, disposed })
  const advance = (owner: string) => { const epoch = ++session; identity = owner; delivery.retire(); return epoch }
  const stop = watchRustyIdentity(tincanban, personId, profileBinding, state, freshness, runtime, deviceAccess, delivery, isLive, advance)
  const stopTriggers = startPrivateReplicationTriggers(now, () => delivery.deliverFull(), () => freshness.value?.reset())
  const stopPreferences = subscribeIdentityDevicePreferences(owner => {
    void refreshPrivatePreferences(owner, sessionView, reload, () => delivery.deliverFull(), () => delivery.currentPass(), cause => reportDeviceSyncProblem(state, cause))
  })
  onBeforeUnmount(() => { disposed = true; delivery.retire(); stop(); stopTriggers(); stopPreferences() })
  return { configs, identityConfigs, preferenceConflicts, profileSetupErrors, profilePermissionUpdates, registeredDevices,
    pendingDeviceRevocations, revokedDeviceAccess, currentDeviceId, pendingRustyOperations, statuses, deviceSyncIssues, attachmentCoverage,
    boardFreshness: computed<BoardFreshness>(() => freshness.value?.status.value ?? { phase: "unknown" }), now, busy, actionBusy, error, notice, historyNotices,
    ...protect(actions), exportAutomationAccess, syncNow: requestSyncNow, syncWorkspace: delivery.deliverBoard, fetchAttachment }
}

function lazyRustyDelivery(input: Parameters<typeof createConfiguredRustyDelivery>[0]): RustyDelivery {
  let delivery: RustyDelivery | undefined
  let loading: Promise<RustyDelivery> | undefined

  function invoke(run: (ready: RustyDelivery) => Promise<void>): Promise<void> {
    if (delivery) return run(delivery)
    const { owner, epoch } = input.capture()
    if (!owner || !input.hasConfiguredWork()) return Promise.resolve()
    loading ??= import("./rustyDelivery").then(module => delivery = module.createConfiguredRustyDelivery(input))
      .finally(() => { loading = undefined })
    return loading.then(ready => input.live(owner, epoch) ? run(ready) : undefined,
      cause => { if (input.live(owner, epoch)) reportDeviceSyncProblem(input.state, cause) })
  }

  return {
    deliverBoard: intent => invoke(ready => ready.deliverBoard(intent)),
    deliverFull: duringAction => invoke(ready => ready.deliverFull(duringAction)),
    currentPass: () => delivery?.currentPass() ?? loading?.then(ready => ready.currentPass(), () => undefined) ?? Promise.resolve(),
    releaseReservation: () => { delivery?.releaseReservation() },
    retire: () => { delivery?.retire() },
  }
}

function watchRustyIdentity(tincanban: App, personId: () => string, profileBinding: ReplicaRuntime["profileBinding"], state: PrivateReplicationState, freshness: Ref<Freshness | undefined>, runtime: ReplicaRuntime, deviceAccess: ReturnType<typeof createDeviceAccessRefresh>, delivery: RustyDelivery, live: (owner: string, epoch: number) => boolean, advance: (owner: string) => number) {
  return watch([profileBinding, () => tincanban.getCurrentProfile()], async ([binding], previous) => {
    const owner = tincanban.ready.value ? personId() : ""
    const epoch = advance(owner)
    freshness.value?.reset()
    if (!binding || binding !== previous?.[0]) clearReplicationSessionState(state)
    deviceAccess.reset()
    runtime.clear()
    if (!owner) return
    try {
      await delivery.currentPass().catch(() => {})
      await runtime.reload(owner, epoch)
      if (!live(owner, epoch)) return
      await Promise.all([delivery.deliverFull(), deviceAccess.refresh(owner, epoch)])
    } catch (cause) { if (live(owner, epoch)) reportDeviceSyncProblem(state, cause) }
  }, { immediate: true })
}

async function refreshPrivatePreferences(owner: string, current: () => { identity: string; session: number; disposed: boolean }, reload: (owner: string, epoch: number) => Promise<void>, sync: () => Promise<void>, wait: () => Promise<void>, report: (cause: unknown) => void) {
  const started = current()
  if (owner !== started.identity || started.disposed) return
  try {
    await wait().catch(() => {})
    await reload(owner, started.session)
    const next = current()
    if (owner === next.identity && started.session === next.session && !next.disposed) await sync()
  } catch (cause) {
    const next = current()
    if (owner === next.identity && started.session === next.session && !next.disposed) report(cause)
  }
}

function createActiveHistoryCompaction(input: { configs: Ref<BlindReplicaConfig[]>; busy: Ref<boolean>; reserved: () => boolean; live: (owner: string, epoch: number) => boolean }) {
  const automatic = new Set<string>()
  let pending: Promise<void> | undefined
  const canCompact = (owner: string, epoch: number) => input.live(owner, epoch) && !input.busy.value && !input.reserved() && !pending && !hasActiveTextEditor()
  async function compact(owner: string, epoch: number, compactWorkspace: (workspaceId: string) => Promise<unknown>) {
    if (!canCompact(owner, epoch)) return
    const workspaces = [...new Set(input.configs.value.filter(config => !config.removalPending).map(config => config.workspaceId))]
    for (const workspaceId of workspaces) {
      if (!canCompact(owner, epoch)) return
      const matches = input.configs.value.filter(config => config.workspaceId === workspaceId && !config.removalPending)
      if (matches.length !== 1 || automatic.has(workspaceId)) continue
      const progress = await defaultStorage.ensureHistoryProgress(workspaceId)
      if (!canCompact(owner, epoch)) return
      if (!progress.transitionId && (progress.admittedChanges < HISTORY_ACTIVE_CHANGE_LIMIT && progress.encodedBytes < HISTORY_ACTIVE_BYTE_LIMIT)) continue
      automatic.add(workspaceId)
      pending = compactWorkspace(workspaceId).then(() => undefined, () => undefined).finally(() => { automatic.delete(workspaceId); pending = undefined })
      return
    }
  }
  return { automatic, pending: () => pending, compact }
}

/** Automatic archive work waits while the user is editing; replica delivery keeps running. */
function hasActiveTextEditor(): boolean {
  const element = typeof document === "undefined" ? null : document.activeElement
  if (!element) return false
  if ("isContentEditable" in element && element.isContentEditable === true) return true
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true
  return element.tagName === "INPUT" && !/^(button|checkbox|radio|range|reset|submit|file|color|hidden|image)$/.test((element as HTMLInputElement).type)
}
