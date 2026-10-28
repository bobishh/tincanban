import { sha256Base64Url, isCurrentIdentityProfile, type LocalProfile } from "./domain/identity"
import { save, free } from "@automerge/automerge/slim"
import {
  createPersonalRoot,
  pruneForeignGenesisWorkspaceRefs,
  reconcilePersonalRootWorkspaces,
  registerWorkspaceInRoot,
} from "./domain/personalRoot"
import type { WorkspaceStorage } from "./storage"
import { createLocalRootIdentityAuthorityView } from "@meta-uber/mesh-identity"
import { defaultProofStore } from "./domain/proofs"
import { rootIdentityProfileState } from "./domain/identityProfileRoot"
import { mergeIdentityAuthorityView } from "./sync/identityAuthorityStore"
import { hasPendingLocalWorkspaceOwnershipIntent } from "./sync/localWorkspaceOwnershipIntent"

export async function initializePersonalRootCatalog(storage: WorkspaceStorage, profile: LocalProfile): Promise<void> {
  const workspaces = [...await storage.listWorkspaces(), ...await storage.listArchivedWorkspaces()]
  const ownerById = new Map<string, string>()
  for (const workspace of workspaces) {
    const loaded = await storage.loadWorkspaceDoc(workspace.id)
    if (loaded) {
      try { ownerById.set(workspace.id, loaded.doc.ownerPersonId) }
      finally { free(loaded.doc) }
    }
  }
  const certificate = new TextEncoder().encode(JSON.stringify(profile.certificate))
  const initialRoot = createPersonalRoot(profile, await sha256Base64Url(certificate))
  let created = false
  await storage.updatePersonalRootForIdentity(profile.identity.personId, async current => {
    let root = initialRoot
    if (current) {
      const { reconcileIdentityProfileRootPresentation } = await import("./domain/identityProfileRoot")
      try { root = await reconcileIdentityProfileRootPresentation(current) }
      catch { return current }
    }
    root.workspaces ??= {}
    created = current === null
    const sameIdentityRoot = root.identity.personId === profile.identity.personId
    const newlyAdded = sameIdentityRoot
      ? reconcilePersonalRootWorkspaces(root, workspaces.filter(workspace => ownerById.get(workspace.id) === profile.identity.personId))
      : []
    const removedStaleGenesisRefs = !created && sameIdentityRoot
      ? pruneForeignGenesisWorkspaceRefs(root, ownerById).length > 0
      : false
    const presentationRepaired = current !== null && (root.identity.displayName !== current.identity.displayName ||
      JSON.stringify(root.photo) !== JSON.stringify(current.photo))
    return created || newlyAdded.length > 0 || removedStaleGenesisRefs || presentationRepaired ? root : current
  })
  if (created && profile.privateKeys.identityPrivateKey) {
    const storedRoot = await storage.loadPersonalRoot()
    if (storedRoot?.identity.personId === profile.identity.personId) {
      const certificates = [profile.certificate, ...await defaultProofStore.listCertificates()]
        .filter(item => item.payload.personId === profile.identity.personId)
      const view = await createLocalRootIdentityAuthorityView(profile,
        { certificates, revocations: [] }, await rootIdentityProfileState(storedRoot))
      await mergeIdentityAuthorityView(view)
    }
  }
  if (await hasPendingLocalWorkspaceOwnershipIntent(profile.device.deviceId)) {
    const { completePendingLocalWorkspaceOwnershipTransfer } = await import("./sync/localWorkspaceOwnership")
    await completePendingLocalWorkspaceOwnershipTransfer({ profile,
      ensureCurrent: () => {
        if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed before registering added boards")
      },
      workspaceStore: { read: async workspaceId => {
        const loaded = await storage.loadWorkspaceDoc(workspaceId)
        if (!loaded) throw new Error("Added board is unavailable; its ownership registration remains pending")
        try { return save(loaded.doc) } finally { free(loaded.doc) }
      } },
      registerOwnerReference: reference => registerWorkspaceInCurrentRoot(storage, profile, reference.workspaceId, reference.ownerGrantHash),
    })
  }
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
