import type { WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import type { WorkspaceDocumentV2 } from "./domain/model"

export type IncomingPacket = { bytes: Uint8Array; authorization: unknown }

export type IncomingPacketEntry = IncomingPacket & {
  root: Pick<WorkspaceDocumentV2, "id" | "ownerPersonId">
  policy: string
  authority: string
  revision: string
  generation?: string
  weight: number
}

export const recentIncomingPackets = new Map<string, IncomingPacketEntry>()

/** Link only the exact committed packet revision to its newly verified delta basis. */
export function bindIncomingPacketDeltaBasis(id: string, previousRevision: string | null,
  frontier: WorkspaceDeltaFrontier): void {
  const entry = recentIncomingPackets.get(id)
  if (!entry || entry.revision !== previousRevision || frontier.workspaceId !== id || frontier.invalidated ||
      frontier.revision !== 0 || frontier.policy !== entry.policy || frontier.authorityFingerprint !== entry.authority) return
  entry.generation = frontier.generation
}
