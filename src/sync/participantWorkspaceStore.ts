import { liveAutomergeWorkspaceSync, type WorkspaceSetStore } from "./workspaceSet"
import { createDurablePeerHistoryGuard } from "./durablePeerHistoryGuard"
import { lazyIdentityDevicePreferences } from "./lazyIdentityDevicePreferences"
import { withWorkspaceRustyAccess } from "./workspaceRustyExchange"
import { createWorkspaceRustyAccessMaintenance } from "./workspaceRustyAccessMaintenance"
import { meshTrace } from "./meshTrace"

type SessionInput = Parameters<typeof liveAutomergeWorkspaceSync>

/** One authenticated channel, with separate board and same-person private disclosures. */
function participantWorkspaceStore(store: WorkspaceSetStore,
  context: Parameters<typeof createDurablePeerHistoryGuard>[0], privatePreferences: boolean) {
  const guard = createDurablePeerHistoryGuard(context)
  const isCurrent = () => { try { context.assertSession(); return true } catch { return false } }
  const personalStore = privatePreferences && context.remotePersonId === context.profile.identity.personId
    ? lazyIdentityDevicePreferences(store, context.profile, context.remotePersonId, context.deviceId, isCurrent) : store
  const workspace = withWorkspaceRustyAccess(personalStore, { workspaceId: context.workspaceId, profile: context.profile,
    remotePersonId: context.remotePersonId, remoteDeviceId: context.deviceId, peers: context.store, guard })
  return { store: workspace, guard, prepareRustyAccess: () => workspace.prepareRustyAccess(context.workspaceId) }
}

/** The admitted channel owns its data stream and optional storage-maintenance lifetime. */
export function participantWorkspaceSession(store: WorkspaceSetStore,
  context: Parameters<typeof createDurablePeerHistoryGuard>[0], privatePreferences: boolean,
  connection: SessionInput[0], onRejected: SessionInput[6], options: SessionInput[7]) {
  const workspace = participantWorkspaceStore(store, context, privatePreferences)
  const live = liveAutomergeWorkspaceSync(connection, context.transportSecret, workspace.store,
    context.workspaceId, context.profile.device.deviceId, context.deviceId, onRejected,
    { ...options, remoteDeviceId: context.deviceId, ensureCurrent: workspace.guard })
  const maintenance = createWorkspaceRustyAccessMaintenance({ prepare: workspace.prepareRustyAccess,
    publish: () => live.publish(), failed: cause => {
      const failures = cause instanceof AggregateError ? cause.errors : [cause]
      for (const failure of failures) meshTrace("rusty.access.pending", {
        workspaceId: context.workspaceId, peerId: context.deviceId,
        reason: failure instanceof Error ? failure.message : String(failure), error: failure,
      }, "warn")
    } })
  void live.done.then(() => maintenance.stop(), () => maintenance.stop())
  return { session: { ...live, close: async () => { maintenance.stop(); await live.close() } },
    maintenance, reset: () => maintenance.stop() }
}
