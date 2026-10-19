import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import type * as IdentityModule from "../domain/identity"
import { toBase64Url } from "../domain/identity"
import { writeLocal } from "../localDb"
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
import { configureChat, ensureChatProfile, exportChat, receiveChat, sendChatMessage, sendChatTyping, subscribeChat,
  type ChatChange } from "./service"
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
  await persistProfile(first)
  clearMeshTrace()
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb })
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: originalKeyRange })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator })
})
async function persistProfile(profile: LocalProfile) {
  const identityKey = profile.privateKeys.identityPrivateKey
  await writeLocal("tincanban.local_profile.v1", JSON.stringify({
    identity: profile.identity, device: profile.device, certificate: profile.certificate,
    privateKeys: {
      ...(identityKey ? { identityPrivateKeyPkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", identityKey))) } : {}),
      devicePrivateKeyPkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", profile.privateKeys.devicePrivateKey))),
    },
  }))
}
async function useDevice(profile: LocalProfile, store: ChatStore) {
  current.profile = profile
  activeStore = store
  await persistProfile(profile)
}

describe("shared chat profile intent across certified devices", () => {
  it("Given one root on two certified devices with different local names, normal exports converge without profile-signing ping-pong", async () => {
    const initial = await exportChat(workspace)
    const changes: unknown[] = []
    const unsubscribe = subscribeChat(change => { if (!change.remote && change.history) changes.push(change) })
    try {
      for (let round = 0; round < 4; round++) {
        await useDevice(second, secondStore)
        await receiveChat(workspace, initial, true)
        const stale = await exportChat(workspace)
        expect(stale.profiles).toEqual(initial.profiles)
        await useDevice(first, firstStore)
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
    await useDevice(second, secondStore)
    await receiveChat(workspace, initial, true)
    await sendChatMessage(workspace, "A real message")
    await sendChatTyping(workspace, true)
    const result = await secondStore.load(workspace)
    expect(result.profiles[0]).toMatchObject({ name: "Current name", revision: 1 })
    expect(result.messages[0]?.record).toMatchObject({ signed: { payload: { deviceId: second.device.deviceId } } })
  })
  it("Given independent initial profiles, their existing signed ordering converges once without new revisions", async () => {
    const initialFirst = await exportChat(workspace)
    await useDevice(second, secondStore)
    const initialSecond = await exportChat(workspace)
    const firstProfile = (await firstStore.load(workspace)).profiles[0]!
    const secondProfile = (await secondStore.load(workspace)).profiles[0]!
    const winner = doesProfileWin(firstProfile, secondProfile) ? firstProfile : secondProfile
    await receiveChat(workspace, initialFirst, true)
    const agreed = await exportChat(workspace)
    await useDevice(first, firstStore)
    await receiveChat(workspace, initialSecond, true)
    await receiveChat(workspace, agreed, true)
    expect((await exportChat(workspace)).profiles).toEqual([winner.record])
    await useDevice(second, secondStore)
    expect((await exportChat(workspace)).profiles).toEqual([winner.record])
    expect((await firstStore.load(workspace)).profiles[0]!.revision).toBe(1)
    expect((await secondStore.load(workspace)).profiles[0]!.revision).toBe(1)
  })

  it("Given an explicit rename, only its new profile revision propagates and stale devices do not undo it", async () => {
    const initial = await exportChat(workspace)
    await useDevice(second, secondStore)
    await receiveChat(workspace, initial, true)
    current.profile = { ...second, identity: { ...second.identity, displayName: "Explicit new name" } }
    const renamed = await ensureChatProfile(workspace, { updateName: true })
    expect(renamed).toMatchObject({ name: "Explicit new name", revision: 2 })
    const update = await exportChat(workspace)
    await useDevice(first, firstStore)
    const changes: ChatChange[] = []
    const unsubscribe = subscribeChat(change => changes.push(change))
    try { await receiveChat(workspace, update, false) } finally { unsubscribe() }
    expect(changes).toEqual([expect.objectContaining({ history: false, profilesChanged: true, added: [] })])
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

  it("Given a device key that does not match its certificate, chat does not persist or publish a record", async () => {
    await ensureChatProfile(workspace)
    const forged = { ...first, privateKeys: { ...first.privateKeys, devicePrivateKey: second.privateKeys.devicePrivateKey } }
    current.profile = forged
    await persistProfile(forged)
    const append = vi.spyOn(chatStore, "append")
    const published: unknown[] = []
    const unsubscribe = subscribeChat(change => published.push(change))
    try {
      await expect(sendChatMessage(workspace, "Wrong key must fail")).rejects.toThrow("Private signing key does not match")
      expect(append).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect((await firstStore.load(workspace)).messages).toEqual([])
    } finally { unsubscribe() }
  })

  it("Given a delegated device without its certificate ancestor, chat does not persist or publish a record", async () => {
    await ensureChatProfile(workspace)
    await useDevice(second, firstStore)
    vi.mocked(defaultProofStore.listCertificates).mockResolvedValue([second.certificate])
    const append = vi.spyOn(chatStore, "append")
    const published: unknown[] = []
    const unsubscribe = subscribeChat(change => published.push(change))
    try {
      await expect(sendChatMessage(workspace, "Incomplete chain must fail")).rejects.toThrow("Missing signing certificate ancestor")
      expect(append).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect((await firstStore.load(workspace)).messages).toEqual([])
    } finally { unsubscribe() }
  })

  it("Given workspace device access is revoked during signing, no message is persisted or published", async () => {
    await ensureChatProfile(workspace)
    const peers = vi.spyOn(peerStore, "listPeers").mockResolvedValue([])
    let finishSigning!: () => void
    let signingStarted!: () => void
    const started = new Promise<void>(resolve => { signingStarted = resolve })
    const gate = new Promise<void>(resolve => { finishSigning = resolve })
    const originalSign = crypto.subtle.sign.bind(crypto.subtle)
    let delaySign = true
    const signSpy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      if (delaySign) { delaySign = false; signingStarted(); await gate }
      return originalSign(...args)
    })
    const append = vi.spyOn(chatStore, "append")
    const published: unknown[] = []
    const unsubscribe = subscribeChat(change => published.push(change))
    try {
      const sending = sendChatMessage(workspace, "Revoked during signature")
      await started
      peers.mockResolvedValue([{ workspaceId: workspace, deviceId: first.device.deviceId,
        personId: first.identity.personId, endpoint: "https://peer.invalid", transportSecret: "secret",
        role: "editor", lastSeen: new Date().toISOString(), revokedAt: new Date().toISOString() }])
      finishSigning()
      await expect(sending).rejects.toThrow("Workspace access revoked")
      expect(append).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect((await firstStore.load(workspace)).messages).toEqual([])
    } finally { finishSigning(); signSpy.mockRestore(); unsubscribe() }
  })

  it("Given workspace peer authority cannot be read, chat fails closed before persistence or publication", async () => {
    await ensureChatProfile(workspace)
    vi.spyOn(peerStore, "listPeers").mockRejectedValue(new Error("Peer authority unavailable"))
    const append = vi.spyOn(chatStore, "append")
    const published: unknown[] = []
    const unsubscribe = subscribeChat(change => published.push(change))
    try {
      await expect(sendChatMessage(workspace, "Authority read failure must fail closed")).rejects.toThrow("Peer authority unavailable")
      expect(append).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect((await firstStore.load(workspace)).messages).toEqual([])
    } finally { unsubscribe() }
  })

  it("Given device renewal while a message signature is pending, no stale-device message is persisted or published", async () => {
    const identity = await vi.importActual<typeof IdentityModule>("../domain/identity")
    identity.resetIdentityStorageForTest()
    first = await identity.bootstrapIdentity("Signing guard owner")
    current.profile = first
    activeStore = firstStore
    vi.mocked(defaultProofStore.listCertificates).mockResolvedValue([first.certificate])
    await ensureChatProfile(workspace)

    let finishSigning!: () => void
    let signingStarted!: () => void
    const started = new Promise<void>(resolve => { signingStarted = resolve })
    const gate = new Promise<void>(resolve => { finishSigning = resolve })
    const originalSign = crypto.subtle.sign.bind(crypto.subtle)
    let delaySign = true
    const signSpy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      if (delaySign) { delaySign = false; signingStarted(); await gate }
      return originalSign(...args)
    })
    const append = vi.spyOn(chatStore, "append")
    const published: unknown[] = []
    const unsubscribe = subscribeChat(change => published.push(change))
    try {
      const sending = sendChatMessage(workspace, "Must not survive device change")
      await started
      const renewed = await identity.renewDeviceIdentity()
      current.profile = renewed
      vi.mocked(defaultProofStore.listCertificates).mockResolvedValue([first.certificate, renewed.certificate])
      finishSigning()
      await expect(sending).rejects.toThrow()
      expect(append).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect((await firstStore.load(workspace)).messages).toEqual([])
    } finally {
      finishSigning()
      signSpy.mockRestore()
      unsubscribe()
    }
  })

})
