import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import { peerStore } from "./peerStore"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { workspaceRole } from "./changeAuthorization"
import { verifyBoardStorageAccess } from "./workspaceRustyAccess"
import type { WorkspaceMeshCredential, WorkspaceAuthorityRecord } from "./peerStore"
import type { LocalProfile } from "../domain/identity"

function assertMembership(current: WorkspaceMeshCredential | WorkspaceAuthorityRecord, profile: LocalProfile,
  grant: object, ownerPersonId: string, signerKeyId: string): void {
  const state = meshRustRuntime().state
  if (state.hasAuthorityConflict(current) || state.isDeviceRevoked(current, profile.identity.personId, profile.device.deviceId) ||
    state.isGrantRevoked(current, profile.identity.personId, grant) || state.hasLeftWorkspace(current, profile.identity.personId, grant) ||
    state.isDeviceRevoked(current, ownerPersonId, signerKeyId)) throw new Error("Participant storage access was revoked")
}

/** Received credentials cannot outlive locally admitted membership or change owner/service pins. */
export async function assertParticipantStorageAccess(app: Pick<ReturnType<typeof useTincanban>, "getCurrentProfile" | "readWorkspaceDoc">,
  config: BlindReplicaConfig): Promise<void> {
  if (!config.boardAccess) return
  const profile = app.getCurrentProfile()
  const credential = await peerStore.getWorkspaceCredential(config.workspaceId)
  const authority = await peerStore.getWorkspaceAuthority(config.workspaceId) ?? credential
  if (!profile || !credential || !authority || !credential.localGrant) throw new Error("Participant storage membership is unavailable")
  for (const current of [credential, authority]) {
    assertMembership(current, profile, credential.localGrant, authority.ownerPersonId, config.boardAccess.authorization.signerKeyId)
  }
  const role = await workspaceRole(await app.readWorkspaceDoc(config.workspaceId), profile)
  if (role !== "owner" && role !== "editor" && role !== "visitor") throw new Error("Participant storage role is unavailable")
  await verifyBoardStorageAccess(config, config.workspaceId, authority, role)
}
