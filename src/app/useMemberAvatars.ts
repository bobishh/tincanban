import { computed, onScopeDispose, ref, watch } from "vue"
import { memberAvatarData, memberProfileEntityId } from "../domain/avatarData"
import { defaultStorage } from "../storage"
import { newerIdentityPhoto, parseIdentityPhoto, saveIdentityPhoto, type IdentityPhoto } from "./identityPhoto"
import type { useTincanban } from "../state"

/** One identity preference; signed workspace profiles carry its public projection. */
export function useMemberAvatars(workspace: ReturnType<typeof useTincanban>) {
  const photo = ref<IdentityPhoto>()
  const avatarNotice = ref("")
  let disposed = false
  let queue = Promise.resolve()
  let photoOwner = ""
  const personId = () => workspace.getCurrentProfile()?.identity.personId
  const memberAvatars = computed<Record<string, string>>(() => {
    void workspace.docVersion.value
    const avatars = Object.fromEntries(Object.values(workspace.getActiveDoc()?.entities ?? {}).flatMap(entity => {
      if (entity.kind !== "member_profile") return []
      const data = memberAvatarData(entity.data)
      return data ? [[entity.personId, data]] : []
    }))
    const id = personId()
    if (id && photo.value && photoOwner === id) {
      if (photo.value.avatarData) avatars[id] = photo.value.avatarData
      else delete avatars[id]
    }
    return avatars
  })
  const currentAvatar = computed(() => memberAvatars.value[personId() ?? ""])
  const serial = (action: () => Promise<void>) => {
    const running = queue.then(action)
    queue = running.catch(() => {})
    return running
  }
  async function projectPhoto(value: IdentityPhoto, all: boolean) {
    if (!workspace.ready.value) return
    const id = personId()
    const active = workspace.getActiveDoc()?.id
    const ids = all ? workspace.availableWorkspaces.value.map(item => item.id) : active ? [active] : []
    let failed = 0
    for (const workspaceId of ids) {
      if (disposed || personId() !== id) return
      try {
        const doc = await workspace.readWorkspaceDoc(workspaceId)
        const entity = doc.entities[memberProfileEntityId(id!)]
        if (entity?.kind === "member_profile") {
          const projected = parseIdentityPhoto(JSON.parse(entity.data))
          if (entity.data === JSON.stringify(value) || newerIdentityPhoto(projected, value) === projected) continue
        }
        await workspace.executeWorkspaceCommandAsync(workspaceId, { kind: "setMemberAvatar", ...value })
      } catch { failed++ }
    }
    avatarNotice.value = failed ? "Photo saved. Sharing to some workspaces is pending; reopen them to retry." : ""
  }
  async function reconcilePhoto() {
    if (disposed) return
    const id = personId()
    if (!id) return
    if (photoOwner !== id) { photo.value = undefined; photoOwner = id; avatarNotice.value = "" }
    const root = await defaultStorage.loadPersonalRoot()
    if (root?.identity.personId !== id) return
    const stored = parseIdentityPhoto(root.photo)
    const entity = workspace.getActiveDoc()?.entities[memberProfileEntityId(id)]
    const incoming = entity?.kind === "member_profile" ? parseIdentityPhoto(JSON.parse(entity.data)) : undefined
    let chosen = newerIdentityPhoto(stored, incoming)
    if (!chosen || disposed || personId() !== id) return
    const changed = chosen !== stored
    if (changed) {
      const updated = await defaultStorage.updatePersonalRootForIdentity(id, current => {
        if (!current) throw new Error("Identity catalog is unavailable")
        return { ...current, photo: newerIdentityPhoto(parseIdentityPhoto(current.photo), chosen) }
      })
      chosen = parseIdentityPhoto(updated?.photo)
      if (!chosen) return
    }
    photo.value = chosen
    await projectPhoto(chosen, changed)
  }
  async function saveAvatar(avatarData: string | null): Promise<void> {
    await serial(async () => {
      const profile = workspace.getCurrentProfile()
      if (!profile) throw new Error("Identity is unavailable")
      const saved = await saveIdentityPhoto(profile, avatarData)
      if (personId() !== profile.identity.personId) throw new Error("Identity changed while saving photo")
      photoOwner = profile.identity.personId; photo.value = saved
      await projectPhoto(saved, true)
    })
  }
  const stop = watch(() => {
    void workspace.docVersion.value
    const doc = workspace.getActiveDoc()
    const entity = doc?.entities[memberProfileEntityId(personId() ?? "")]
    return `${workspace.ready.value}:${personId() ?? ""}:${doc?.id ?? ""}:${entity?.kind === "member_profile" ? entity.data : ""}`
  }, () => { void serial(reconcilePhoto).catch(() => { avatarNotice.value = "Profile photo could not load. Reload to retry." }) }, { immediate: true })
  onScopeDispose(() => { disposed = true; stop() })
  return { memberAvatars, currentAvatar, saveAvatar, avatarNotice }
}
