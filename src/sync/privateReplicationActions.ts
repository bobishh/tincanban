import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import type { AutomationConfiguration } from "../app/automation"
import type { PrivateReplicationState } from "./privateReplicationState"
import type { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import { createHistoryCompactionAction } from "./privateHistoryCompactionAction"
import { createRustyResetAction } from "./privateRustyResetAction"
import { discoverBlindKeeper } from "./blindClient"
import { publicKeyId } from "../domain/identity"
import { configuredIdentityPortalOrigin } from "../app/identityPortalConfig"
import { createIdentityBrowserSignIn, writePendingIdentityBrowserSignIn, writePendingRustyConnectionIntent } from "../app/identityBrowserSignIn"

type Runtime = ReturnType<typeof createPrivateReplicaRuntime>
export type ReplicationLifecycle = { identity: () => string; epoch: () => number; disposed: () => boolean;
  reload: (owner: string, epoch: number) => Promise<void>; syncNow: () => Promise<void> }

export function createPrivateReplicationActions(tincanban: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: Runtime, lifecycle: ReplicationLifecycle, automaticHistoryCompactions: Set<string>) {
  const { configs, busy, error, notice, revokedDeviceAccess } = state
  async function addRustyConnection(originInput: string, workspaceId: string): Promise<{ kind: "connected" } | { kind: "identity-consent"; portalUrl: string }> {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const profile = tincanban.getCurrentProfile()
    if (!profile) throw new Error("Identity unavailable")
    const service = await discoverBlindKeeper(originInput)
    const pin = await (await import("./identityRustyServiceCatalog")).readIdentityRustyServicePin(profile.identity.personId, service.origin, profile)
    if (pin) {
      if (pin.servicePublicKey !== service.servicePublicKey || pin.serviceId !== await publicKeyId(service.servicePublicKey)) {
        throw new Error("Rusty service key changed. Review its Identity pin before reconnecting.")
      }
      await attach(service.origin, workspaceId)
      return { kind: "connected" }
    }

    const portalOrigin = configuredIdentityPortalOrigin(import.meta.env.VITE_IDENTITY_ORIGIN as string | undefined)
    if (!portalOrigin) throw new Error("Identity portal is not configured for Rusty connection approval")
    const serviceId = await publicKeyId(service.servicePublicKey)
    const { pending, portalUrl } = await createIdentityBrowserSignIn({ profile, portalOrigin,
      applicationOrigin: window.location.origin, returnPath: `${window.location.pathname}${window.location.search}`,
      personId: profile.identity.personId,
      rustyServicePins: [{ origin: service.origin, serviceId, servicePublicKey: service.servicePublicKey }] })
    writePendingIdentityBrowserSignIn(window.sessionStorage, pending)
    writePendingRustyConnectionIntent(window.sessionStorage, { version: 1, origin: service.origin, serviceId,
      workspaceId, challenge: pending.request.payload.challenge })
    return { kind: "identity-consent", portalUrl }
  }

  async function attachAfterIdentityApproval(origin: string, workspaceId: string): Promise<void> {
    const profile = tincanban.getCurrentProfile()
    if (!profile) throw new Error("Identity unavailable")
    const pin = await (await import("./identityRustyServiceCatalog")).readIdentityRustyServicePin(profile.identity.personId, origin, profile)
    if (!pin) throw new Error("Identity approval does not include the requested Rusty service pin")
    const service = await discoverBlindKeeper(origin)
    if (pin.servicePublicKey !== service.servicePublicKey || pin.serviceId !== await publicKeyId(service.servicePublicKey)) {
      throw new Error("Rusty service key changed after Identity approval")
    }
    await attach(service.origin, workspaceId)
  }
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
  const resumeRustyOperation = createSavedRustyOperationAction(tincanban, state, runtime, lifecycle)
  const forgetRusty = createRustyResetAction(tincanban, state, runtime, lifecycle)
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
  const recoverCredentialConflict = createCredentialConflictAction(tincanban, state, runtime, lifecycle)
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
    if (config.boardAccess) throw new Error("Only the board owner can remove its Rusty connection")
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    notice.value = ""
    error.value = ""
    busy.value = true
    try { await recordReplicaPreference(lifecycle.identity(), { ...config, removalPending: true }); await revoke(config); notice.value = "Rusty removed. Your board stays on this device." }
    catch (cause) { error.value = "Removal pending. Rusty must confirm that access was revoked."; throw cause }
    finally { busy.value = false }
  }
  const exportAutomationAccess = createAutomationExportAction(tincanban, runtime)
  const compactWorkspaceHistory = createHistoryCompactionAction(tincanban, state, runtime, lifecycle, automaticHistoryCompactions)
  return { attach, addRustyConnection, attachAfterIdentityApproval, resumeRustyOperation, forgetRusty, updateDeviceAccess, revokeIdentityDevice, recoverCredentialConflict, revoke, remove,
    exportAutomationAccess, compactWorkspaceHistory }
}

function createSavedRustyOperationAction(tincanban: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: Runtime, lifecycle: ReplicationLifecycle) {
  const { busy, error, notice } = state
  return async function resumeRustyOperation(origin: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const owner = lifecycle.identity(), epoch = lifecycle.epoch(), guard = runtime.captureSession()
    busy.value = true
    error.value = ""
    notice.value = ""
    try {
      const { resumePendingRustyOperation } = await import("./pendingRustyOperation")
      await resumePendingRustyOperation(tincanban, origin, guard)
      guard()
      notice.value = "Saved Rusty operation completed."
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Rusty recovery remains pending"
      throw cause
    } finally {
      busy.value = false
      await lifecycle.reload(owner, epoch)
    }
    await lifecycle.syncNow()
  }
}

async function recordReplicaPreference(owner: string, config: BlindReplicaConfig, removed = false) {
  return (await import("./identityDevicePreferences")).recordReplicaPreference(owner, config, removed)
}

function createCredentialConflictAction(tincanban: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: Runtime, lifecycle: ReplicationLifecycle) {
  const { busy, error, notice } = state
  async function recoverCredentialConflict(origin: string, scopeId: string, workspaceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    const owner = lifecycle.identity(), epoch = lifecycle.epoch(), guard = runtime.captureSession(workspaceId)
    guard()
    busy.value = true
    error.value = ""
    notice.value = ""
    try {
      const { recoverRustyCredentialConflict } = await import("./replicaCredentialConflictWorkflow")
      const { traceDiagnosticOperation } = await import("./telemetry")
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
  return recoverCredentialConflict
}

function createAutomationExportAction(tincanban: ReturnType<typeof useTincanban>, runtime: Runtime) {
  return async (config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration): Promise<string> => {
    const guard = runtime.captureSession()
    guard()
    const { exportApprovedAutomation } = await import("../app/automationActivation")
    guard()
    return exportApprovedAutomation(tincanban, config, workerIdentity, configuration)
  }
}
