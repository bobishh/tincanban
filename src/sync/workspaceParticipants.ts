import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalizeJson } from "../domain/identity"
import type { WorkspaceGrant, DeviceCertificate } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { defaultProofStore } from "../domain/proofs"
import { readWorkspaceSigningAuthority, authorityValidationFingerprint } from "./changeAuthorization"
import { records } from "./workspaceChangeProofStore"
import { verifyWorkspaceGrant, type WorkspaceAuthority } from "./meshRecords"

export type WorkspaceParticipant = { personId: string; role: Exclude<WorkspaceRole, "automation"> }

/** Return the latest verified active grant, admitting a verified peer grant only as candidate evidence. */
export async function readWorkspaceParticipantGrant(workspaceId: string, personId: string,
  candidate?: WorkspaceGrant): Promise<WorkspaceGrant | undefined> {
  const state = await readVerifiedWorkspaceGrants(workspaceId, candidate)
  if (!state) return undefined
  return latestActiveGrant(state.grants.filter(entry => entry.personId === personId))?.grant
}

/** Membership survives transport loss; the SDK still verifies every retained grant. */
export async function readWorkspaceParticipants(workspaceId: string): Promise<WorkspaceParticipant[]> {
  const state = await readVerifiedWorkspaceGrants(workspaceId)
  if (!state) return []
  const participants = new Map<string, WorkspaceParticipant>([
    [state.authority.ownerPersonId, { personId: state.authority.ownerPersonId, role: "owner" }],
  ])
  const people = new Set(state.grants.map(entry => entry.personId))
  for (const personId of people) {
    if (personId === state.authority.ownerPersonId) continue
    const entry = latestActiveGrant(state.grants.filter(value => value.personId === personId))
    if (entry) participants.set(personId, { personId, role: entry.role })
  }
  return [...participants.values()]
}

type VerifiedGrant = { grant: WorkspaceGrant; personId: string; role: WorkspaceParticipant["role"] }
type VerifiedWorkspaceGrantState = { authority: NonNullable<Awaited<ReturnType<typeof readWorkspaceSigningAuthority>>["authority"]>; grants: VerifiedGrant[] }

async function readVerifiedWorkspaceGrants(workspaceId: string, candidate?: WorkspaceGrant): Promise<VerifiedWorkspaceGrantState | undefined> {
  const { authority, invalid } = await readWorkspaceSigningAuthority(workspaceId)
  if (!authority || invalid || authority.workspaceId !== workspaceId) return undefined
  const owners = workspaceOwners(authority)
  const grants = await participantGrants(workspaceId, authority.localGrant, candidate)
  const verified: VerifiedGrant[] = []
  for (const grant of grants) {
    const entry = await verifyActiveGrant(grant, workspaceId, authority, owners)
    if (entry) verified.push(entry)
  }
  const current = await readWorkspaceSigningAuthority(workspaceId)
  if (current.invalid || authorityValidationFingerprint(current.authority) !== authorityValidationFingerprint(authority)) return undefined
  return { authority, grants: verified }
}

function workspaceOwners(authority: VerifiedWorkspaceGrantState["authority"]): WorkspaceAuthority[] {
  return [{ personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
    certificates: authority.ownerCertificates as DeviceCertificate[] },
    ...(authority.ownerHistory ?? []).map(owner => ({ ...owner, certificates: owner.certificates as DeviceCertificate[] }))]
}

async function verifyActiveGrant(grant: WorkspaceGrant | undefined, workspaceId: string,
  authority: VerifiedWorkspaceGrantState["authority"], owners: WorkspaceAuthority[]): Promise<VerifiedGrant | undefined> {
  if (!grant?.payload) return undefined
  const { personId, role } = grant.payload
  if (grant.payload.workspaceId !== workspaceId || role === "automation" ||
    meshRustRuntime().state.isGrantRevoked(authority, personId, grant) ||
    meshRustRuntime().state.hasLeftWorkspace(authority, personId, grant)) return undefined
  const verifiedRole = await verifiedMemberRole(grant, workspaceId, owners)
  return verifiedRole ? { grant, personId, role: verifiedRole } : undefined
}

function latestActiveGrant(entries: VerifiedGrant[]): VerifiedGrant | undefined {
  entries.sort((left, right) => (right.grant.payload.accessEpoch ?? 1) - (left.grant.payload.accessEpoch ?? 1))
  const latest = entries[0]?.grant
  if (!latest) return undefined
  const epoch = latest.payload.accessEpoch ?? 1
  const latestEpoch = entries.filter(entry => (entry.grant.payload.accessEpoch ?? 1) === epoch)
  if (latestEpoch.some(entry => entry.grant.payload.grantId !== latest.payload.grantId ||
    canonicalizeJson(entry.grant) !== canonicalizeJson(latest))) return undefined
  return entries[0]
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

async function participantGrants(workspaceId: string, localGrant: unknown, candidate?: WorkspaceGrant): Promise<WorkspaceGrant[]> {
  const [proofs, history] = await Promise.all([defaultProofStore.listGrants(workspaceId), records(workspaceId)])
  return [...proofs, ...history.flatMap(record => record.grant ? [record.grant] : []),
    ...(localGrant ? [localGrant] : []), ...(candidate ? [candidate] : [])] as WorkspaceGrant[]
}
