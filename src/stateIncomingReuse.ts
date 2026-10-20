import type { WorkspaceStorage, WorkspaceTransactionContext } from "./storage"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { LocalProfile } from "./domain/identity"
import type * as Automerge from "@automerge/automerge/slim"
import { localWorkspaceAdmissionAuthority } from "./sync/changeAuthorization"
import { admissionPolicy } from "./sync/workspaceAdmissionCheckpoint"
import { equalIncomingPacket, fullyVerifiedIncomingInput } from "./stateIncomingReuseEquality"
import type { WorkspaceAdmissionResult } from "./product-replica/workspaceAdmission"
import { recentIncomingPackets, type IncomingPacket, type IncomingPacketEntry } from "./stateIncomingPacketCache"

type Context = Awaited<ReturnType<typeof localWorkspaceAdmissionAuthority>>
const maximumBytes = 32 * 1024 * 1024

/** Only successfully committed, privately copied packets can authorize a no-op. */
export async function reuseIncomingPacket(id: string, packet: IncomingPacket, transaction: WorkspaceTransactionContext, profile?: LocalProfile) {
  const entry = recentIncomingPackets.get(id)
  if (!entry || entry.policy !== admissionPolicy() || entry.baselineId !== transaction.capturedBaselineId || !equalIncomingPacket(entry, packet)) return false
  const context = await localWorkspaceAdmissionAuthority(entry.root, profile)
  if (context.fingerprint !== entry.authority) return false
  const revision = transaction.capturedRevision ?? undefined
  if (!revision) return false
  if (revision !== entry.revision) {
    const frontier = await transaction.readDeltaFrontier()
    if (!sameAdmittedGeneration(entry, frontier)) return false
  }
  if ((await localWorkspaceAdmissionAuthority(entry.root, profile)).fingerprint !== context.fingerprint ||
    transaction.capturedRevision !== revision || !equalIncomingPacket(entry, packet)) return false
  return true
}

function sameAdmittedGeneration(entry: IncomingPacketEntry, frontier: Awaited<ReturnType<WorkspaceStorage["readDeltaFrontier"]>>) {
  return Boolean(entry.generation && frontier && !frontier.invalidated && frontier.generation === entry.generation &&
    frontier.policy === entry.policy && frontier.authorityFingerprint === entry.authority)
}

export function copyIncomingPacket(bytes: Uint8Array, authorization: unknown): IncomingPacket {
  return { bytes: bytes.slice(), authorization: structuredClone(authorization) }
}

export async function rememberIncomingPacket(packet: IncomingPacket, doc: Automerge.Doc<WorkspaceDocumentV2>, storage: WorkspaceStorage,
  credentialFingerprint: string, profile?: LocalProfile, admission?: WorkspaceAdmissionResult, baselineId?: string | null) {
  let context: Context
  // Lack of binding disables reuse; it cannot turn a durable success into an error.
  try {
    context = await localWorkspaceAdmissionAuthority(doc, profile)
    if (!admission || !fullyVerifiedIncomingInput(packet.authorization, admission)) return
  } catch { return }
  if (context.credentialFingerprint !== credentialFingerprint) return
  const revision = await storage.readWorkspaceRevision(doc.id)
  if (!revision || (await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint !== context.fingerprint) return
  let weight: number
  try { weight = packet.bytes.byteLength + JSON.stringify(packet.authorization).length * 2 } catch { return }
  if (weight > maximumBytes) return
  recentIncomingPackets.delete(doc.id)
  recentIncomingPackets.set(doc.id, { ...packet, root: { id: doc.id, ownerPersonId: doc.ownerPersonId }, policy: admissionPolicy(),
    authority: context.fingerprint, revision, baselineId: baselineId ?? null, weight })
  while (recentIncomingPackets.size > 8 || [...recentIncomingPackets.values()].reduce((sum, entry) => sum + entry.weight, 0) > maximumBytes)
    recentIncomingPackets.delete(recentIncomingPackets.keys().next().value!)
}
