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
