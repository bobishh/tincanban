import { computed, onScopeDispose, ref, watch } from "vue"
import { identityNameIsProvided } from "../domain/identityNameChoice"
import { memberAvatarData, memberProfileEntityId } from "../domain/avatarData"
import { defaultStorage } from "../storage"
import { parseIdentityPhoto, saveIdentityPhoto, type IdentityPhoto } from "./identityPhoto"
import type { PersonalRootDocumentV1 } from "../domain/model"
import type { useTincanban } from "../state"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"

async function readProfileChoices(root: PersonalRootDocumentV1) {
  const { rootIdentityProfileState } = await import("../domain/identityProfileRoot")
  const { identityProfileValue } = await import("../domain/identityProfileState")
  const { identityProfileRevision } = await import("../domain/identityProfileRevision")
  const state = await rootIdentityProfileState(root)
  const name = identityProfileValue(state, "name"), picture = identityProfileValue(state, "photo")
  const revision = await identityProfileRevision(state)
  const nameProvided = state.operations.some(operation => operation.signed.payload.field === "name") || await identityNameIsProvided(root.identity)
  return { name, picture, revision, nameProvided }
}

/** One identity preference; signed workspace profiles carry its public projection. */
export function useMemberAvatars(workspace: ReturnType<typeof useTincanban>) {
  const photo = ref<IdentityPhoto>()
  const avatarNotice = ref("")
  const profileConflicts = ref<{ names: string[]; photos: IdentityPhoto[] }>({ names: [], photos: [] })
  const profileRevision = ref("")
  const identityNameProvided = ref(false)
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
  function ownerIsCurrent(ownerId: string): boolean { return !disposed && personId() === ownerId }
  async function projectOnePhoto(workspaceId: string, value: IdentityPhoto, ownerId: string): Promise<"complete" | "failed" | "stale"> {
    if (!ownerIsCurrent(ownerId)) return "stale"
    try {
      const doc = await workspace.readWorkspaceDoc(workspaceId)
      if (!ownerIsCurrent(ownerId)) return "stale"
      const entity = doc.entities[memberProfileEntityId(ownerId)]
      if (entity?.kind === "member_profile") {
        const projected = parseIdentityPhoto(JSON.parse(entity.data))
        if (entity.data === JSON.stringify(value) || projected?.avatarData === value.avatarData) return "complete"
      }
      await workspace.executeWorkspaceCommandAsync(workspaceId, { kind: "setMemberAvatar", ...value })
      return ownerIsCurrent(ownerId) ? "complete" : "stale"
    } catch { return ownerIsCurrent(ownerId) ? "failed" : "stale" }
  }
  async function projectPhoto(value: IdentityPhoto, all: boolean, ownerId: string) {
    if (!workspace.ready.value || !ownerIsCurrent(ownerId)) return
    const active = workspace.getActiveDoc()?.id
    const ids = all ? workspace.availableWorkspaces.value.map(item => item.id) : active ? [active] : []
    let failed = 0
    for (const workspaceId of ids) {
      const result = await projectOnePhoto(workspaceId, value, ownerId)
      if (result === "stale") return
      if (result === "failed") failed++
    }
    avatarNotice.value = failed ? "Photo saved. Sharing to some workspaces is pending; reopen them to retry." : ""
  }
  async function updateProfileChoices(root: PersonalRootDocumentV1, ownerId: string) {
    const { name, picture, revision, nameProvided } = await readProfileChoices(root)
    if (!ownerIsCurrent(ownerId)) return false
    identityNameProvided.value = nameProvided
    profileRevision.value = revision
    profileConflicts.value = { names: name.status === "conflict" ? name.values.filter((value): value is string => typeof value === "string") : [],
      photos: picture.status === "conflict" ? picture.values.filter((value): value is IdentityPhoto => typeof value !== "string") : [] }
    return picture.status === "conflict"
  }
  function clearProfileChoices(): void {
    profileRevision.value = ""
    identityNameProvided.value = false
    profileConflicts.value = { names: [], photos: [] }
  }
  async function reconcilePhoto() {
    if (disposed) return
    const id = personId()
    if (!id) return
    if (photoOwner !== id) { photo.value = undefined; photoOwner = id; avatarNotice.value = ""; clearProfileChoices() }
    const root = await defaultStorage.loadPersonalRoot()
    if (!ownerIsCurrent(id)) return
    if (root?.identity.personId !== id) {
      clearProfileChoices()
      photo.value = undefined
      avatarNotice.value = ""
      return
    }
    const stored = parseIdentityPhoto(root.photo)
    const entity = workspace.getActiveDoc()?.entities[memberProfileEntityId(id)]
    const incoming = entity?.kind === "member_profile" ? parseIdentityPhoto(JSON.parse(entity.data)) : undefined
    const conflicted = await updateProfileChoices(root, id)
    const chosen = stored ?? incoming
    if (!chosen) return
    if (!ownerIsCurrent(id)) return
    photo.value = chosen
    if (conflicted) { avatarNotice.value = "Photo changes need a choice in Settings → Identity."; return }
    if (stored) await projectPhoto(stored, false, id)
  }
  async function saveAvatar(avatarData: string | null): Promise<void> {
    await serial(async () => {
      const profile = workspace.getCurrentProfile()
      if (!profile) throw new Error("Identity is unavailable")
      const saved = await saveIdentityPhoto(profile, avatarData)
      if (personId() !== profile.identity.personId) throw new Error("Identity changed while saving photo")
      photoOwner = profile.identity.personId; photo.value = saved
      await projectPhoto(saved, true, profile.identity.personId)
    })
  }
  const stop = watch(() => {
    void workspace.docVersion.value
    const doc = workspace.getActiveDoc()
    const entity = doc?.entities[memberProfileEntityId(personId() ?? "")]
    return `${workspace.ready.value}:${personId() ?? ""}:${doc?.id ?? ""}:${entity?.kind === "member_profile" ? entity.data : ""}`
  }, () => { void serial(reconcilePhoto).catch(() => { avatarNotice.value = "Profile photo could not load. Reload to retry." }) }, { immediate: true })
  const unsubscribe = subscribeIdentityDevicePreferences(owner => {
    if (disposed || owner !== personId()) return
    void serial(reconcilePhoto).catch(() => { avatarNotice.value = "Profile photo could not load. Reload to retry." })
  })
  onScopeDispose(() => { disposed = true; stop(); unsubscribe() })
  return { memberAvatars, currentAvatar, saveAvatar, avatarNotice, profileConflicts, profileRevision, identityNameProvided }
}
