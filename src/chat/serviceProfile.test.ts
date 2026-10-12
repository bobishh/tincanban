import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import type * as IdentityModule from "../domain/identity"
type LocalProfile = IdentityModule.LocalProfile
import type { ChatRecord } from "./records"

const current = vi.hoisted(() => ({ profile: undefined as LocalProfile | undefined }))
vi.mock("../domain/identity", async importOriginal => ({
  ...await importOriginal<typeof IdentityModule>(),
  bootstrapIdentity: async () => current.profile!,
}))
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { peerStore } from "../sync/peerStore"
import { ChatStore, chatStore, doesProfileWin } from "./store"
import { configureChat, ensureChatProfile, exportChat, receiveChat, sendChatMessage, sendChatTyping, subscribeChat } from "./service"
import { clearMeshTrace, meshTraceSnapshot } from "../sync/meshTrace"

const originalNavigator = globalThis.navigator
const originalIndexedDb = globalThis.indexedDB
const originalKeyRange = globalThis.IDBKeyRange
let first: LocalProfile, second: LocalProfile, activeStore: ChatStore
let firstStore: ChatStore, secondStore: ChatStore
const workspace = "profile-workspace"

beforeEach(async () => {
  const identity = await vi.importActual<typeof IdentityModule>("../domain/identity")
  identity.resetIdentityStorageForTest()
  first = await identity.bootstrapIdentity("Current name")
  identity.resetIdentityStorageForTest()
  const device = await identity.bootstrapIdentity("Old local name")
  const certificate = await createDelegatedCertificate(first.privateKeys.devicePrivateKey, first.device.deviceId,
    first.identity.personId, device.device.deviceId, device.device.publicKey, await certHashDefault(first.certificate))
  second = { ...device, identity: { ...first.identity, displayName: "Old local name" }, certificate }
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: IDBKeyRange })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } } })
  firstStore = new ChatStore("first-profile-device")
  secondStore = new ChatStore("second-profile-device")
  activeStore = firstStore
  current.profile = first
  vi.spyOn(chatStore, "load").mockImplementation(id => activeStore.load(id))
  vi.spyOn(chatStore, "putProfile").mockImplementation(value => activeStore.putProfile(value))
  vi.spyOn(chatStore, "append").mockImplementation(value => activeStore.append(value))
  vi.spyOn(chatStore, "merge").mockImplementation((id, messages, profiles) => activeStore.merge(id, messages, profiles))
  vi.spyOn(defaultProofStore, "listCertificates").mockResolvedValue([first.certificate, second.certificate])
  vi.spyOn(peerStore, "getWorkspaceCredential").mockResolvedValue(null)
  vi.spyOn(peerStore, "getWorkspaceAuthority").mockResolvedValue(null)
  configureChat(async () => first.identity.personId, async id => id)
  clearMeshTrace()
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb })
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: originalKeyRange })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator })
})
function useDevice(profile: LocalProfile, store: ChatStore) { current.profile = profile; activeStore = store }

describe("shared chat profile intent across certified devices", () => {
  it("Given one root on two certified devices with different local names, normal exports converge without profile-signing ping-pong", async () => {
    const initial = await exportChat(workspace)
    const changes: unknown[] = []
    const unsubscribe = subscribeChat(change => { if (!change.remote && change.history) changes.push(change) })
    try {
      for (let round = 0; round < 4; round++) {
        useDevice(second, secondStore)
        await receiveChat(workspace, initial, true)
        const stale = await exportChat(workspace)
        expect(stale.profiles).toEqual(initial.profiles)
        useDevice(first, firstStore)
        await receiveChat(workspace, stale, true)
        expect((await exportChat(workspace)).profiles).toEqual(initial.profiles)
      }
      expect(changes).toHaveLength(0)
      expect((await firstStore.load(workspace)).profiles[0]).toMatchObject({ name: "Current name", revision: 1 })
      expect((await secondStore.load(workspace)).profiles[0]).toMatchObject({ name: "Current name", revision: 1 })
    } finally { unsubscribe() }
  })

  it("Given a received profile and stale local name, sending messages and typing do not overwrite its label", async () => {
    const initial = await exportChat(workspace)
    useDevice(second, secondStore)
    await receiveChat(workspace, initial, true)
    await sendChatMessage(workspace, "A real message")
    await sendChatTyping(workspace, true)
    const result = await secondStore.load(workspace)
    expect(result.profiles[0]).toMatchObject({ name: "Current name", revision: 1 })
    expect(result.messages[0]?.record).toMatchObject({ signed: { payload: { deviceId: second.device.deviceId } } })
  })
  it("Given independent initial profiles, their existing signed ordering converges once without new revisions", async () => {
    const initialFirst = await exportChat(workspace)
    useDevice(second, secondStore)
    const initialSecond = await exportChat(workspace)
    const firstProfile = (await firstStore.load(workspace)).profiles[0]!
    const secondProfile = (await secondStore.load(workspace)).profiles[0]!
    const winner = doesProfileWin(firstProfile, secondProfile) ? firstProfile : secondProfile
    await receiveChat(workspace, initialFirst, true)
    const agreed = await exportChat(workspace)
    useDevice(first, firstStore)
    await receiveChat(workspace, initialSecond, true)
    await receiveChat(workspace, agreed, true)
    expect((await exportChat(workspace)).profiles).toEqual([winner.record])
    useDevice(second, secondStore)
    expect((await exportChat(workspace)).profiles).toEqual([winner.record])
    expect((await firstStore.load(workspace)).profiles[0]!.revision).toBe(1)
    expect((await secondStore.load(workspace)).profiles[0]!.revision).toBe(1)
  })

  it("Given an explicit rename, only its new profile revision propagates and stale devices do not undo it", async () => {
    const initial = await exportChat(workspace)
    useDevice(second, secondStore)
    await receiveChat(workspace, initial, true)
    current.profile = { ...second, identity: { ...second.identity, displayName: "Explicit new name" } }
    const renamed = await ensureChatProfile(workspace, { updateName: true })
    expect(renamed).toMatchObject({ name: "Explicit new name", revision: 2 })
    const update = await exportChat(workspace)
    useDevice(first, firstStore)
    await receiveChat(workspace, update, true)
    expect((await exportChat(workspace)).profiles).toEqual(update.profiles)
    const repeated = await ensureChatProfile(workspace, { updateName: true })
    expect(repeated).toMatchObject({ name: "Current name", revision: 3 })
    expect(await ensureChatProfile(workspace, { updateName: true })).toEqual(repeated)
    const updates = meshTraceSnapshot().filter(event => event.event === "chat.profile.updated")
    expect(updates.map(event => event.phase)).toEqual(["initial", "explicit_rename", "explicit_rename"])
    expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: "profile", entityId: first.identity.personId })]))
    expect(JSON.stringify(updates)).not.toMatch(/Current name|Old local name|Explicit new name/)
    expect((renamed!.record as ChatRecord).signed.payload.deviceId).toBe(second.device.deviceId)
  })

})
