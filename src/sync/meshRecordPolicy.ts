import type { WorkspaceGrant, WorkspaceSuccessionPolicy, WorkspaceSuccessionVote } from "@meta-uber/mesh-workspace"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { LocalProfile } from "../domain/identity"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import type { PeerStore, WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"

export type MeshRecordOperation = { kind: "owner" | "departure" | "advertisement" | "claim" }
  | { kind: "vote"; candidatePersonId: string }
  | { kind: "device-revocation" | "device-restoration"; personId: string; deviceId: string }
type Peers = Awaited<ReturnType<PeerStore["listPeers"]>>
type Catalog = { successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[] }

/** Native membership checks apply equally to owner and participant record producers. */
export function assertMeshRecordMembership(credential: WorkspaceMeshCredential, authority: WorkspaceAuthorityRecord | null,
  profile: LocalProfile) {
  const state = meshRustRuntime().state
  for (const current of [credential, ...(authority ? [authority] : [])]) {
    if (state.hasAuthorityConflict(current) || state.isDeviceRevoked(current, profile.identity.personId, profile.device.deviceId) ||
        state.isGrantRevoked(current, profile.identity.personId, credential.localGrant ?? null) ||
        state.hasLeftWorkspace(current, profile.identity.personId, credential.localGrant ?? null)) {
      throw new Error("Workspace record authority is revoked or conflicting")
    }
  }
  if (authority && (authority.ownerPersonId !== credential.ownerPersonId || authority.ownerPublicKey !== credential.ownerPublicKey ||
      authority.epoch !== credential.epoch)) throw new Error("Workspace record authority does not match current membership")
  const partition = state.partitionCredentials({ credentials: [credential], personId: profile.identity.personId,
    publicKey: profile.identity.publicKey, deviceId: profile.device.deviceId })
  if (!partition.activeIndices.includes(0)) throw new Error("Current workspace membership is unavailable")
}

export function assertMeshRecordOperation(credential: WorkspaceMeshCredential, operation: MeshRecordOperation, peers: Peers,
  profile: LocalProfile, payload?: Record<string, unknown>) {
  if (operation.kind === "vote" || operation.kind === "claim") assertSuccessionOperation(credential, operation, profile)
  if (operation.kind === "owner") assertOwnerOperation(credential, peers, profile, payload)
  if (operation.kind === "departure" && credential.ownerPersonId === profile.identity.personId)
    throw new Error("Transfer ownership before leaving this workspace")
  if (operation.kind === "device-revocation") assertDeviceRemoval(credential, operation, peers, profile)
  if (operation.kind === "device-restoration" && (operation.deviceId === profile.device.deviceId ||
      (credential.ownerPersonId !== profile.identity.personId && operation.personId !== profile.identity.personId))) {
    throw new Error("Device restoration scope is no longer authorized")
  }
}

function assertOwnerOperation(credential: WorkspaceMeshCredential, peers: Peers, profile: LocalProfile, payload?: Record<string, unknown>) {
  if (credential.ownerPersonId !== profile.identity.personId) throw new Error("Only the workspace owner may sign this record")
  if (payload?.kind === "workspace-succession-policy" && canonicalAuthorityJson(payload.eligibleEditorPersonIds) !==
      canonicalAuthorityJson(meshRustRuntime().state.eligibleEditorPersonIds(peers)))
    throw new Error("Succession policy editor membership changed before signing")
}

function assertDeviceRemoval(credential: WorkspaceMeshCredential, operation: Extract<MeshRecordOperation, { kind: "device-revocation" | "device-restoration" }>,
  peers: Peers, profile: LocalProfile) {
  const peer = peers.find(item => item.deviceId === operation.deviceId && item.personId === operation.personId)
  if (operation.deviceId === profile.device.deviceId || !meshRustRuntime().state.canRemoveWorkspaceDevice(credential,
      profile.identity.personId, profile.identity.publicKey, profile.device.deviceId, operation.personId, operation.deviceId, peer?.personId))
    throw new Error("Device removal scope is no longer authorized")
}

function assertSuccessionOperation(credential: WorkspaceMeshCredential, operation: MeshRecordOperation, profile: LocalProfile) {
  const state = meshRustRuntime().state
  const catalog = credential.catalog as Catalog | undefined
  const policy = catalog?.successionPolicy
  const grant = credential.localGrant as WorkspaceGrant | undefined
  state.verifyWorkspaceSuccessionPolicy(policy, credential.workspaceId, { personId: credential.ownerPersonId,
    publicKey: credential.ownerPublicKey, certificates: credential.ownerCertificates }, Date.now())
  if (operation.kind === "vote") assertSuccessionVote(credential, operation, profile)
  if (operation.kind === "claim") state.planAuthorityCommand({ kind: "claim", localPersonId: profile.identity.personId,
    hasCredential: true, hasPolicy: Boolean(policy), grantRole: grant?.payload.role ?? null, grantPersonId: grant?.payload.personId ?? null })
}

function assertSuccessionVote(credential: WorkspaceMeshCredential, operation: Extract<MeshRecordOperation, { kind: "vote" }>, profile: LocalProfile) {
  const catalog = credential.catalog as Catalog | undefined
  const policy = catalog?.successionPolicy, grant = credential.localGrant as WorkspaceGrant | undefined
  const existing = catalog?.successionVotes?.find(vote => vote.signed.payload.voterPersonId === profile.identity.personId)
  const actions = meshRustRuntime().state.planAuthorityCommand({ kind: "vote", localPersonId: profile.identity.personId, hasCredential: true,
    hasPolicy: Boolean(policy), grantRole: grant?.payload.role ?? null, eligibleEditorPersonIds: policy?.payload.eligibleEditorPersonIds ?? [],
    successorPersonId: policy?.payload.successorPersonId ?? null, candidatePersonId: operation.candidatePersonId,
    existingVoteFor: existing?.signed.payload.candidatePersonId ?? null })
  if (!actions.includes("createVote")) throw new Error("This succession vote is already recorded")
}

/** Check operation-specific payload coordinates before any signing await. */
export function assertMeshRecordPayload(expected: WorkspaceMeshCredential, operation: MeshRecordOperation,
  profile: LocalProfile, payload: Record<string, unknown>) {
  if (operation.kind === "claim") return assertClaimPayload(expected, profile, payload)
  if (operation.kind === "vote") return assertVotePayload(expected, operation, profile, payload)
  if (operation.kind === "advertisement" &&
      (payload.personId !== profile.identity.personId || payload.deviceId !== profile.device.deviceId))
    throw new Error("Route signer does not match its device")
  const grant = expected.localGrant as WorkspaceGrant | undefined
  if (operation.kind === "departure" && (payload.personId !== profile.identity.personId || payload.accessEpoch !== (grant?.payload.accessEpoch ?? 1)))
    throw new Error("Departure does not match current membership")
  if ((operation.kind === "device-revocation" || operation.kind === "device-restoration") && (payload.personId !== operation.personId || payload.deviceId !== operation.deviceId))
    throw new Error("Device revocation does not match its authorized target")
}

function assertVotePayload(expected: WorkspaceMeshCredential, operation: Extract<MeshRecordOperation, { kind: "vote" }>,
  profile: LocalProfile, payload: Record<string, unknown>) {
  const catalog = expected.catalog as Catalog | undefined
  if (payload.candidatePersonId !== operation.candidatePersonId || payload.voterPersonId !== profile.identity.personId ||
      payload.policySignature !== catalog?.successionPolicy?.signature)
    throw new Error("Succession vote does not match its authorized policy and candidate")
}

function assertClaimPayload(expected: WorkspaceMeshCredential, profile: LocalProfile, payload: Record<string, unknown>) {
  if (payload.kind === "workspace-grant") {
    if (payload.personId !== expected.ownerPersonId || payload.role !== "editor" || payload.accessEpoch !== 1)
      throw new Error("Succession signer may only retain the former owner's editor access")
    return
  }
  const catalog = expected.catalog as Catalog | undefined
  const grant = expected.localGrant as WorkspaceGrant | undefined
  if (payload.toOwnerPersonId !== profile.identity.personId || payload.fromOwnerPersonId !== expected.ownerPersonId ||
      (payload.policy as WorkspaceSuccessionPolicy | undefined)?.signature !== catalog?.successionPolicy?.signature ||
      (payload.candidateGrant as WorkspaceGrant | undefined)?.signature !== grant?.signature || payload.epoch !== expected.epoch + 1)
    throw new Error("Succession claim does not match its authorized membership and policy")
}
