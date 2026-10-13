import type { WorkspaceStorage } from "./storage"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { LocalProfile } from "./domain/identity"
import type * as Automerge from "@automerge/automerge/slim"
import { localWorkspaceAdmissionAuthority } from "./sync/changeAuthorization"
import { admissionPolicy } from "./sync/workspaceAdmissionCheckpoint"
import { reusableDeltaAdmission } from "./stateDeltaAdmission"
import { equalIncomingPacket } from "./stateIncomingReuseEquality"

type Packet = { bytes: Uint8Array; authorization: unknown }
type Context = Awaited<ReturnType<typeof localWorkspaceAdmissionAuthority>>
type Entry = Packet & { root: Pick<WorkspaceDocumentV2, "id" | "ownerPersonId">; policy: string;
  authority: string; revision: string; generation?: string; weight: number }
const recent = new Map<string, Entry>()
const maximumBytes = 32 * 1024 * 1024

/** Only successfully committed, privately copied packets can authorize a no-op. */
export async function reuseIncomingPacket(id: string, packet: Packet, storage: WorkspaceStorage, profile?: LocalProfile) {
  const entry = recent.get(id)
  if (!entry || entry.policy !== admissionPolicy() || !equalIncomingPacket(entry, packet)) return false
  const context = await localWorkspaceAdmissionAuthority(entry.root, profile)
  if (context.fingerprint !== entry.authority) return false
  const revision = await storage.readWorkspaceRevision(id)
  if (!revision) return false
  if (revision !== entry.revision) {
    const frontier = await storage.readDeltaFrontier(id)
    if (!sameAdmittedGeneration(entry, frontier)) return false
  }
  if ((await localWorkspaceAdmissionAuthority(entry.root, profile)).fingerprint !== context.fingerprint ||
    await storage.readWorkspaceRevision(id) !== revision || !equalIncomingPacket(entry, packet)) return false
  return true
}

function sameAdmittedGeneration(entry: Entry, frontier: Awaited<ReturnType<WorkspaceStorage["readDeltaFrontier"]>>) {
  return Boolean(entry.generation && frontier && !frontier.invalidated && frontier.generation === entry.generation &&
    frontier.policy === entry.policy && frontier.authorityFingerprint === entry.authority)
}

export function copyIncomingPacket(bytes: Uint8Array, authorization: unknown): Packet {
  return { bytes: bytes.slice(), authorization: structuredClone(authorization) }
}

export async function rememberIncomingPacket(packet: Packet, doc: Automerge.Doc<WorkspaceDocumentV2>, storage: WorkspaceStorage,
  credentialFingerprint: string, fullyVerifiedInput: boolean, profile?: LocalProfile) {
  let context: Context
  // Lack of binding disables reuse; it cannot turn a durable success into an error.
  try { context = await localWorkspaceAdmissionAuthority(doc, profile) } catch { return }
  if (context.credentialFingerprint !== credentialFingerprint) return
  const frontier = fullyVerifiedInput ? await reusableDeltaAdmission(doc, storage, profile) : undefined
  const revision = await storage.readWorkspaceRevision(doc.id)
  if (!revision || (await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint !== context.fingerprint) return
  let weight: number
  try { weight = packet.bytes.byteLength + JSON.stringify(packet.authorization).length * 2 } catch { return }
  if (weight > maximumBytes) return
  recent.delete(doc.id)
  recent.set(doc.id, { ...packet, root: { id: doc.id, ownerPersonId: doc.ownerPersonId }, policy: admissionPolicy(),
    authority: context.fingerprint, revision, generation: frontier?.generation, weight })
  while (recent.size > 8 || [...recent.values()].reduce((sum, entry) => sum + entry.weight, 0) > maximumBytes)
    recent.delete(recent.keys().next().value!)
}
