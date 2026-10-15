import { onBeforeUnmount, ref, watch } from "vue"
import type { useTincanban } from "../state"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { subscribeChat } from "../chat/service"
import { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import type { ReplicaHealth } from "./replicationHealth"
import type { AutomationConfiguration } from "../app/automation"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"

export type BlindReplicationController = ReturnType<typeof useBlindReplication>

function createReplicationState() {
  return {
    configs: ref<BlindReplicaConfig[]>([]), identityConfigs: ref<IdentityReplicaConfig[]>([]),
    profileSetupErrors: ref<Record<string, string>>({}),
    statuses: ref<Record<string, ReplicaHealth>>({}), now: ref(Date.now()),
    attachmentCoverage: ref<Record<string, AttachmentCoverageStatus[]>>({}),
    busy: ref(false), error: ref(""), notice: ref(""),
  }
}

function clearReplicationSessionState(state: ReturnType<typeof createReplicationState>) {
  state.configs.value = []
  state.identityConfigs.value = []
  state.profileSetupErrors.value = {}
  state.statuses.value = {}
  state.attachmentCoverage.value = {}
  state.error.value = ""
  state.notice.value = ""
}

/** Credentials remain in private local storage, never in the shared board. */
export function useBlindReplication(tincanban: ReturnType<typeof useTincanban>) {
  const state = createReplicationState()
  const { configs, identityConfigs, profileSetupErrors, statuses, attachmentCoverage, now, busy, error, notice } = state
  let identity = ""
  let session = 0
  let running: Promise<void> | undefined
  let disposed = false
  const runtime = createPrivateReplicaRuntime(tincanban, { configs, identityConfigs, profileSetupErrors, statuses, attachmentCoverage }, {
    identity: () => identity, epoch: () => session, disposed: () => disposed,
  })
  const { personId, profileBinding, reload, replica, fetchAttachment } = runtime
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
          return (await replica(config)).sync()
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
    }).finally(() => { running = undefined; busy.value = false })
    return running
  }
  async function attach(originInput: string, workspaceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    busy.value = true
    try { await connectScope(originInput, workspaceId) } finally { busy.value = false }
    await syncNow()
  }
  async function connectScope(originInput: string, workspaceId: string) {
    const owner = identity, epoch = session, guard = runtime.captureSession()
    const { connectWorkspaceReplica } = await import("./replicaConnections")
    await connectWorkspaceReplica(tincanban, originInput, workspaceId, guard)
    await reload(owner, epoch)
  }
  async function revoke(config: BlindReplicaConfig) {
    const guard = runtime.captureSession()
    guard()
    const profile = tincanban.getCurrentProfile()
    if (!profile || profile.identity.personId !== identity) throw new Error("Identity unavailable")
    const { revokeWorkspaceReplicaConnection } = await import("./replicaConnections")
    const next = await revokeWorkspaceReplicaConnection(config, profile, guard)
    await runtime.forget(config, guard)
    configs.value = next
  }
  async function remove(config: BlindReplicaConfig) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    notice.value = ""
    error.value = ""
    busy.value = true
    try { await recordReplicaPreference(identity, { ...config, removalPending: true }); await revoke(config); notice.value = "Rusty removed. Your board stays on this device." }
    catch (cause) { error.value = "Removal pending. Rusty must confirm that access was revoked."; throw cause }
    finally { busy.value = false }
  }
  async function exportAutomationAccess(config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration): Promise<string> {
    const guard = runtime.captureSession()
    guard()
    const { exportApprovedAutomation } = await import("../app/automationActivation")
    guard()
    return exportApprovedAutomation(tincanban, config, workerIdentity, configuration)
  }
  const stop = watch(profileBinding, async () => {
    const owner = tincanban.ready.value ? personId() : ""
    const epoch = ++session
    identity = owner
    clearReplicationSessionState(state)
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
  return { configs, identityConfigs, profileSetupErrors, statuses, attachmentCoverage, now, busy, error, notice, attach, exportAutomationAccess, remove, syncNow, fetchAttachment }
}

async function recordReplicaPreference(owner: string, config: BlindReplicaConfig, removed = false) {
  return (await import("./identityDevicePreferences")).recordReplicaPreference(owner, config, removed)
}
