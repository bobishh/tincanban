import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationConfiguration } from "../app/automation"
import type { PrivateReplicationState } from "./privateReplicationState"
import type { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import { createHistoryCompactionAction } from "./privateHistoryCompactionAction"
import { traceDiagnosticOperation } from "./telemetry"

type Runtime = ReturnType<typeof createPrivateReplicaRuntime>
export type ReplicationLifecycle = { identity: () => string; epoch: () => number; disposed: () => boolean;
  reload: (owner: string, epoch: number) => Promise<void>; syncNow: () => Promise<void> }

export function createPrivateReplicationActions(tincanban: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: Runtime, lifecycle: ReplicationLifecycle, automaticHistoryCompactions: Set<string>) {
  const { configs, busy, error, notice, revokedDeviceAccess } = state
  async function attach(originInput: string, workspaceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    busy.value = true
    try { await connectScope(originInput, workspaceId) } finally { busy.value = false }
    await lifecycle.syncNow()
  }
  async function connectScope(originInput: string, workspaceId: string) {
    const owner = lifecycle.identity(), epoch = lifecycle.epoch(), guard = runtime.captureSession()
    const { connectWorkspaceReplica } = await import("./replicaConnections")
    await connectWorkspaceReplica(tincanban, originInput, workspaceId, guard)
    await lifecycle.reload(owner, epoch)
  }
  async function updateDeviceAccess(origin: string, workspaceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const guard = runtime.captureSession(workspaceId)
    guard()
    busy.value = true
    error.value = ""
    notice.value = ""
    try {
      const { migrateRustyDeviceAccess } = await import("./rustyDeviceAccess")
      guard()
      await migrateRustyDeviceAccess(tincanban, origin, workspaceId, guard)
      guard()
      notice.value = "Rusty device access updated. Your other approved devices can use it independently."
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Could not update Rusty device access"
      throw cause
    } finally { busy.value = false }
    await lifecycle.syncNow()
  }
  async function revokeIdentityDevice(origin: string, deviceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const guard = runtime.captureSession()
    guard()
    busy.value = true
    error.value = ""
    notice.value = ""
    try {
      const { revokeRustyIdentityDevice } = await import("./rustyCredentialTransition")
      guard()
      await revokeRustyIdentityDevice(tincanban, origin, deviceId, guard)
      guard()
      const item = `${origin}|${deviceId}`
      if (!revokedDeviceAccess.value.includes(item)) revokedDeviceAccess.value = [...revokedDeviceAccess.value, item]
      notice.value = "Device access removed from all Rusty connections at this origin."
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Rusty device access removal is pending"
      throw cause
    } finally { busy.value = false }
    await lifecycle.reload(lifecycle.identity(), lifecycle.epoch())
    await lifecycle.syncNow()
  }
  async function recoverCredentialConflict(origin: string, scopeId: string, workspaceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const owner = lifecycle.identity(), epoch = lifecycle.epoch(), guard = runtime.captureSession(workspaceId)
    guard()
    busy.value = true
    error.value = ""
    notice.value = ""
    try {
      const { recoverRustyCredentialConflict } = await import("./replicaCredentialConflictWorkflow")
      guard()
      await traceDiagnosticOperation("rusty.credential-recovery", { "workspace.id": workspaceId,
        "server.address": new URL(origin).host }, () => recoverRustyCredentialConflict(tincanban, origin, scopeId, workspaceId, guard))
      guard()
      notice.value = "Rusty connection recovered. Confirming its fresh snapshot."
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Rusty recovery is pending"
      throw cause
    } finally { busy.value = false }
    await lifecycle.reload(owner, epoch)
    await lifecycle.syncNow()
  }
  async function revoke(config: BlindReplicaConfig) {
    const guard = runtime.captureSession()
    guard()
    const profile = tincanban.getCurrentProfile()
    if (!profile || profile.identity.personId !== lifecycle.identity()) throw new Error("Identity unavailable")
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
    try { await recordReplicaPreference(lifecycle.identity(), { ...config, removalPending: true }); await revoke(config); notice.value = "Rusty removed. Your board stays on this device." }
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
  const compactWorkspaceHistory = createHistoryCompactionAction(tincanban, state, runtime, lifecycle, automaticHistoryCompactions)
  return { attach, updateDeviceAccess, revokeIdentityDevice, recoverCredentialConflict, revoke, remove,
    exportAutomationAccess, compactWorkspaceHistory }
}

async function recordReplicaPreference(owner: string, config: BlindReplicaConfig, removed = false) {
  return (await import("./identityDevicePreferences")).recordReplicaPreference(owner, config, removed)
}
