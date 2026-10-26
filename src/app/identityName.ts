import { ensureChatProfile } from "../chat/service"
import { bootstrapIdentity, renameIdentity } from "../domain/identity"
import { compareAndSwapLocal } from "../localDb"
import { planPersonalRootUpdate } from "../storagePersonalRoot"
import { defaultStorage } from "../storage"
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"
import { planIdentityNameChoice } from "../domain/identityNameChoice"
import { isAvatarDataUrl } from "../domain/avatarData"

const maxRenameAttempts = 32

export async function publishIdentityNameToChat(workspaceId?: string): Promise<void> {
  const workspaces = await defaultStorage.listWorkspaces()
  const ids = new Set(workspaces.map(workspace => workspace.id).filter(id => id.length > 0))
  if (workspaceId) ids.add(workspaceId)
  await Promise.allSettled([...ids].map(id => ensureChatProfile(id, { updateName: true })))
}

export async function saveIdentityName(name: string, workspaceId: string, refreshIdentity: () => Promise<void>,
  draft: { avatarData?: string | null; expectedRevision?: string } = {}) {
  draft = { ...draft }
  if (draft.avatarData !== undefined && draft.avatarData !== null && !isAvatarDataUrl(draft.avatarData)) throw new Error("Profile photo must be a small WebP or JPEG image")
  const signingProfile = await bootstrapIdentity()
  const profile = await renameIdentity(name, async (rename, ensureCurrent) => {
    const { personId, displayName } = rename.publicProfile.identity
    for (let attempt = 0; attempt < maxRenameAttempts; attempt += 1) {
      const { editIdentityProfileRoot, assertIdentityProfileRevision } = await import("../domain/identityProfileRoot")
      const rootPlan = await planPersonalRootUpdate(personId, async root => {
        if (!root) throw new Error("Personal root is missing for this identity")
        if (draft.expectedRevision !== undefined) await assertIdentityProfileRevision(root, draft.expectedRevision)
        let next = await editIdentityProfileRoot(root, signingProfile, "name", displayName, ensureCurrent)
        if (draft.avatarData !== undefined) next = await editIdentityProfileRoot(next, signingProfile, "photo",
          { avatarData: draft.avatarData, changedAt: new Date().toISOString() }, ensureCurrent)
        return next
      })
      const choice = await planIdentityNameChoice(personId)
      const committed = await compareAndSwapLocal({
        conditions: [...choice.conditions, ...rootPlan.conditions, { key: rename.storageKey, value: rename.previousProfile }],
        writes: [...choice.writes, ...rootPlan.writes, { key: rename.storageKey, value: rename.candidateProfile }],
      }, ensureCurrent)
      if (committed) return
    }
    throw new Error("Identity name changed too often to save safely")
  })
  identityDevicePreferencesChanged(profile.identity.personId)
  await refreshIdentity()
  await publishIdentityNameToChat(workspaceId)
}
