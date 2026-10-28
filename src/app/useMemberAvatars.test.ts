import { effectScope, nextTick, ref, shallowRef } from "vue"
import { beforeEach, expect, it, vi } from "vitest"
import type { useTincanban } from "../state"
import { useMemberAvatars } from "./useMemberAvatars"
import { emptyIdentityProfileState, observeLegacyIdentityProfile } from "../domain/identityProfileState"

const storage = vi.hoisted(() => ({ loadPersonalRoot: vi.fn(), updatePersonalRootForIdentity: vi.fn() }))
const preferences = vi.hoisted(() => ({ listeners: new Set<(owner: string) => void>() }))
const ownerId = "A".repeat(43)
const ownerIdentity = { personId: ownerId, publicKey: "public-key", displayName: "Owner Example" }
vi.mock("../storage", () => ({ defaultStorage: storage }))
vi.mock("../sync/identityDevicePreferenceEvents", () => ({
  subscribeIdentityDevicePreferences: (listener: (owner: string) => void) => {
    preferences.listeners.add(listener)
    return () => { preferences.listeners.delete(listener) }
  },
  identityDevicePreferencesChanged: (owner: string) => { for (const listener of preferences.listeners) listener(owner) },
}))
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"
const photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-10-11T17:00:00.000Z" }
let storedPhoto: { avatarData: string | null; changedAt: string } = photo
beforeEach(() => {
  storedPhoto = photo
  storage.loadPersonalRoot.mockClear()
  storage.updatePersonalRootForIdentity.mockClear()
  storage.loadPersonalRoot.mockImplementation(async () => ({ identity: ownerIdentity, photo: storedPhoto }))
  storage.updatePersonalRootForIdentity.mockImplementation(async (_id: string, update: (root: { identity: { personId: string }; photo: typeof storedPhoto }) => unknown) =>
    update({ identity: ownerIdentity, photo: storedPhoto }))
  preferences.listeners.clear()
})

it("Given a restored Identity photo and two shared boards, when only one board is open, then publish the photo to both without switching boards", async () => {
  const active = { id: "active-board", entities: {} }
  const background = { id: "background-board", entities: {} }
  const execute = vi.fn(async () => {})
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([{ id: active.id }, { id: background.id }]),
    getCurrentProfile: () => ({ identity: ownerIdentity }), getActiveDoc: () => active,
    readWorkspaceDoc: async (id: string) => id === active.id ? active : background,
    executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  scope.run(() => useMemberAvatars(workspace))
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(background.id, { kind: "setMemberAvatar", ...photo }))
    expect(execute).toHaveBeenCalledWith(active.id, { kind: "setMemberAvatar", ...photo })
    expect(workspace.getActiveDoc()).toBe(active)
  } finally { scope.stop() }
})

it("Given an unchanged saved photo, when another board becomes available in the background, then publish its profile without switching boards", async () => {
  const active = { id: "active-board", entities: { [`member-profile:${ownerId}`]: { kind: "member_profile", data: JSON.stringify(photo) } } }
  const background = { id: "background-board", entities: {} }
  const availableWorkspaces = ref([{ id: active.id }])
  const execute = vi.fn(async () => {})
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces,
    getCurrentProfile: () => ({ identity: ownerIdentity }), getActiveDoc: () => active,
    readWorkspaceDoc: async (id: string) => id === active.id ? active : background,
    executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  scope.run(() => useMemberAvatars(workspace))
  try {
    await vi.waitFor(() => expect(storage.loadPersonalRoot).toHaveBeenCalled())
    expect(execute).not.toHaveBeenCalled()
    availableWorkspaces.value.push({ id: background.id })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(background.id, { kind: "setMemberAvatar", ...photo }))
    expect(workspace.docVersion.value).toBe(1)
    expect(workspace.getActiveDoc()).toBe(active)
  } finally { scope.stop() }
})

it("Given a saved photo whose board write fails once, when storage recovers, then retry automatically without reopening the board", async () => {
  vi.useFakeTimers()
  const doc = { id: "workspace", entities: {} }
  const execute = vi.fn().mockRejectedValueOnce(new Error("Storage temporarily busy")).mockResolvedValue(undefined)
  const workspace = { ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([{ id: doc.id }]),
    getCurrentProfile: () => ({ identity: ownerIdentity }), getActiveDoc: () => doc,
    readWorkspaceDoc: async () => doc, executeWorkspaceCommandAsync: execute } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope(), avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.avatarNotice.value).toMatch(/sharing.*pending/i))
    const attempts = execute.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => {
      expect(execute.mock.calls.length).toBeGreaterThan(attempts)
      expect(avatars.avatarNotice.value).toBe("")
    })
  } finally { scope.stop(); vi.useRealTimers() }
})

it("Given a saved identity photo while startup checks are pending, when the workspace becomes ready, then publish the photo without another upload", async () => {
  const ready = ref(false)
  const doc = { id: "workspace", entities: {} }
  const execute = vi.fn(async () => {
    if (!ready.value) throw new Error("Saved board is still being checked")
  })
  const workspace = {
    ready, docVersion: ref(1), availableWorkspaces: ref([{ id: doc.id }]),
    getCurrentProfile: () => ({ identity: ownerIdentity }),
    getActiveDoc: () => doc, readWorkspaceDoc: async () => doc, executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  const avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBe(photo.avatarData))
    expect(execute).not.toHaveBeenCalled()
    ready.value = true
    await nextTick()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(doc.id, { kind: "setMemberAvatar", ...photo }))
    expect(avatars.avatarNotice.value).toBe("")
  } finally { scope.stop() }
})

it("Given sign-in refreshed Bo while the guest board is still active, when browser return is pending, then defer photo writes until the selected board is ready", async () => {
  const guestIdentity = { personId: "guest", publicKey: "guest-public-key", displayName: "Guest" }
  const current = shallowRef({ identity: guestIdentity })
  const guestDoc = { id: "guest-untitled", title: "Untitled", updatedAt: "2026-10-26T00:00:00.000Z", ownerPersonId: guestIdentity.personId, entities: {} }
  const ownerDoc = { id: "bo-job-search", title: "Job search", updatedAt: "2026-10-26T00:00:00.000Z", ownerPersonId: ownerIdentity.personId, entities: {} }
  const contextReady = ref(false)
  const saveState = ref<"idle" | "saving" | "saved" | "error">("idle")
  let activeDoc = guestDoc
  const execute = vi.fn(async (workspaceId: string) => {
    saveState.value = "saving"
    try {
      if (workspaceId === guestDoc.id) throw new Error("Workspace profile grant is unavailable")
      if (workspaceId === ownerDoc.id) throw new Error("Local board write failed")
    } catch (error) {
      saveState.value = "error"
      throw error
    }
    saveState.value = "saved"
  })
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([{ id: guestDoc.id }]),
    getCurrentProfile: () => current.value,
    getActiveDoc: () => activeDoc, readWorkspaceDoc: async () => activeDoc,
    executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const guestSnapshot = structuredClone(guestDoc)
  const scope = effectScope()
  const avatars = scope.run(() => useMemberAvatars(workspace, contextReady))!
  try {
    current.value = { identity: ownerIdentity }
    workspace.docVersion.value += 1
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBe(photo.avatarData))

    expect({ writes: execute.mock.calls, saveState: saveState.value, guestDoc }).toEqual({
      writes: [], saveState: "idle", guestDoc: guestSnapshot,
    })

    activeDoc = ownerDoc
    workspace.availableWorkspaces.value = [{ id: ownerDoc.id, title: ownerDoc.title, updatedAt: ownerDoc.updatedAt }]
    contextReady.value = true
    workspace.docVersion.value += 1
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(ownerDoc.id, expect.objectContaining({ kind: "setMemberAvatar" })))
    expect(saveState.value).toBe("error")
    expect(avatars.avatarNotice.value).toMatch(/sharing to some workspaces is pending/i)
  } finally { scope.stop() }
})

it("Given signed photo history with a missing root shadow, when avatar preferences reconcile, then publish the recovered photo", async () => {
  const { bootstrapIdentity } = await import("../domain/identity")
  const { createPersonalRoot } = await import("../domain/personalRoot")
  const { createIdentityProfileOperation, emptyIdentityProfileState, observeLegacyIdentityProfile, readIdentityProfileState } = await import("../domain/identityProfileState")
  const { resolveLocalSigningContext } = await import("../domain/localSigningContext")
  const profile = await bootstrapIdentity("Photo Owner")
  const state = await observeLegacyIdentityProfile(emptyIdentityProfileState(profile.identity.personId), profile.identity, "name", profile.identity.displayName)
  const context = await resolveLocalSigningContext(profile, "identity-profile-update", { personId: profile.identity.personId })
  const signedPhoto = await createIdentityProfileOperation(context, state, profile.identity, "photo", photo)
  const profileState = await readIdentityProfileState({ ...state, operations: [signedPhoto] }, profile.identity)
  let root: unknown = { ...createPersonalRoot(profile, "certificate"), profileState }
  storage.loadPersonalRoot.mockImplementation(async () => root)
  storage.updatePersonalRootForIdentity.mockImplementation(async (_id: string, update: (value: unknown) => unknown) => {
    root = await update(root)
    return root
  })
  const doc = { id: "workspace", entities: {} }
  const execute = vi.fn(async () => {})
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([{ id: doc.id }]),
    getCurrentProfile: () => profile, getActiveDoc: () => doc, readWorkspaceDoc: async () => doc,
    executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope(), avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBe(photo.avatarData))
    expect((root as { photo?: unknown }).photo).toEqual(photo)
    expect(execute).toHaveBeenCalledWith(doc.id, { kind: "setMemberAvatar", ...photo })
  } finally { scope.stop() }
})

it("Given a same-owner identity-scope photo update without a document version change, when preferences notify, then update the visible avatar", async () => {
  const docVersion = ref(7)
  const doc = { id: "workspace", entities: {} }
  const workspace = {
    ready: ref(true), docVersion, availableWorkspaces: ref([]),
    getCurrentProfile: () => ({ identity: ownerIdentity }),
    getActiveDoc: () => doc, readWorkspaceDoc: async () => doc, executeWorkspaceCommandAsync: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  const avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBe(photo.avatarData))
    const latest = { ...photo, avatarData: null, changedAt: "2026-10-12T17:00:00.000Z" }
    storedPhoto = latest
    identityDevicePreferencesChanged(ownerId)
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBeUndefined())
    expect(docVersion.value).toBe(7)
  } finally { scope.stop() }
})

it("Given a saved private photo and a future-dated shared avatar, when the board projects, then keep private metadata unchanged and publish the private photo", async () => {
  const doc = { id: "workspace", entities: { [`member-profile:${ownerId}`]: {
    kind: "member_profile", personId: ownerId, data: JSON.stringify({ avatarData: null, changedAt: "2099-01-01T00:00:00.000Z" }),
  } } }
  const execute = vi.fn(async () => {})
  const workspace = { ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([{ id: doc.id }]),
    getCurrentProfile: () => ({ identity: ownerIdentity }), getActiveDoc: () => doc,
    readWorkspaceDoc: async () => doc, executeWorkspaceCommandAsync: execute } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope(), avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBe(photo.avatarData))
    expect(storage.updatePersonalRootForIdentity).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(doc.id, { kind: "setMemberAvatar", ...photo })
  } finally { scope.stop() }
})

it("Given a pending personal-root read when identity changes, then do not project the old owner's photo into the new workspace", async () => {
  const latest = { ...photo, changedAt: "2026-10-12T17:00:00.000Z" }
  let finishLoad!: (root: unknown) => void
  let signalLoadStarted!: () => void
  const loadStarted = new Promise<void>(resolve => { signalLoadStarted = resolve })
  const firstLoad = new Promise<unknown>(resolve => { finishLoad = resolve })
  let first = true
  storage.loadPersonalRoot.mockImplementation(async () => {
    if (first) {
      first = false
      signalLoadStarted()
      return firstLoad
    }
    return { identity: { personId: "replacement" } }
  })
  const current = shallowRef({ identity: ownerIdentity })
  const incomingDoc = { id: "owner-workspace", entities: { [`member-profile:${ownerId}`]: {
    kind: "member_profile", personId: ownerId, data: JSON.stringify(latest),
  } } }
  let activeDoc: typeof incomingDoc | { id: string; entities: Record<string, never> } = incomingDoc
  const availableWorkspaces = ref([{ id: incomingDoc.id }])
  const docVersion = ref(1)
  const execute = vi.fn(async () => {})
  const otherDoc = { id: "replacement-workspace", entities: {} }
  const workspace = {
    ready: ref(true), docVersion, availableWorkspaces,
    getCurrentProfile: () => current.value,
    getActiveDoc: () => activeDoc,
    readWorkspaceDoc: async () => otherDoc,
    executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  const avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await loadStarted
    current.value = { identity: { personId: "replacement", publicKey: "replacement", displayName: "Replacement" } }
    activeDoc = otherDoc
    availableWorkspaces.value = [{ id: otherDoc.id }]
    docVersion.value += 1
    finishLoad({ identity: ownerIdentity, photo: latest })
    await nextTick()
    await vi.waitFor(() => expect(storage.loadPersonalRoot).toHaveBeenCalledTimes(2))
    expect(storage.updatePersonalRootForIdentity).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(avatars.currentAvatar.value).toBeUndefined()
  } finally { scope.stop() }
})

it("Given causal profile conflicts and a revision, when private profile state is absent, then clear stale choices", async () => {
  const owner = "A".repeat(43)
  let root: unknown
  storage.loadPersonalRoot.mockImplementation(async () => root)
  const identity = { personId: owner, publicKey: "public-key", displayName: "Alice Example" }
  let profileState = emptyIdentityProfileState(owner)
  profileState = await observeLegacyIdentityProfile(profileState, identity, "name", "Alice Example")
  profileState = await observeLegacyIdentityProfile(profileState, identity, "name", "Bob Example")
  const conflictedRoot = { identity, profileState }
  root = conflictedRoot
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([]),
    getCurrentProfile: () => ({ identity }), getActiveDoc: () => ({ id: "workspace", entities: {} }),
    readWorkspaceDoc: async () => ({ id: "workspace", entities: {} }), executeWorkspaceCommandAsync: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope(), avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.profileConflicts.value.names).toEqual(["Alice Example", "Bob Example"]))
    const conflictedRevision = avatars.profileRevision.value
    expect(conflictedRevision).not.toBe("")
    root = { identity }
    identityDevicePreferencesChanged(owner)
    await vi.waitFor(() => expect(avatars.profileConflicts.value).toEqual({ names: [], photos: [] }))
    expect(avatars.profileRevision.value).not.toBe("")
    expect(avatars.profileRevision.value).not.toBe(conflictedRevision)
  } finally { scope.stop() }
})

it("Given a foreign owner's preference event or a disposed view, then do not reconcile another owner's photo", async () => {
  const doc = { id: "workspace", entities: {} }
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([]),
    getCurrentProfile: () => ({ identity: ownerIdentity }),
    getActiveDoc: () => doc, readWorkspaceDoc: async () => doc, executeWorkspaceCommandAsync: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  scope.run(() => useMemberAvatars(workspace))
  await vi.waitFor(() => expect(storage.loadPersonalRoot).toHaveBeenCalledTimes(1))
  identityDevicePreferencesChanged("another-person")
  await nextTick()
  expect(storage.loadPersonalRoot).toHaveBeenCalledTimes(1)
  scope.stop()
  identityDevicePreferencesChanged(ownerId)
  await nextTick()
  expect(storage.loadPersonalRoot).toHaveBeenCalledTimes(1)
})

it("Given fresh unnamed provenance, when profile preferences load and explicit choice arrives, then keep the form blank until a choice is committed", async () => {
  const { writeLocal, deleteLocal } = await import("../localDb")
  const { identityNameChoiceKey } = await import("../domain/identityNameChoice")
  const identity = { ...ownerIdentity, displayName: "Participant" }
  const key = identityNameChoiceKey(identity.personId)
  await writeLocal(key, "Participant")
  storage.loadPersonalRoot.mockImplementation(async () => ({ identity }))
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([]),
    getCurrentProfile: () => ({ identity }), getActiveDoc: () => ({ id: "workspace", entities: {} }),
    readWorkspaceDoc: async () => ({ id: "workspace", entities: {} }), executeWorkspaceCommandAsync: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope(), avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    expect(avatars.identityNameProvided.value).toBe(false)
    await vi.waitFor(() => expect(avatars.profileRevision.value).not.toBe(""))
    expect(avatars.identityNameProvided.value).toBe(false)
    await deleteLocal(key)
    identityDevicePreferencesChanged(identity.personId)
    await vi.waitFor(() => expect(avatars.identityNameProvided.value).toBe(true))
  } finally { scope.stop(); await deleteLocal(key) }
})

it("Given invalid workspace photo metadata, when Identity profile reconciliation fails, then log the phase and error class without exposing profile contents", async () => {
  const secretFixture = '{"private-note":"must not appear in diagnostics"'
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
  const identity = { ...ownerIdentity }
  let photoData = secretFixture
  const doc = { id: "workspace", entities: { [`member-profile:${ownerId}`]: {
    kind: "member_profile", personId: ownerId, get data() { return photoData },
  } } }
  const workspace = {
    ready: ref(true), docVersion: ref(1), availableWorkspaces: ref([]),
    getCurrentProfile: () => ({ identity }),
    getActiveDoc: () => doc,
    readWorkspaceDoc: async () => ({ id: "workspace", entities: {} }),
    executeWorkspaceCommandAsync: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope(), avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith("[tincanban.identity-profile] read failed", {
      stage: "workspace-photo-read", errorName: "SyntaxError",
    }))
    expect(avatars.profileRevision.value).toBe("")
    expect(avatars.profileLoadError.value).toMatch(/could not be verified/i)
    expect(avatars.avatarNotice.value).toBe("")
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("must not appear in diagnostics")
    photoData = JSON.stringify(photo)
    await avatars.retryProfileLoad()
    expect(avatars.profileLoadError.value).toBe("")
    expect(avatars.profileRevision.value).not.toBe("")
  } finally { scope.stop(); errorLog.mockRestore() }
})
