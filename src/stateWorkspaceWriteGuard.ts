import { stateRuntime } from "./stateContext"
import { assertWorkspaceNotDeparting } from "./storageWorkspaceDeparture"
import { workspaceWritesBlocked } from "./sync/changeAuthorization"
import { peerStore } from "./sync/peerStore"

export async function assertWorkspaceWritesAllowed(workspaceId?: string): Promise<void> {
  if (!workspaceId) return
  await assertWorkspaceNotDeparting(workspaceId, stateRuntime.currentProfile?.identity.personId)
  if (typeof indexedDB !== "undefined" && await peerStore.getPendingOwnershipTransfer(workspaceId))
    throw new Error("Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.")
  if (await workspaceWritesBlocked(workspaceId)) throw new Error("Workspace writes paused: conflicting ownership records")
}
