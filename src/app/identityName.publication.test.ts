import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { adoptEnrolledIdentityDevice, bootstrapIdentity, refreshIdentityPresentation, resetIdentityStorageForTest } from "../domain/identity"
import { createDelegatedCertificate, createDeviceAuthorizationApproval, createDeviceAuthorizationRequest,
  createIdentityEnrollmentDevice } from "@meta-uber/mesh-identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"
import { configureChat, ensureChatProfile, exportChat, loadChat } from "../chat/service"
import { verifyChatRecord } from "../chat/records"
import { saveIdentityName } from "./identityName"
import { completeIdentityBrowserSignIn } from "./completeIdentityBrowserSignIn"
import { createIdentityProfileOperation, emptyIdentityProfileState, observeLegacyIdentityProfile, readIdentityProfileState } from "../domain/identityProfileState"
import { resolveLocalSigningContext } from "../domain/localSigningContext"

afterEach(() => { vi.unstubAllGlobals() })

it("Given profile recovery refreshes after a saved rename, when settings refresh concurrently, then publish the signed new name to shared chat", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Original")
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, await certHashDefault(profile.certificate)))
  const workspaceId = "rename-publication-workspace"
  configureChat(async () => profile.identity.personId, async id => id)
  await ensureChatProfile(workspaceId)
  const background: Array<Promise<unknown>> = []
  const stop = subscribeIdentityDevicePreferences(() => {
    const refresh = refreshIdentityPresentation()
    void refresh.catch(() => {})
    background.push(refresh)
  })
  try {
    await expect(saveIdentityName("Renamed", workspaceId, async () => { await refreshIdentityPresentation() })).resolves.toBeUndefined()
    await expect(Promise.all(background)).resolves.toHaveLength(1)
  } finally { stop() }

  const saved = (await loadChat(workspaceId)).profiles.find(value => value.personId === profile.identity.personId)!
  expect(saved).toMatchObject({ name: "Renamed", revision: 2 })
  const wire = await exportChat(workspaceId)
  expect(wire.profiles).toEqual([saved.record])
  await expect(verifyChatRecord(wire.profiles[0], workspaceId, profile.identity.personId))
    .resolves.toMatchObject({ signed: { payload: { kind: "chat-profile", text: "Renamed", revision: 2 } } })
})

it("Given an existing Participant chat profile, when same-person sign-in restores signed name and photo, then publish Bo and the photo", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, run?: () => Promise<unknown>) =>
    (run ?? options as () => Promise<unknown>)() } })
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Participant")
  await defaultStorage.savePersonalRoot(createPersonalRoot(owner, await certHashDefault(owner.certificate)))
  const workspaceId = "same-person-signin-profile-publication"
  configureChat(async () => owner.identity.personId, async id => id)
  await ensureChatProfile(workspaceId)
  expect((await loadChat(workspaceId)).profiles[0]?.name).toBe("Participant")

  let profileState = await observeLegacyIdentityProfile(emptyIdentityProfileState(owner.identity.personId), owner.identity,
    "name", owner.identity.displayName)
  const signing = await resolveLocalSigningContext(owner, "identity-profile-update", { personId: owner.identity.personId })
  const name = await createIdentityProfileOperation(signing, profileState, owner.identity, "name", "Bo")
  profileState = await readIdentityProfileState({ ...profileState, operations: [name] }, owner.identity)
  const avatarData = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
  const photo = await createIdentityProfileOperation(signing, profileState, owner.identity, "photo", {
    avatarData, changedAt: "2026-10-24T20:00:00.000Z",
  })
  profileState = await readIdentityProfileState({ ...profileState, operations: [...profileState.operations, photo] }, owner.identity)

  const enrollment = await createIdentityEnrollmentDevice("Application device")
  const appCertificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, enrollment.device.deviceId, enrollment.device.publicKey, await certHashDefault(owner.certificate))
  await adoptEnrolledIdentityDevice({ identity: owner.identity, device: enrollment.device, certificate: appCertificate,
    privateKeys: { devicePrivateKey: enrollment.privateKey } }, [appCertificate, owner.certificate], owner.identity.personId)
  const app = await bootstrapIdentity()

  const challenge = "c".repeat(64)
  const request = await createDeviceAuthorizationRequest(app, { applicationOrigin: "https://boards.example", challenge,
    expiresAt: Date.now() + 120_000 })
  const approval = await createDeviceAuthorizationApproval(owner, request, {
    applicationOrigin: "https://boards.example", challenge, certificates: [owner.certificate], revocations: [], profileState,
    includeProfileState: true,
  })

  await completeIdentityBrowserSignIn(approval, request, app, workspaceId)

  const savedRoot = await defaultStorage.loadPersonalRoot()
  expect((await bootstrapIdentity()).identity.displayName).toBe("Bo")
  expect(savedRoot?.photo?.avatarData).toBe(avatarData)
  const saved = (await loadChat(workspaceId)).profiles.find(value => value.personId === app.identity.personId)
  expect(saved).toMatchObject({ name: "Bo", revision: 2 })
  const wire = await exportChat(workspaceId)
  const signedProfile = wire.profiles.find(record =>
    (record as { signed: { payload: { personId: string } } }).signed.payload.personId === app.identity.personId)
  await expect(verifyChatRecord(signedProfile, workspaceId, app.identity.personId))
    .resolves.toMatchObject({ signed: { payload: { kind: "chat-profile", text: "Bo", revision: 2 } } })
  const { ChatStore, chatStore } = await import("../chat/store")
  const peerStore = new ChatStore("same-person-profile-peer")
  const load = vi.spyOn(chatStore, "load").mockImplementation(id => peerStore.load(id))
  const merge = vi.spyOn(chatStore, "merge").mockImplementation((id, messages, profiles) => peerStore.merge(id, messages, profiles))
  try {
    const { receiveChat } = await import("../chat/service")
    await receiveChat(workspaceId, wire, true, "verified-peer")
    expect((await loadChat(workspaceId)).profiles.find(value => value.personId === app.identity.personId))
      .toMatchObject({ name: "Bo", revision: 2 })
  } finally { load.mockRestore(); merge.mockRestore() }
})
