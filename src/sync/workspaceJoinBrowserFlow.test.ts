import { expect, it, vi } from "vitest"
import { connectWorkspaceJoin, type WorkspaceJoinBrowserContext } from "./workspaceJoinBrowserFlow"
import { createDeviceSyncState } from "./deviceSyncState"
import type { SyncNode } from "./transport"
import type * as Iroh from "../iroh"
const scenario = vi.hoisted(() => ({ beforeResume: undefined as (() => Promise<void>) | undefined }))

vi.mock("./workspaceSet", () => ({ workspaceSet: () => ({}), liveWorkspaceSetSync: () => ({ publish: async () => {}, close: async () => {} }) }))
vi.mock("../iroh", async importOriginal => ({ ...(await importOriginal() as typeof Iroh),
  WasmWorkspaceJoinHandshake: class {}, WasmWorkspaceJoinHandoff: class {} }))
vi.mock("@meta-uber/mesh-runtime", () => ({
  BrowserWorkspaceJoinGuest: class { async handle() {} },
  BrowserWorkspaceJoinHandoffGuest: class {
    async run(_connection: unknown, resume: () => Promise<void>) {
      if (scenario.beforeResume) { await scenario.beforeResume(); return { kind: "retry" } }
      await resume(); return { kind: "adopted", confirmationSent: true }
    }
  },
}))

it.each(["request", "resume", "replacement"])("Given guest handoff in %s, When pairing Close takes ownership, Then the old join cycle cannot close the adopted node or clear a newer session", async phase => {
  const previousWindow = globalThis.window, previousNavigator = globalThis.navigator
  vi.stubGlobal("window", new EventTarget())
  vi.stubGlobal("navigator", { onLine: true })
  const stream = { send: async () => {}, read: async () => new Uint8Array(), readPairingFrame: async () => new Uint8Array(), closeSend: async () => {} }
  const connection = { openStream: async () => stream, acceptStream: async () => stream, close: async () => {} }
  const close = vi.fn(async () => {})
  const node: SyncNode = { endpointId: "guest-node", close, dial: async () => connection,
    createGossipEngine: () => ({} as never), accept: async () => ({ accept: async () => undefined, close: async () => {} }) }
  let directNode: SyncNode | undefined, run = 1
  const replacementNode = { ...node, endpointId: "replacement-node" }, replacementSession = {} as never
  const replacementWatcher = () => {}
  let currentSession: unknown, currentWatcher: unknown
  const resume = vi.fn(async (adopted: SyncNode) => {
    expect(adopted).toBe(node)
    // Model Close: clear the direct node and close only resources it still owns.
    const owned = directNode; directNode = undefined; run++
    await owned?.close("Pairing closed")
  })
  scenario.beforeResume = phase !== "resume" ? async () => {
    const adopted = directNode; directNode = undefined; run++
    await resume(adopted!)
    if (phase === "replacement") {
      directNode = replacementNode
      currentSession = replacementSession
      currentWatcher = replacementWatcher
    }
  } : undefined
  const context: WorkspaceJoinBrowserContext = {
    state: createDeviceSyncState(), workspace: {} as never, workspaceStore: {} as never,
    durableMesh: { startInstanceNode: async () => node, createGuestAdvertisements: async () => [], resumeAll: resume, waitUntilListening: async () => {} } as never,
    transport: { start: async () => node }, getProfile: async () => ({ identity: { personId: "guest", displayName: "Guest" } } as never),
    currentRun: () => run, waitToReconnect: async () => {}, setNode: value => { directNode = value }, getNode: () => directNode,
    setLiveSession: value => { currentSession = value }, setStopWatching: value => { currentWatcher = value }, clearPairingLocation: () => {},
  }
  try {
    await connectWorkspaceJoin(context, 1, { issuerPersonId: "owner", issuerEndpoint: "host", workspaces: [{ id: "board" }], secret: new Uint8Array(32) } as never)
    expect(resume).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    if (phase === "replacement") {
      expect(directNode).toBe(replacementNode)
      expect(currentSession).toBe(replacementSession)
      expect(currentWatcher).toBe(replacementWatcher)
    }
  } finally { scenario.beforeResume = undefined; vi.stubGlobal("window", previousWindow); vi.stubGlobal("navigator", previousNavigator) }
})
