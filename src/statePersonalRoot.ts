import { sha256Base64Url, type LocalProfile } from "./domain/identity"
import {
  createPersonalRoot,
  pruneForeignGenesisWorkspaceRefs,
  reconcilePersonalRootWorkspaces,
  registerWorkspaceInRoot,
} from "./domain/personalRoot"
import type { WorkspaceStorage } from "./storage"

export async function initializePersonalRootCatalog(storage: WorkspaceStorage, profile: LocalProfile): Promise<void> {
  const workspaces = [...await storage.listWorkspaces(), ...await storage.listArchivedWorkspaces()]
  const ownerById = new Map<string, string>()
  for (const workspace of workspaces) {
    const loaded = await storage.loadWorkspaceDoc(workspace.id)
    if (loaded) ownerById.set(workspace.id, loaded.doc.ownerPersonId)
  }
  const certificate = new TextEncoder().encode(JSON.stringify(profile.certificate))
  const initialRoot = createPersonalRoot(profile, await sha256Base64Url(certificate))
  await storage.updatePersonalRootForIdentity(profile.identity.personId, async current => {
    let root = initialRoot
    if (current) {
      const { IdentityProfileConflictShadowError, reconcileIdentityProfileRootPresentation } = await import("./domain/identityProfileRoot")
      try { root = await reconcileIdentityProfileRootPresentation(current) }
      catch (cause) {
        if (cause instanceof IdentityProfileConflictShadowError) return current
        throw cause
      }
    }
    root.workspaces ??= {}
    const created = current === null
    const newlyAdded = created
      ? reconcilePersonalRootWorkspaces(root, workspaces.filter(workspace => ownerById.get(workspace.id) === profile.identity.personId))
      : []
    const removedStaleGenesisRefs = !created && root.identity.personId === profile.identity.personId
      ? pruneForeignGenesisWorkspaceRefs(root, ownerById).length > 0
      : false
    const presentationRepaired = current !== null && (root.identity.displayName !== current.identity.displayName ||
      JSON.stringify(root.photo) !== JSON.stringify(current.photo))
    return created || newlyAdded.length > 0 || removedStaleGenesisRefs || presentationRepaired ? root : current
  })
}

export async function registerWorkspaceInCurrentRoot(
  storage: WorkspaceStorage,
  profile: LocalProfile,
  workspaceId: string,
  grantHash: string,
): Promise<void> {
  await storage.updatePersonalRootForIdentity(profile.identity.personId, root => {
    if (!root) return null
    root.workspaces ??= {}
    registerWorkspaceInRoot(root, workspaceId, workspaceId, grantHash)
    return root
  })
}
