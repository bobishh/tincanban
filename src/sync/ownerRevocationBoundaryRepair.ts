import * as Automerge from "@automerge/automerge/slim"
import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { publicKeyId, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, WorkspaceDocumentV2 } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { createWorkspaceRevocation, verifyWorkspaceRevocation } from "./meshRecords"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"
import { ownerWorkspaceRecordSigning } from "./meshRecordSigning"

type StoredAuthority = WorkspaceAuthorityRecord | WorkspaceMeshCredential

function uniqueCertificates(profile: LocalProfile, certificates: DeviceCertificate[]) {
  const values = [profile.certificate, ...certificates].filter(certificate =>
    certificate?.payload?.personId === profile.identity.personId)
  return [...new Map(values.map(certificate => [certificate.signature, certificate])).values()]
}

function hasMissingAdmittedHeads(records: unknown[], headSet: Set<string>): boolean {
  return records.some(value => {
    const record = value as { payload: { workspaceHeads: string[] } }
    return record.payload.workspaceHeads.some(head => !headSet.has(head))
  })
}

async function repairRevocationGeneration(doc: WorkspaceDocumentV2, profile: LocalProfile, personId: string,
  records: unknown[], heads: string[]): Promise<void> {
  const nextEpoch = Math.max(...records.map(value => (value as { payload: { epoch: number } }).payload.epoch)) + 1
  const replacement = await createWorkspaceRevocation(profile, doc.id, personId, nextEpoch, heads, new Date().toISOString(),
    await ownerWorkspaceRecordSigning(profile, doc.id))
  await peerStore.replaceWorkspaceRevocationGeneration({ workspaceId: doc.id, personId, expected: records, replacements: [replacement] })
}

async function verifiedOwnerAuthority(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<StoredAuthority> {
  if (doc.ownerPersonId !== profile.identity.personId) throw new Error("Only the current workspace owner can repair revocation boundaries")
  if (await publicKeyId(profile.identity.publicKey) !== profile.identity.personId)
    throw new Error("Current owner identity does not match its public key")
  const stored = await peerStore.getWorkspaceAuthority(doc.id)
  if (!stored || stored.workspaceId !== doc.id || stored.ownerPersonId !== profile.identity.personId ||
    stored.ownerPublicKey !== profile.identity.publicKey) throw new Error("Current owner authority is unavailable")

  const certificates = uniqueCertificates(profile, [
    ...((stored.ownerCertificates ?? []) as DeviceCertificate[]),
    ...await defaultProofStore.listCertificates(),
  ])
  const deviceKey = await verifyDeviceCertificateChain(profile.identity, profile.device.deviceId, certificates)
  if (deviceKey !== profile.device.publicKey) throw new Error("Current owner device certificate is invalid")
  if (meshRustRuntime().state.isDeviceRevoked(stored, profile.identity.personId, profile.device.deviceId))
    throw new Error("A revoked owner device cannot repair workspace authority")
  return stored
}

async function revocationsByPerson(stored: StoredAuthority, doc: WorkspaceDocumentV2, ownerPersonId: string) {
  const catalog = stored.catalog as { revocations?: unknown[] } | undefined
  const byPerson = new Map<string, unknown[]>()
  for (const raw of catalog?.revocations ?? []) {
    const record = await verifyWorkspaceRevocation(raw, doc.id, stored.ownerPersonId, stored.ownerPublicKey,
      (stored.ownerCertificates ?? []) as DeviceCertificate[])
    if (record.payload.ownerPersonId !== ownerPersonId || record.payload.personId === ownerPersonId) continue
    byPerson.set(record.payload.personId, [...(byPerson.get(record.payload.personId) ?? []), record])
  }
  return byPerson
}

/** Repair only a current owner's signed revocations whose boundary fell outside
 * the admitted document. The old signed evidence remains in local audit history. */
export async function reconcileOwnerRevocationBoundaries(doc: WorkspaceDocumentV2, profile: LocalProfile): Promise<string[]> {
  const stored = await verifiedOwnerAuthority(doc, profile)
  const byPerson = await revocationsByPerson(stored, doc, profile.identity.personId)

  const heads = Automerge.getHeads(doc)
  const headSet = new Set(heads)
  const repaired: string[] = []
  for (const [personId, records] of byPerson) {
    if (!hasMissingAdmittedHeads(records, headSet)) continue
    await repairRevocationGeneration(doc, profile, personId, records, heads)
    repaired.push(personId)
  }
  return repaired
}

export async function repairOwnerRevocationBoundary(cause: unknown, doc: WorkspaceDocumentV2, profile: LocalProfile,
  revokePeer: (personId: string) => Promise<void>): Promise<void> {
  if (!String(cause).includes("Workspace ownership boundary is missing from the document")) throw cause
  for (const personId of await reconcileOwnerRevocationBoundaries(doc, profile)) await revokePeer(personId)
}
