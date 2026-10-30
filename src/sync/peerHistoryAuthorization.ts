import { MeshNetworkError } from "@meta-uber/mesh-transport"

type PeerHistoryAuthorizationInput = {
  workspaceIds: string[]
  personId: string
  deviceId: string
  advertisements: unknown
  isSessionCurrent(): boolean
  checkGuestDevices(workspaceIds: string[], personId: string, advertisements: unknown): Promise<string>
}

/** Recheck the accepted signed device advertisements against current workspace revocations. */
export function createPeerHistoryAuthorizationGuard(input: PeerHistoryAuthorizationInput) {
  const workspaceIds = [...input.workspaceIds]
  const advertisements = structuredClone(input.advertisements)
  return async () => {
    if (!input.isSessionCurrent()) throw new MeshNetworkError("Direct peer session is no longer current")
    const deviceId = await input.checkGuestDevices(workspaceIds, input.personId, advertisements)
    if (!input.isSessionCurrent()) throw new MeshNetworkError("Direct peer session is no longer current")
    if (deviceId !== input.deviceId) throw new Error("Guest device authorization changed")
  }
}
