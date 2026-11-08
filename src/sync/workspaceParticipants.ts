import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalizeJson } from "../domain/identity"
import { meshTrace } from "./meshTrace"
import type { WorkspaceGrant, DeviceCertificate } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { defaultProofStore } from "../domain/proofs"
import { readWorkspaceSigningAuthority, authorityValidationFingerprint } from "./changeAuthorization"
import { records } from "./workspaceChangeProofStore"
import { verifyWorkspaceGrant, type WorkspaceAuthority } from "./meshRecords"
import type { PeerStore } from "./peerStore"
import type { WorkspaceMemberBundle } from "./meshRecords"

export type WorkspaceParticipant = { personId: string; role: Exclude<WorkspaceRole, "automation"> }

/** Renewal preserves a verified role; differing current roles require a new owner decision. */
export async function readWorkspaceParticipantRenewal(workspaceId: string, personId: string): Promise<{
  role: "editor" | "visitor"; accessEpoch: number
} | undefined> {
  const state = await readVerifiedWorkspaceGrants(workspaceId)
  if ("reason" in state || state.authority.ownerPersonId === personId) return undefined
  const entries = state.grants.filter(entry => entry.personId === personId)
  const accessEpoch = entries.reduce((maximum, entry) => Math.max(maximum, entry.grant.payload.accessEpoch ?? 1), 0)
  const roles = new Set(entries.filter(entry => (entry.grant.payload.accessEpoch ?? 1) === accessEpoch).map(entry => entry.role))
  const role = [...roles][0]
  return roles.size === 1 && (role === "editor" || role === "visitor") ? { role, accessEpoch } : undefined
}

/** Issuance observes all retained, signed generations, including restored history and obsolete access. */
async function readRetainedWorkspaceGrants(workspaceId: string,
  authority: VerifiedWorkspaceGrantState["authority"], candidates: WorkspaceGrant[] = []): Promise<WorkspaceGrant[]> {
  const owners = workspaceOwners(authority)
  const grants = [...await participantGrants(workspaceId, authority.localGrant), ...candidates]
  const unique = new Map<string, WorkspaceGrant>()
  for (const grant of grants) if (grant?.payload?.workspaceId === workspaceId) unique.set(canonicalizeJson(grant), grant)
  const verified: WorkspaceGrant[] = []
  for (const grant of unique.values()) if (await verifiedGrantRole(grant, workspaceId, owners)) verified.push(grant)
  return verified
}

/** The SDK owns epoch arithmetic; this module supplies every retained source of signed membership. */
export async function nextWorkspaceAccessEpoch(workspaceId: string, store: PeerStore): Promise<number> {
  const credential = await store.getWorkspaceCredential(workspaceId)
  const peers = await store.listPeers(workspaceId)
  const candidates = peers.flatMap(peer => {
    const grant = (peer.advertisement as WorkspaceMemberBundle | undefined)?.grant
    return grant ? [grant] : []
  })
  const issued = credential ? await readRetainedWorkspaceGrants(workspaceId, credential, candidates)
    : await defaultProofStore.listGrants(workspaceId)
  return meshRustRuntime().state.nextAccessEpoch(credential ?? null, issued)
}

/** Return the latest verified active grant, admitting a verified peer grant only as candidate evidence. */
export async function readWorkspaceParticipantGrant(workspaceId: string, personId: string,
  candidate?: WorkspaceGrant): Promise<WorkspaceGrant | undefined> {
  const state = await readVerifiedWorkspaceGrants(workspaceId, candidate)
  const entries = "grants" in state ? state.grants.filter(entry => entry.personId === personId) : []
  const selected = latestActiveGrant(entries)?.grant
  if (!selected) {
    const epoch = entries.reduce((maximum, entry) => Math.max(maximum, entry.grant.payload.accessEpoch ?? 1), 0)
    const latest = entries.filter(entry => (entry.grant.payload.accessEpoch ?? 1) === epoch)
    meshTrace("workspace.participant-grant.unavailable", { workspaceId, peerId: personId,
      reason: "reason" in state ? state.reason : latest.length ? "conflicting-grants" : "no-active-grant",
      epoch, grantCount: new Set(latest.map(entry => canonicalizeJson(entry.grant))).size,
      grantIds: [...new Set(latest.map(entry => entry.grant.payload.grantId))].slice(0, 8),
      candidateEpoch: candidate?.payload?.accessEpoch ?? null, candidateRole: candidate?.payload?.role ?? null,
    }, "warn")
  }
  return selected
}

/** Membership survives transport loss; the SDK still verifies every retained grant. */
export async function readWorkspaceParticipants(workspaceId: string): Promise<WorkspaceParticipant[]> {
  const state = await readVerifiedWorkspaceGrants(workspaceId)
  if ("reason" in state) return []
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

async function readVerifiedWorkspaceGrants(workspaceId: string, candidate?: WorkspaceGrant): Promise<VerifiedWorkspaceGrantState | {
  reason: "invalid-authority" | "missing-authority" | "changed-authority"
}> {
  const { authority, invalid } = await readWorkspaceSigningAuthority(workspaceId)
  if (!authority || invalid || authority.workspaceId !== workspaceId) {
    return { reason: invalid ? "invalid-authority" : "missing-authority" }
  }
  const owners = workspaceOwners(authority)
  const grants = await participantGrants(workspaceId, authority.localGrant, candidate)
  const verified: VerifiedGrant[] = []
  for (const grant of grants) {
    const entry = await verifyActiveGrant(grant, workspaceId, authority, owners)
    if (entry) verified.push(entry)
  }
  const current = await readWorkspaceSigningAuthority(workspaceId)
  if (current.invalid || authorityValidationFingerprint(current.authority) !== authorityValidationFingerprint(authority)) {
    return { reason: "changed-authority" }
  }
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
  const verifiedRole = await verifiedGrantRole(grant, workspaceId, owners)
  return verifiedRole && verifiedRole !== "automation" ? { grant, personId, role: verifiedRole } : undefined
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

async function verifiedGrantRole(grant: WorkspaceGrant, workspaceId: string,
  owners: WorkspaceAuthority[]): Promise<WorkspaceRole | undefined> {
  for (const owner of owners) {
    try {
      const role = await verifyWorkspaceGrant(grant, { workspaceId, personId: grant.payload.personId,
        ownerPersonId: owner.personId, ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates })
      return role === "owner" ? "editor" : role
    } catch { /* Historical owner evidence cannot authorize a forged grant. */ }
  }
}

async function participantGrants(workspaceId: string, localGrant: unknown, candidate?: WorkspaceGrant): Promise<WorkspaceGrant[]> {
  const [proofs, history] = await Promise.all([defaultProofStore.listGrants(workspaceId), records(workspaceId)])
  return [...proofs, ...history.flatMap(record => record.grant ? [record.grant] : []),
    ...(localGrant ? [localGrant] : []), ...(candidate ? [candidate] : [])] as WorkspaceGrant[]
}
