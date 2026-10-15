import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import type { LocalProfile } from "../domain/identity"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import type { PeerStore, WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"
import type { BlobAuthoritySnapshot } from "./durableMeshBlobFetch"

type WorkspaceBlobStore = { resolve(workspaceId: string, blobId: string): Promise<BlobDescriptor | undefined> }

export async function readDurableMeshTransferAuthority(input: {
  workspaceId: string; descriptor?: BlobDescriptor; getProfile(): Promise<LocalProfile>; store: PeerStore;
  blob?: WorkspaceBlobStore; revokedWorkspaceIds(credentials: WorkspaceMeshCredential[], profile: LocalProfile): Promise<string[]>
}): Promise<BlobAuthoritySnapshot> {
  const [rawProfile, rawCredential, authority, referenced] = await Promise.all([
    input.getProfile(), input.store.getWorkspaceCredential(input.workspaceId), input.store.getWorkspaceAuthority(input.workspaceId),
    input.descriptor ? input.blob?.resolve(input.workspaceId, input.descriptor.blobId) : undefined,
  ])
  if (!rawCredential) throw new Error("Workspace mesh credential is unavailable")
  const profile = structuredClone(rawProfile)
  const credential = structuredClone(rawCredential)
  assertAttachmentMembership(credential, authority)
  assertAttachmentReference(input.descriptor, referenced)
  await assertAttachmentAccess(input, profile, credential, authority)
  const credentialAuthority: Record<string, unknown> = { ...credential }
  delete credentialAuthority.updatedAt
  const stableAuthority: Record<string, unknown> | null = authority ? { ...authority } : null
  if (stableAuthority) delete stableAuthority.updatedAt
  return { profile, identity: canonicalAuthorityJson({ identity: profile.identity, device: profile.device, certificate: profile.certificate }),
    credential: canonicalAuthorityJson({ credential: credentialAuthority, authority: stableAuthority,
      referenced: referenced ? descriptorIdentity(referenced) : null }), transportSecret: credential.transportSecret }
}

function assertAttachmentMembership(credential: WorkspaceMeshCredential, authority: Awaited<ReturnType<PeerStore["getWorkspaceAuthority"]>>) {
  if (authority && (authority.ownerPersonId !== credential.ownerPersonId || authority.ownerPublicKey !== credential.ownerPublicKey ||
      authority.epoch !== credential.epoch)) throw new Error("Workspace attachment authority does not match current membership")
}

function descriptorIdentity(value: BlobDescriptor): string {
  return canonicalAuthorityJson([value.blobId, value.name, value.mediaType, value.size, value.hash ?? null])
}

function assertAttachmentReference(descriptor?: BlobDescriptor, referenced?: BlobDescriptor) {
  if (descriptor && (!referenced || descriptorIdentity(referenced) !== descriptorIdentity(descriptor))) {
    throw new Error("Attachment reference is missing or changed")
  }
}

async function assertAttachmentAccess(
  input: { workspaceId: string; store: PeerStore; revokedWorkspaceIds(credentials: WorkspaceMeshCredential[], profile: LocalProfile): Promise<string[]> },
  profile: LocalProfile, credential: WorkspaceMeshCredential,
  authority: Awaited<ReturnType<PeerStore["getWorkspaceAuthority"]>>,
) {
  const state = meshRustRuntime().state
  for (const current of [credential, ...(authority ? [authority] : [])]) assertCurrentAuthority(state, current, profile, credential)
  if ((await input.revokedWorkspaceIds([credential], profile)).includes(input.workspaceId)) {
    throw new Error("Workspace access was revoked during blob transfer")
  }
  const partition = state.partitionCredentials({ credentials: [credential], personId: profile.identity.personId,
    publicKey: profile.identity.publicKey, deviceId: profile.device.deviceId })
  if (!partition.activeIndices.includes(0)) throw new Error("Workspace mesh identity changed during blob transfer")
}

function assertCurrentAuthority(state: ReturnType<typeof meshRustRuntime>["state"], current: WorkspaceMeshCredential | WorkspaceAuthorityRecord,
  profile: LocalProfile, credential: WorkspaceMeshCredential) {
  if (state.hasAuthorityConflict(current) || state.isDeviceRevoked(current, profile.identity.personId, profile.device.deviceId) ||
      state.isGrantRevoked(current, profile.identity.personId, credential.localGrant ?? null) ||
      state.hasLeftWorkspace(current, profile.identity.personId, credential.localGrant ?? null)) {
    throw new Error("Workspace attachment authority is revoked or conflicting")
  }
}
