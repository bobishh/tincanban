import { computed, onScopeDispose, ref, watch, type Ref } from "vue"
import { identityNameIsProvided } from "../domain/identityNameChoice"
import { memberAvatarData, memberProfileEntityId } from "../domain/avatarData"
import { defaultStorage } from "../storage"
import { parseIdentityPhoto, saveIdentityPhoto, type IdentityPhoto } from "./identityPhoto"
import type { PersonalRootDocumentV1 } from "../domain/model"
import type { useTincanban } from "../state"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"

async function readProfileChoices(root: PersonalRootDocumentV1, ownerIsCurrent: () => boolean) {
  const { reconcileIdentityProfileRootPresentation, rootIdentityProfileState } = await import("../domain/identityProfileRoot")
  const { identityProfileValue } = await import("../domain/identityProfileState")
  const { identityProfileRevision } = await import("../domain/identityProfileRevision")
  let profileRoot = root
  const projected = await reconcileIdentityProfileRootPresentation(root)
  if (projected.identity.displayName !== root.identity.displayName || JSON.stringify(projected.photo) !== JSON.stringify(root.photo)) {
    if (!ownerIsCurrent()) throw new Error("Identity changed while restoring its verified profile presentation")
    const saved = await defaultStorage.updatePersonalRootForIdentity(root.identity.personId, async current => {
      if (!ownerIsCurrent()) throw new Error("Identity changed while restoring its verified profile presentation")
      if (!current || current.rootId !== root.rootId || JSON.stringify(current.profileState) !== JSON.stringify(root.profileState)) {
        throw new Error("Saved Identity profile changed while restoring its presentation")
      }
      const latest = await reconcileIdentityProfileRootPresentation(current)
      if (!ownerIsCurrent()) throw new Error("Identity changed while restoring its verified profile presentation")
      return latest
    })
    if (!saved) throw new Error("Verified Identity profile could not be saved")
    profileRoot = saved
  }
  const state = await rootIdentityProfileState(profileRoot)
  const name = identityProfileValue(state, "name"), picture = identityProfileValue(state, "photo")
  const revision = await identityProfileRevision(state)
  const nameProvided = state.operations.some(operation => operation.signed.payload.field === "name") || await identityNameIsProvided(profileRoot.identity)
  return { name, picture, revision, nameProvided, storedPhoto: profileRoot.photo }
}

function photoProjector(workspace: ReturnType<typeof useTincanban>, isOwnerCurrent: (ownerId: string) => boolean,
  canProject: () => boolean, setNotice: (value: string) => void) {
  async function projectOne(workspaceId: string, value: IdentityPhoto, ownerId: string): Promise<"complete" | "failed" | "stale"> {
    if (!isOwnerCurrent(ownerId) || !canProject()) return "stale"
    try {
      const doc = await workspace.readWorkspaceDoc(workspaceId)
      if (!isOwnerCurrent(ownerId) || !canProject()) return "stale"
      const entity = doc.entities[memberProfileEntityId(ownerId)]
      if (entity?.kind === "member_profile") {
        const projected = parseIdentityPhoto(JSON.parse(entity.data))
        if (entity.data === JSON.stringify(value) || projected?.avatarData === value.avatarData) return "complete"
      }
      await workspace.executeWorkspaceCommandAsync(workspaceId, { kind: "setMemberAvatar", ...value })
      return isOwnerCurrent(ownerId) ? "complete" : "stale"
    } catch { return isOwnerCurrent(ownerId) ? "failed" : "stale" }
  }
  return async (value: IdentityPhoto, ownerId: string): Promise<void> => {
    if (!workspace.ready.value || !isOwnerCurrent(ownerId) || !canProject()) return
    const active = workspace.getActiveDoc()?.id
    const ids = [...new Set([...(active ? [active] : []), ...workspace.availableWorkspaces.value.map(item => item.id)])]
    let failed = 0
    for (const workspaceId of ids) {
      const result = await projectOne(workspaceId, value, ownerId)
      if (result === "stale") return
      if (result === "failed") failed++
    }
    setNotice(failed ? "Photo saved. Sharing to some workspaces is pending; retrying automatically." : "")
  }
}

class ProfileReadFailure extends Error {
  constructor(readonly stage: string, cause: unknown) {
    super("Saved Identity profile could not be verified", { cause })
  }
}

async function readOwnerProfilePhoto(workspace: ReturnType<typeof useTincanban>, ownerId: string,
  ownerIsCurrent: (ownerId: string) => boolean,
  updateProfileChoices: (root: PersonalRootDocumentV1, ownerId: string) => Promise<{ conflicted: boolean; storedPhoto?: IdentityPhoto }>) {
  let stage = "personal-root-read"
  try {
    const root = await defaultStorage.loadPersonalRoot()
    if (!ownerIsCurrent(ownerId)) return undefined
    if (root?.identity.personId !== ownerId) return undefined
    stage = "workspace-photo-read"
    const entity = workspace.getActiveDoc()?.entities[memberProfileEntityId(ownerId)]
    const incoming = entity?.kind === "member_profile" ? parseIdentityPhoto(JSON.parse(entity.data)) : undefined
    stage = "identity-profile-history-read"
    const { conflicted, storedPhoto } = await updateProfileChoices(root, ownerId)
    const stored = parseIdentityPhoto(storedPhoto)
    return { conflicted, photo: stored ?? incoming, stored }
  } catch (cause) {
    throw new ProfileReadFailure(stage, cause)
  }
}

function logProfileReadFailure(cause: unknown): void {
  const failure = cause instanceof ProfileReadFailure ? cause : new ProfileReadFailure("identity-profile-history-read", cause)
  const original = failure.cause
  const error = original instanceof Error ? original : new Error("Unknown profile read failure")
  const code = typeof original === "object" && original !== null && "code" in original && typeof original.code === "string"
    ? original.code : undefined
  console.error("[tincanban.identity-profile] read failed", { stage: failure.stage, errorName: error.name, ...(code ? { code } : {}) })
}

/** One identity preference; signed workspace profiles carry its public projection. */
export function useMemberAvatars(workspace: ReturnType<typeof useTincanban>, contextReady?: Readonly<Ref<boolean>>) {
  const photo = ref<IdentityPhoto>()
  const avatarNotice = ref("")
  const profileLoadError = ref("")
  const profileConflicts = ref<{ names: string[]; photos: IdentityPhoto[] }>({ names: [], photos: [] })
  const profileRevision = ref("")
  const identityNameProvided = ref(false)
  let disposed = false
  let queue = Promise.resolve()
  let photoOwner = ""
  let projectionRetry: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 5_000
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
  const canProject = () => contextReady?.value ?? true
  const projectPhoto = photoProjector(workspace, ownerIsCurrent, canProject, value => {
    avatarNotice.value = value
    clearTimeout(projectionRetry)
    projectionRetry = undefined
    if (!value) { retryDelay = 5_000; return }
    if (disposed) return
    projectionRetry = setTimeout(() => { projectionRetry = undefined; void serial(reconcilePhoto) }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 60_000)
  })
  async function updateProfileChoices(root: PersonalRootDocumentV1, ownerId: string) {
    const { name, picture, revision, nameProvided, storedPhoto } = await readProfileChoices(root, () => ownerIsCurrent(ownerId))
    if (!ownerIsCurrent(ownerId)) return { conflicted: false }
    identityNameProvided.value = nameProvided
    profileRevision.value = revision
    profileLoadError.value = ""
    profileConflicts.value = { names: name.status === "conflict" ? name.values.filter((value): value is string => typeof value === "string") : [],
      photos: picture.status === "conflict" ? picture.values.filter((value): value is IdentityPhoto => typeof value !== "string") : [] }
    return { conflicted: picture.status === "conflict", storedPhoto }
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
    try {
      profileLoadError.value = ""
      if (photoOwner !== id) { photo.value = undefined; photoOwner = id; avatarNotice.value = ""; clearProfileChoices() }
      const result = await readOwnerProfilePhoto(workspace, id, ownerIsCurrent, updateProfileChoices)
      if (!ownerIsCurrent(id)) return
      if (!result) {
        clearProfileChoices()
        photo.value = undefined
        avatarNotice.value = ""
        return
      }
      const { conflicted, photo: chosen, stored } = result
      if (!chosen) return
      if (!ownerIsCurrent(id)) return
      photo.value = chosen
      if (conflicted) { avatarNotice.value = "Photo changes need a choice in Settings → Identity."; return }
      if (stored) await projectPhoto(stored, id)
    } catch (cause) {
      logProfileReadFailure(cause)
      clearProfileChoices()
      avatarNotice.value = ""
      profileLoadError.value = "Saved Identity profile could not be verified. Retry to load it again."
    }
  }
  async function retryProfileLoad(): Promise<void> {
    const ownerId = personId()
    if (!ownerId) return
    profileLoadError.value = ""
    clearProfileChoices()
    await serial(reconcilePhoto)
  }
  async function saveAvatar(avatarData: string | null, expectedRevision?: string): Promise<void> {
    await serial(async () => {
      const profile = workspace.getCurrentProfile()
      if (!profile) throw new Error("Identity is unavailable")
      const saved = await saveIdentityPhoto(profile, avatarData, undefined, expectedRevision)
      if (personId() !== profile.identity.personId) throw new Error("Identity changed while saving photo")
      photoOwner = profile.identity.personId; photo.value = saved
      await projectPhoto(saved, profile.identity.personId)
    })
  }
  const stop = watch(() => {
    void workspace.docVersion.value
    const doc = workspace.getActiveDoc()
    const entity = doc?.entities[memberProfileEntityId(personId() ?? "")]
    const workspaceIds = workspace.availableWorkspaces.value.map(item => item.id).sort().join(",")
    return `${workspace.ready.value}:${contextReady?.value ?? true}:${personId() ?? ""}:${doc?.id ?? ""}:${workspaceIds}:${entity?.kind === "member_profile" ? entity.data : ""}`
  }, () => { void serial(reconcilePhoto) }, { immediate: true })
  const unsubscribe = subscribeIdentityDevicePreferences(owner => {
    if (disposed || owner !== personId()) return
    void serial(reconcilePhoto)
  })
  onScopeDispose(() => { disposed = true; clearTimeout(projectionRetry); stop(); unsubscribe() })
  return { memberAvatars, currentAvatar, saveAvatar, avatarNotice, profileLoadError, retryProfileLoad,
    profileConflicts, profileRevision, identityNameProvided }
}
