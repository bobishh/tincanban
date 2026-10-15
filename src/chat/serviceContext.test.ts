import { afterEach, describe, expect, it, vi } from "vitest"
import type * as IdentityModule from "../domain/identity"
const mocks = vi.hoisted(() => ({ load: vi.fn(), append: vi.fn(), merge: vi.fn(), peers: vi.fn(), create: vi.fn() }))
vi.mock("./store", () => ({ chatStore: { load: mocks.load, append: mocks.append, merge: mocks.merge, putProfile: vi.fn() } }))
vi.mock("../domain/identity", async importOriginal => ({ ...await importOriginal<typeof IdentityModule>(),
  bootstrapIdentity: async () => ({ identity: { personId: "person", publicKey: "public", displayName: "Person" }, device: { deviceId: "device" }, certificate: { signature: "certificate", payload: { deviceId: "device" } } }) }))
vi.mock("../domain/proofs", () => ({ defaultProofStore: { listCertificates: async () => [], listGrants: async () => [] } }))
vi.mock("../sync/peerStore", () => ({ peerStore: { listPeers: mocks.peers, getWorkspaceCredential: async () => null, getWorkspaceAuthority: async () => null } }))
vi.mock("./records", () => ({ verifyChatRecord: async (value: unknown) => value }))
vi.mock("./signing", () => ({ createSignedChatRecord: async (workspaceId: string, kind: string, text: string,
  access: { readScope: (workspaceId: string) => Promise<string> }, revision: number, context?: unknown) =>
  mocks.create(null, null, await access.readScope(workspaceId), kind, text, revision, context) }))
import { configureChat, exportChat, getChatScope, receiveChat, sendChatMessage } from "./service"
const previousIndexedDb = globalThis.indexedDB
const previousNavigator = globalThis.navigator
function setup(scope: string) {
  configureChat(async () => "person", async () => scope)
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_: unknown, fn: () => unknown) => fn() } } })
  mocks.load.mockResolvedValue({ messages: [], profiles: [{ personId: "person", name: "Person" }] })
  mocks.append.mockResolvedValue(true)
  mocks.merge.mockResolvedValue({ changed: false, added: [] })
  mocks.peers.mockResolvedValue([])
  mocks.create.mockImplementation(async (_profile, _authority, workspaceId, kind, text, revision, context) => ({ signed: { signature: "signature", payload: { kind, workspaceId, id: "device:message", personId: "person", createdAt: "2026-10-05T00:00:00.000Z", text, revision, version: context ? 2 : 1, ...(context ? { context } : {}) } } }))
}
afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: previousIndexedDb })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator })
  vi.clearAllMocks()
})
describe("context protocol sending boundary", () => {
  it("allows offline workspace without peers and projects durable signed context", async () => {
    setup("scope-offline")
    const context = { references: [{ workspaceScope: "scope-offline", boardId: "board", itemId: "item" }], mentions: [] }
    expect(await getChatScope("local-id")).toBe("scope-offline")
    const message = await sendChatMessage("local-id", " Discuss ", context)
    expect(message.context).toEqual(context)
    expect(message.workspaceId).toBe("scope-offline")
    expect(mocks.append).toHaveBeenCalledWith(message)
  })
  it("allows current local device catalog entry without a remote handshake", async () => {
    setup("scope-self-device")
    mocks.peers.mockResolvedValue([{ deviceId: "device", personId: "person" }])
    await expect(sendChatMessage("local-id", "Local context", { references: [], mentions: ["person"] })).resolves.toMatchObject({ body: "Local context" })
    mocks.peers.mockResolvedValue([{ deviceId: "device", personId: "person" }, { deviceId: "another-own-device", personId: "person" }])
    await expect(sendChatMessage("local-id", "Other device context", { references: [], mentions: ["person"] })).resolves.toMatchObject({ body: "Other device context" })
  })
  it("saves locally before negotiation and with legacy peers", async () => {
    setup("scope-handshake")
    mocks.peers.mockResolvedValue([{ deviceId: "remote" }])
    const context = { references: [], mentions: ["person"] }
    await expect(sendChatMessage("local-id", "Discuss", context)).resolves.toMatchObject({ context })
    await receiveChat("local-id", { version: 1, messages: [], profiles: [] }, false, "remote")
    await expect(sendChatMessage("local-id", "Discuss", context)).resolves.toMatchObject({ context })
    await receiveChat("local-id", { version: 1, capabilities: ["contextual-v2"], messages: [], profiles: [] }, false, "remote")
    await expect(sendChatMessage("local-id", "Discuss", context)).resolves.toMatchObject({ context })
  })
  it("withholds whole v2 records until negotiated, never consumes known signature", async () => {
    setup("scope-export")
    const record = { signed: { signature: "contextual-signature", payload: { version: 2 } } }
    mocks.load.mockResolvedValue({ messages: [{ context: { references: [], mentions: [] }, record }], profiles: [{ personId: "person", name: "Person", record: { signed: { signature: "profile" } } }] })
    const known = new Set<string>()
    expect(await exportChat("local-id", known, "remote")).toMatchObject({ capabilities: ["contextual-v2"], upgradeRequired: true, messages: [] })
    expect(known.has("contextual-signature")).toBe(false)
    await receiveChat("local-id", { version: 1, capabilities: ["contextual-v2"], messages: [], profiles: [] }, false, "remote")
    const upgraded = await exportChat("local-id", known, "remote")
    expect(upgraded.version).toBe(2)
    expect(upgraded.messages).toEqual([record])
    const history = await exportChat("local-id")
    expect(history.version).toBe(2)
    await expect(receiveChat("local-id", history, true)).resolves.toBeUndefined()
  })
  it("reports durable write failure without committing", async () => {
    setup("scope-failure")
    mocks.append.mockRejectedValue(new Error("Quota exceeded"))
    await expect(sendChatMessage("local-id", "Discuss", { references: [], mentions: [] })).rejects.toThrow("Quota exceeded")
  })
})
