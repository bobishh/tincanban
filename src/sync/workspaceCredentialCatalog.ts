import type { DeviceCertificate } from "../domain/model"
import type {
  WorkspaceAuthority, WorkspaceDeparture, WorkspaceDeviceRevocation, WorkspaceOwnershipTransfer,
  WorkspaceRevocation, WorkspaceSuccessionClaim, WorkspaceSuccessionPolicy, WorkspaceSuccessionVote,
} from "./meshRecords"
import type { WorkspaceMeshCredential } from "./peerStore"

type MeshCatalog = {
  departures?: WorkspaceDeparture[]
  deviceRevocations?: WorkspaceDeviceRevocation[]
  revocations?: WorkspaceRevocation[]
  ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy
  successionVotes?: WorkspaceSuccessionVote[]
  successionClaims?: WorkspaceSuccessionClaim[]
}

export function meshCatalog(credential: Pick<WorkspaceMeshCredential, "catalog">): MeshCatalog {
  return (credential.catalog as MeshCatalog | undefined) ?? {}
}

export function revocations(credential: Pick<WorkspaceMeshCredential, "catalog">): WorkspaceRevocation[] {
  const value = meshCatalog(credential)
  return Array.isArray(value.revocations) ? value.revocations : []
}

export function ownershipTransfers(credential: WorkspaceMeshCredential): WorkspaceOwnershipTransfer[] {
  const value = meshCatalog(credential)
  return Array.isArray(value.ownershipTransfers) ? value.ownershipTransfers : []
}

export function successionPolicy(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionPolicy }
export function successionVotes(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionVotes ?? [] }
export function successionClaims(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionClaims ?? [] }

export function ownerAuthorities(credential: WorkspaceMeshCredential): WorkspaceAuthority[] {
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] }, ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

export function deviceRevocations(credential: WorkspaceMeshCredential): WorkspaceDeviceRevocation[] {
  return meshCatalog(credential).deviceRevocations ?? []
}

export function departures(credential: WorkspaceMeshCredential): WorkspaceDeparture[] { return meshCatalog(credential).departures ?? [] }
