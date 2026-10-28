import type { LocalProfile } from "../domain/identity"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { hasLeftWorkspace, isDeviceRevoked, isGrantRevoked } from "./durableMeshBase"
import type { WorkspaceMemberBundle } from "./meshRecords"
import type { PeerStore, WorkspacePeerRecord } from "./peerStore"
import { isNativeKeeperRoute } from "./nativeKeeperRoute"

/** Retained content without a remote route still needs the normal verified owner offer. */
export async function routedOwnerWorkspaceIds(store: Pick<PeerStore, "listWorkspaceCredentials" | "getWorkspaceCredential" | "listPeers">,
  profile: Pick<LocalProfile, "identity" | "device">): Promise<string[]> {
  const runtime = meshRustRuntime().state
  const owned = runtime.ownedWorkspaceIds(await store.listWorkspaceCredentials(), profile.identity.personId, profile.identity.publicKey)
  const routed: string[] = []
  for (const workspaceId of owned) {
    const peers = await store.listPeers(workspaceId)
    const credential = await store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId !== profile.identity.personId ||
        credential.ownerPublicKey !== profile.identity.publicKey) continue
    // Explicit access removal must not become a request to restore the board.
    const active = runtime.partitionCredentials({ credentials: [credential], personId: profile.identity.personId,
      publicKey: profile.identity.publicKey, deviceId: profile.device.deviceId }).activeIndices.length > 0
    if (!active) { routed.push(workspaceId); continue }
    if (peers.some(peer => {
      const grant = (peer.advertisement as WorkspaceMemberBundle | undefined)?.grant
      return peer.deviceId !== profile.device.deviceId && peer.transportSecret === credential.transportSecret &&
        Boolean(peer.endpoint) && !isNativeKeeperRoute(peer) && !peer.revokedAt && Boolean(peer.advertisement) &&
        !isDeviceRevoked(credential, peer.personId, peer.deviceId) &&
        !isGrantRevoked(credential, peer.personId, grant) && !hasLeftWorkspace(credential, peer.personId, grant)
    })) routed.push(workspaceId)
  }
  return routed
}

type Host = { connected: (workspaceId: string, deviceId: string) => boolean;
  trace: (event: string, detail: Record<string, unknown>) => void }

/** Expired bootstrap addresses remain available until an authenticated sibling serves this board/device. */
export class MeshDialRouteSelector {
  private suppressed = new Set<string>()
  constructor(private readonly host: Host) {}

  select(peers: WorkspacePeerRecord[]): WorkspacePeerRecord[] {
    const suppressed = new Set<string>()
    const available = peers.filter(peer => {
      if (isNativeKeeperRoute(peer)) return false
      const lease = routeLeaseFields(peer)
      if (!lease.expired || !this.host.connected(peer.workspaceId, peer.deviceId)) return true
      const key = `${peer.workspaceId}:${peer.deviceId}:${peer.instanceId}:${lease.expiresAt}`
      suppressed.add(key)
      if (!this.suppressed.has(key)) this.host.trace("route.suppressed.expired", {
        workspaceId: peer.workspaceId, targetDeviceId: peer.deviceId, instanceId: peer.instanceId,
        ...lease, reason: "authenticated sibling session active",
      })
      return false
    })
    this.suppressed = suppressed
    return available
  }
}

export function routeLeaseFields(peer: WorkspacePeerRecord, now = Date.now()) {
  const payload = (peer.advertisement as WorkspaceMemberBundle | undefined)?.advertisement?.payload
  const expiresAt = payload?.expiresAt
  return { issuedAt: payload?.issuedAt, expiresAt, routeSequence: payload?.routeSequence,
    expired: typeof expiresAt === "string" && Date.parse(expiresAt) <= now }
}
