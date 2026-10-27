import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceGrant, DeviceCertificate } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { defaultProofStore } from "../domain/proofs"
import { readWorkspaceSigningAuthority, authorityValidationFingerprint } from "./changeAuthorization"
import { records } from "./workspaceChangeProofStore"
import { verifyWorkspaceGrant, type WorkspaceAuthority } from "./meshRecords"

export type WorkspaceParticipant = { personId: string; role: Exclude<WorkspaceRole, "automation"> }

/** Membership survives transport loss; the SDK still verifies every retained grant. */
export async function readWorkspaceParticipants(workspaceId: string): Promise<WorkspaceParticipant[]> {
  const { authority, invalid } = await readWorkspaceSigningAuthority(workspaceId)
  if (!authority || invalid || authority.workspaceId !== workspaceId) return []
  const owners: WorkspaceAuthority[] = [{ personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
    certificates: authority.ownerCertificates as DeviceCertificate[] },
    ...(authority.ownerHistory ?? []).map(owner => ({ ...owner, certificates: owner.certificates as DeviceCertificate[] }))]
  const grants = await participantGrants(workspaceId, authority.localGrant)
  grants.sort((left, right) => (right.payload.accessEpoch ?? 1) - (left.payload.accessEpoch ?? 1))
  const participants = new Map<string, WorkspaceParticipant>([[authority.ownerPersonId, { personId: authority.ownerPersonId, role: "owner" }]])
  for (const grant of grants) {
    if (!grant?.payload) continue
    const { personId, role, workspaceId: scope } = grant.payload
    if (scope !== workspaceId || role === "automation" || participants.has(personId) ||
      meshRustRuntime().state.isGrantRevoked(authority, personId, grant)) continue
    const verified = await verifiedMemberRole(grant, workspaceId, owners)
    if (verified) participants.set(personId, { personId, role: verified })
  }
  const current = await readWorkspaceSigningAuthority(workspaceId)
  if (current.invalid || authorityValidationFingerprint(current.authority) !== authorityValidationFingerprint(authority)) return []
  return [...participants.values()]
}

async function verifiedMemberRole(grant: WorkspaceGrant, workspaceId: string,
  owners: WorkspaceAuthority[]): Promise<WorkspaceParticipant["role"] | undefined> {
  for (const owner of owners) {
    try {
      const role = await verifyWorkspaceGrant(grant, { workspaceId, personId: grant.payload.personId,
        ownerPersonId: owner.personId, ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates })
      if (role === "automation") return undefined
      return role === "owner" ? "editor" : role
    } catch { /* Historical owner evidence cannot authorize a forged grant. */ }
  }
}

async function participantGrants(workspaceId: string, localGrant: unknown): Promise<WorkspaceGrant[]> {
  const [proofs, history] = await Promise.all([defaultProofStore.listGrants(workspaceId), records(workspaceId)])
  return [...proofs, ...history.flatMap(record => record.grant ? [record.grant] : []),
    ...(localGrant ? [localGrant] : [])] as WorkspaceGrant[]
}
