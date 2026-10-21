import type { WorkspaceMemberBundle } from "./meshRecords"
import type { WorkspacePeerRecord } from "./peerStore"
import { isNativeKeeperRoute } from "./nativeKeeperRoute"

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
