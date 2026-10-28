import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
const f = vi.hoisted(() => ({ root: vi.fn(), configs: [] as Array<Record<string, unknown>>, connect: vi.fn(), push: vi.fn(), sync: vi.fn() }))
vi.mock("../storage", () => ({ defaultStorage: { loadPersonalRoot: f.root } }))
vi.mock("../domain/identityProfileRoot", () => ({ rootIdentityProfileState: vi.fn(async () => ({})) }))
vi.mock("@meta-uber/mesh-identity", () => ({ identityProfileRustyServicePins: () => [{ origin: "https://rusty.example", servicePublicKey: "service-key" }] }))
vi.mock("../sync/privateReplicaRepository", () => ({ getReplicaConfigurations: async () => f.configs,
  getIdentityReplicaConfigurations: async () => [{ purpose: "identity", origin: "https://rusty.example" }] }))
vi.mock("../sync/replicaConnections", () => ({ connectWorkspaceReplica: f.connect }))
vi.mock("../sync/blindReplicaStore", () => ({ createBlindReplica: () => ({ push: f.push }) }))
vi.mock("../sync/identityReplicaStore", () => ({ createIdentityReplica: () => ({ sync: f.sync }) }))
import { connectAdoptedIdentityBoards } from "./connectAdoptedIdentityBoards"

beforeEach(() => {
  vi.clearAllMocks()
  f.configs = []
  f.root.mockResolvedValue({ identity: { personId: "bo" }, workspaces: { "added-board": { workspaceId: "added-board", forgotten: false } } })
  f.connect.mockImplementation(async () => { f.configs.push({ workspaceId: "added-board", origin: "https://rusty.example" }) })
  f.push.mockResolvedValue(undefined)
  f.sync.mockResolvedValue(true)
})
function app(role = "owner") {
  return { getCurrentProfile: () => ({ identity: { personId: "bo" } }),
    readWorkspaceDoc: vi.fn(async () => ({ id: "added-board", ownerPersonId: "previous-local-person" })),
    async withWorkspaceDoc<T>(_id: string, read: (document: Pick<WorkspaceDocumentV2, "id" | "ownerPersonId">) => T | Promise<T>): Promise<T> {
      return read(await this.readWorkspaceDoc())
    },
    getWorkspaceRole: vi.fn(async () => role) }
}
it("Given an explicitly adopted local board and approved Rusty pin, when finishing sign-in, then store its contents before publishing the updated catalog", async () => {
  const order: string[] = []
  f.push.mockImplementation(async () => { order.push("board") })
  f.sync.mockImplementation(async () => { order.push("catalog"); return true })
  await connectAdoptedIdentityBoards(app() as never, () => {})
  expect(f.connect).toHaveBeenCalledOnce()
  expect(f.connect.mock.calls[0]?.[4]).toEqual({ allowNewScopeAfterRemoval: false })
  expect(order).toEqual(["board", "catalog"])
})
it("Given a visited foreign board, when signing in, then never claim it or provision owner storage", async () => {
  await connectAdoptedIdentityBoards(app("visitor") as never, () => {})
  expect(f.connect).not.toHaveBeenCalled()
  expect(f.push).not.toHaveBeenCalled()
})
it("Given adopted-board delivery fails, when finishing sign-in, then expose the failure before claiming catalog delivery", async () => {
  f.push.mockRejectedValueOnce(new Error("Rusty unreachable"))
  await expect(connectAdoptedIdentityBoards(app() as never, () => {})).rejects.toThrow("Rusty unreachable")
  expect(f.sync).not.toHaveBeenCalled()
})

it("Given delivery failed after connection was saved, when sign-in retries, then deliver the existing connection and catalog", async () => {
  f.configs = [{ workspaceId: "added-board", origin: "https://rusty.example" }]
  await connectAdoptedIdentityBoards(app() as never, () => {})
  expect(f.connect).toHaveBeenCalledOnce()
  expect(f.push).toHaveBeenCalledOnce()
  expect(f.sync).toHaveBeenCalledOnce()
})


beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
})
it.each(["owner", "visitor"])("Given adopted-board role %s, when checking its immutable owner before delivery, then release the native copy on both paths", async role => {
  const state = app(role)
  const allocated: Automerge.Doc<WorkspaceDocumentV2>[] = []
  const allocate = async () => {
    const doc = Automerge.from(createWorkspaceDoc("added-board", "Added board", "previous-local-person", "blank"))
    allocated.push(doc)
    return doc
  }
  state.readWorkspaceDoc.mockImplementation(async () => await allocate() as never)
  Object.assign(state, { withWorkspaceDoc: async <T>(_id: string, read: (doc: Automerge.Doc<WorkspaceDocumentV2>) => T | Promise<T>) => {
    const doc = await allocate()
    try { return await read(doc) } finally { Automerge.free(doc) }
  } })
  const live = () => allocated.filter(doc => {
    try { Automerge.getHeads(doc); return true } catch { return false }
  })
  try {
    await connectAdoptedIdentityBoards(state as never, () => {})
    expect(allocated).toHaveLength(1)
    expect(live()).toHaveLength(0)
    expect(f.connect).toHaveBeenCalledTimes(role === "owner" ? 1 : 0)
  } finally { for (const doc of live()) Automerge.free(doc) }
})
