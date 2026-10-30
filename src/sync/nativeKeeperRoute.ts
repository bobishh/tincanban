import type { WorkspaceMemberBundle } from "./meshRecords"
import type { WorkspacePeerRecord } from "./peerStore"

export function isNativeKeeperRoute(peer: WorkspacePeerRecord): boolean {
  const advertisement = peer.advertisement as WorkspaceMemberBundle | undefined
  const userAgent = advertisement?.advertisement?.payload?.userAgent
  return typeof userAgent === "string" && /^mesh-(?:keeper|lighthouse)\//i.test(userAgent)
}
