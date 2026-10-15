import { publicKeyId, type LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import { peerStore, type WorkspaceAuthorityRecord, type WorkspaceMeshCredential } from "./peerStore"

type OwnerAuthority = WorkspaceAuthorityRecord | WorkspaceMeshCredential
export type ReadWorkspaceOwnerAuthority = () => Promise<OwnerAuthority | null>

/** An owner action retains one authority revision across every asynchronous signing step. */
export async function workspaceOwnerSigningContext(profile: LocalProfile, workspaceId: string, purpose: string,
  binding: Record<string, string | number>, readAuthority: ReadWorkspaceOwnerAuthority = async () =>
    await peerStore.getWorkspaceAuthority(workspaceId) ?? await peerStore.getWorkspaceCredential(workspaceId),
  scopeField: "workspaceId" | "scopeId" = "workspaceId") {
  const currentAuthority = async () => {
    const authority = await readAuthority()
    if (!authority || authority.workspaceId !== workspaceId || authority.ownerPersonId !== profile.identity.personId ||
      authority.ownerPublicKey !== profile.identity.publicKey || await publicKeyId(authority.ownerPublicKey) !== authority.ownerPersonId) {
      throw new Error("Current workspace owner authority is unavailable")
    }
    const state = meshRustRuntime().state
    if (state.hasAuthorityConflict(authority) || state.isDeviceRevoked(authority, profile.identity.personId, profile.device.deviceId)) {
      throw new Error("Workspace owner authority is revoked or conflicting")
    }
    const snapshot = (authority as WorkspaceAuthorityRecord).scopeAuthoritySnapshot
    if (snapshot) {
      const validated = state.validateScopeAuthority(snapshot, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }
      }
      if (validated.scopeId !== workspaceId || validated.controller.personId !== profile.identity.personId ||
        validated.controller.publicKey !== profile.identity.publicKey) throw new Error("Workspace owner authority does not match its signed scope")
    }
    const stable = { ...authority } as Record<string, unknown>
    delete stable.updatedAt
    delete stable.transportSecret
    return canonicalAuthorityJson(stable)
  }
  const revision = await currentAuthority()
  const unchangedAuthority = async () => {
    if (await currentAuthority() !== revision) throw new Error("Workspace owner authority changed while signing")
    return revision
  }
  return resolveLocalSigningContext(profile, purpose, { ...binding, [scopeField]: workspaceId }, { currentAuthority: unchangedAuthority })
}
