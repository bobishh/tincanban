import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { LocalProfile } from "../domain/identity"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import type { DeviceCertificate } from "../domain/model"
import type { PeerStore, WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"
import { verifyWorkspaceMemberBundle, type WorkspaceMemberBundle } from "./meshRecords"
import type { WorkspaceAuthority } from "@meta-uber/mesh-workspace"
import { ownerAuthorities } from "./durableMeshBase"

export function createDurablePeerHistoryGuard(input: {
  workspaceId: string; deviceId: string; remotePersonId: string; transportSecret: string; profile: LocalProfile; store: PeerStore;
  profileProvider(): Promise<LocalProfile>
  assertSession(): void
}): () => Promise<void> {
  return async () => {
    input.assertSession()
    const [profile, credential, authority, peer] = await Promise.all([
      input.profileProvider(), input.store.getWorkspaceCredential(input.workspaceId), input.store.getWorkspaceAuthority(input.workspaceId),
      input.store.getPeer(input.workspaceId, input.deviceId),
    ])
    input.assertSession()
    assertLocalProfile(profile, input.profile)
    const remote = requireRemoteDevice(credential, peer, input)
    const bundle = remote.peer.advertisement as WorkspaceMemberBundle | undefined
    if (!bundle) throw new Error("Direct peer device authorization is unavailable")
    const ownerState = authority ?? remote.credential
    const currentPeer = await verifyWorkspaceMemberBundle(bundle, { workspaceId: input.workspaceId,
      ownerPersonId: ownerState.ownerPersonId, ownerPublicKey: ownerState.ownerPublicKey,
      ownerCertificates: ownerState.ownerCertificates as DeviceCertificate[],
      ownerHistory: ownerHistory(authority, remote.credential) })
    input.assertSession()
    const [latestCredential, latestAuthority, latestPeer] = await Promise.all([
      input.store.getWorkspaceCredential(input.workspaceId), input.store.getWorkspaceAuthority(input.workspaceId),
      input.store.getPeer(input.workspaceId, input.deviceId),
    ])
    input.assertSession()
    if (!latestCredential || !latestPeer || canonicalAuthorityJson({ credential, authority, peer }) !==
      canonicalAuthorityJson({ credential: latestCredential, authority: latestAuthority, peer: latestPeer })) {
      throw new Error("Direct peer authorization changed during history transfer")
    }
    assertPeerIdentity(currentPeer, input, remote.credential)
    assertPoliciesCurrent(remote.credential, authority, profile, currentPeer.advertisement.payload.personId, input.deviceId, bundle.grant ?? null)
    input.assertSession()
  }
}

function assertLocalProfile(current: LocalProfile, expected: LocalProfile): void {
  if (current.identity.personId !== expected.identity.personId || current.device.deviceId !== expected.device.deviceId) {
    throw new Error("Local mesh identity changed during direct history transfer")
  }
}

function requireRemoteDevice(credential: WorkspaceMeshCredential | null | undefined, peer: Awaited<ReturnType<PeerStore["getPeer"]>>,
  input: { workspaceId: string; deviceId: string; remotePersonId: string; transportSecret: string }): { credential: WorkspaceMeshCredential; peer: NonNullable<typeof peer> } {
  if (!credential || credential.transportSecret !== input.transportSecret || !peer || peer.personId !== input.remotePersonId ||
      peer.deviceId !== input.deviceId || peer.revokedAt) throw new Error("Direct peer workspace access changed")
  return { credential, peer }
}

function ownerHistory(authority: WorkspaceAuthorityRecord | null, credential: WorkspaceMeshCredential): WorkspaceAuthority[] {
  if (!authority?.ownerHistory) return ownerAuthorities(credential).slice(1)
  return authority.ownerHistory.map(owner => ({ personId: owner.personId, publicKey: owner.publicKey,
    certificates: owner.certificates as DeviceCertificate[] }))
}

function assertPeerIdentity(peer: Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>,
  input: { workspaceId: string; deviceId: string; remotePersonId: string }, credential: WorkspaceMeshCredential): void {
  const identity = peer.advertisement.payload
  if (identity.personId !== input.remotePersonId || identity.deviceId !== input.deviceId || credential.workspaceId !== input.workspaceId) {
    throw new Error("Direct peer identity changed")
  }
}

function assertPoliciesCurrent(credential: WorkspaceMeshCredential, authority: WorkspaceAuthorityRecord | null,
  profile: LocalProfile, remotePersonId: string, remoteDeviceId: string, grant: NonNullable<WorkspaceMemberBundle["grant"]> | null): void {
  const state = meshRustRuntime().state
  const authorities = [credential, ...(authority ? [authority] : [])]
  if (authorities.some(current => state.hasAuthorityConflict(current) ||
      state.isDeviceRevoked(current, remotePersonId, remoteDeviceId) ||
      state.isGrantRevoked(current, remotePersonId, grant) || state.hasLeftWorkspace(current, remotePersonId, grant) ||
      state.isDeviceRevoked(current, profile.identity.personId, profile.device.deviceId) ||
      state.isGrantRevoked(current, profile.identity.personId, credential.localGrant ?? null) ||
      state.hasLeftWorkspace(current, profile.identity.personId, credential.localGrant ?? null))) {
    throw new Error("Direct peer workspace access was revoked")
  }
}
