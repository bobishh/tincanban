import { ensureChatProfile } from "../chat/service"
import { renameIdentity } from "../domain/identity"
import { defaultStorage } from "../storage"

export async function saveIdentityName(name: string, workspaceId: string, refreshIdentity: () => Promise<void>) {
  const profile = await renameIdentity(name)
  await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, root => {
    if (!root) return null
    root.identity = { ...root.identity, displayName: profile.identity.displayName }
    return root
  })
  await refreshIdentity()
  const workspaces = await defaultStorage.listWorkspaces()
  const ids = [workspaceId, ...workspaces.map(workspace => workspace.id)].filter((id, index, all) => id && all.indexOf(id) === index)
  await Promise.allSettled(ids.map(id => ensureChatProfile(id, { updateName: true })))
}
