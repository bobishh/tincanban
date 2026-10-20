import type { WorkspaceSetStore } from "./workspaceSet"
import { createDurablePeerHistoryGuard } from "./durablePeerHistoryGuard"
import { lazyIdentityDevicePreferences } from "./lazyIdentityDevicePreferences"
import { withWorkspaceRustyAccess } from "./workspaceRustyExchange"

/** One authenticated channel, with separate board and same-person private disclosures. */
export function participantWorkspaceStore(store: WorkspaceSetStore,
  context: Parameters<typeof createDurablePeerHistoryGuard>[0], privatePreferences: boolean) {
  const guard = createDurablePeerHistoryGuard(context)
  const isCurrent = () => { try { context.assertSession(); return true } catch { return false } }
  const personalStore = privatePreferences && context.remotePersonId === context.profile.identity.personId
    ? lazyIdentityDevicePreferences(store, context.profile, context.remotePersonId, context.deviceId, isCurrent) : store
  return { store: withWorkspaceRustyAccess(personalStore, { workspaceId: context.workspaceId, profile: context.profile,
    remotePersonId: context.remotePersonId, remoteDeviceId: context.deviceId, peers: context.store, guard }), guard }
}
