import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { bootstrapIdentity, refreshIdentityPresentation, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"
import { configureChat, ensureChatProfile, exportChat, loadChat } from "../chat/service"
import { verifyChatRecord } from "../chat/records"
import { saveIdentityName } from "./identityName"

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
