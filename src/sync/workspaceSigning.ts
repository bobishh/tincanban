import type * as Automerge from "@automerge/automerge/slim"
import type { LocalProfile } from "../domain/identity"
import { signingEvidence, type VerifiedSigningContext } from "../domain/signingContext"
import type { WorkspaceDocumentV2, WorkspaceGrant } from "../domain/model"
import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"
import type { WorkspaceRole } from "../domain/permissions"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

type StoredAuthority = WorkspaceMeshCredential | WorkspaceAuthorityRecord
type ReadAuthority = { authority: StoredAuthority | null; invalid: boolean }

export type WorkspaceSigningContextFactory = (purpose: string, binding: Record<string, string | number>,
  currentAuthority: () => Promise<string>) => Promise<VerifiedSigningContext>

export type WorkspaceSigningPorts = {
  readAuthority: () => Promise<ReadAuthority>
  authorityFingerprint: (authority: StoredAuthority | null) => string
  workspaceRole: (doc: WorkspaceDocumentV2, profile: LocalProfile) => Promise<WorkspaceRole>
}

export async function workspaceSigningContext(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile,
  purpose: string, scopeField: string, factory: WorkspaceSigningContextFactory | undefined, ports: WorkspaceSigningPorts) {
  const currentAuthority = async () => {
    const stored = await ports.readAuthority()
    if (stored.invalid) throw new Error("Workspace signing authority could not be verified")
    await assertWorkspaceSigningAccess(doc, profile, stored.authority, purpose, ports.workspaceRole)
    return ports.authorityFingerprint(stored.authority)
  }
  const revision = await currentAuthority()
  const requireCurrent = async () => {
    const latest = await currentAuthority()
    if (latest !== revision) throw new Error("Workspace signing authority is stale")
    return latest
  }
  const binding = { [scopeField]: doc.id }
  const context = factory ? await factory(purpose, binding, requireCurrent)
    : await (await import("../domain/localSigningContext")).resolveLocalSigningContext(profile, purpose, binding,
      { currentAuthority: requireCurrent })
  const evidence = signingEvidence(context)
  if (context.personId !== profile.identity.personId || context.deviceId !== profile.device.deviceId ||
      context.purpose !== purpose || evidence.identity.publicKey !== profile.identity.publicKey ||
      evidence.certificates[0]?.signature !== profile.certificate.signature) {
    throw new Error("Workspace signing context does not match its author")
  }
  await requireCurrent()
  return { context, requireCurrent }
}

async function assertWorkspaceSigningAccess(doc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile,
  authority: StoredAuthority | null, purpose: string, workspaceRole: WorkspaceSigningPorts["workspaceRole"]) {
  const state = meshRustRuntime().state
  if (authority && (state.hasAuthorityConflict(authority) ||
      state.isDeviceRevoked(authority, profile.identity.personId, profile.device.deviceId) ||
      state.isGrantRevoked(authority, profile.identity.personId, authority.localGrant ?? null))) {
    throw new Error("Workspace signing permission is revoked or conflicting")
  }
  if (!authority) {
    if (doc.ownerPersonId === profile.identity.personId && (purpose === "scope-genesis" || typeof indexedDB === "undefined")) return
    throw new Error("Workspace signing permission is unavailable")
  }
  const role = await workspaceRole(doc, profile)
  if (signingRoleAllowed(role, purpose, authority, profile)) return
  throw new Error("Workspace signing permission is unavailable")
}

function signingRoleAllowed(role: WorkspaceRole, purpose: string, authority: StoredAuthority, profile: LocalProfile): boolean {
  if (purpose === "scope-genesis" || purpose === "rusty-writer-policy") return role === "owner"
  if (purpose === "attachment-upload") return role === "owner" || role === "editor"
  if (purpose === "attachment-read" || purpose === "history-recovery-read") {
    if (role === "owner" || role === "editor") return true
    return verifiedVisitor(role, authority, profile)
  }
  if (purpose !== "workspace-changes") return false
  if (role === "owner" || role === "editor" || role === "automation") return true
  return verifiedVisitor(role, authority, profile)
}

function verifiedVisitor(role: WorkspaceRole, authority: StoredAuthority, profile: LocalProfile): boolean {
  const grant = authority.localGrant as WorkspaceGrant | undefined
  return role === "visitor" && grant?.payload.role === "visitor" &&
    meshRustRuntime().state.credentialBelongsToProfile(authority, profile.identity.personId, profile.identity.publicKey)
}
