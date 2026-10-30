import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, describe, expect, it, vi } from "vitest"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceStorage } from "../storage"
import { createSyncActions } from "../stateSyncActions"
import { createBoardAddressController, type BoardAddressRuntime } from "./useBoardAddress"

const doc = (id: string, boardId: string, title: string) => ({ id, title, entities: { [boardId]: { id: boardId, kind: "board", title } } })

beforeAll(async () => {
  await Automerge.initializeWasm(new Uint8Array(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")))
})

describe("private board address integration", () => {
  it.each([false, true])("Given inactive native boards and a matching address %s, when resolving that address, then release inspected copies without exposing a different board", async matching => {
    const actions = createSyncActions(), allocated: Automerge.Doc<WorkspaceDocumentV2>[] = []
    const records = new Map(["unrelated", "stored-a", "stored-b"].map(id => [id, createWorkspaceDoc(id, id, "owner", "blank")]))
    const storage = { loadWorkspaceDoc: async (id: string) => {
      const document = Automerge.from(records.get(id)!)
      allocated.push(document)
      return { doc: document }
    } } as WorkspaceStorage
    let activeId = "unrelated"
    const target = "stored-b"
    const boardId = (id: string) => Object.values(records.get(id)!.entities).find(entity => entity.kind === "board")!.id
    const runtime = {
      getAvailableWorkspaces: () => [{ id: "stored-a" }, { id: target }],
      getActiveWorkspaceId: () => activeId,
      getActiveBoard: () => ({ id: boardId(activeId), title: activeId }),
      getIdentityId: () => "owner",
      readWorkspaceDoc: (id: string) => actions.readWorkspaceDoc(id, storage),
      withWorkspaceDoc: <T>(id: string, read: (document: Automerge.Doc<WorkspaceDocumentV2>) => T | Promise<T>) => actions.withWorkspaceDoc(id, read, storage),
      switchWorkspace: vi.fn(async (id: string) => { activeId = id }),
    }
    const integration = createBoardAddressController(runtime, historyAt(`/boards/${matching ? boardId(target) : "missing"}/board`))
    const live = () => allocated.filter(document => {
      try { Automerge.getHeads(document); return true } catch { return false }
    })
    try {
      expect(await integration.resolveAddress()).toBe(matching ? "available" : "unavailable")
      expect(activeId).toBe(matching ? target : "unrelated")
      expect(allocated).toHaveLength(2)
      expect(live()).toHaveLength(0)
    } finally { for (const document of live()) Automerge.free(document) }
  })
  it.each(["", "&rusty=https%3A%2F%2Frusty.example"])("Given a saved published board and legacy locator %s, when navigating, then keep a clean private address and preserve message navigation", locator => {
    const history = historyAt(`/boards/published/old?message=m${locator}#message-m`)
    let board: { id: string; title: string; publicationOrigin?: string } = { id: "published", title: "Published", publicationOrigin: "https://rusty.example" }
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace" }], getActiveWorkspaceId: () => "workspace",
      getActiveBoard: () => board, getIdentityId: () => "person", withWorkspaceDoc: vi.fn(), switchWorkspace: vi.fn(),
    }, history)
    integration.syncActiveBoard("workspace")
    expect(history.location()).toEqual({ pathname: "/boards/published/published", search: "?message=m", hash: "#message-m" })
    expect(new URLSearchParams(history.location().search).get("message")).toBe("m")
    board = { id: "private", title: "Private" }
    integration.syncActiveBoard("workspace")
    expect(new URLSearchParams(history.location().search).has("rusty")).toBe(false)
  })
  it("Given an address lookup still reading the old board, when user navigation selects another board, then the late lookup cannot switch back", async () => {
    const history = historyAt("/boards/old/untitled")
    let active = "old-workspace"
    let release!: (value: WorkspaceDocumentV2) => void
    const switchWorkspace = vi.fn(async (id: string) => { active = id })
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "old-workspace" }, { id: "new-workspace" }],
      getActiveWorkspaceId: () => active,
      getActiveBoard: () => ({ id: active === "old-workspace" ? "old" : "new", title: active }),
      getIdentityId: () => "person-1",
      withWorkspaceDoc: scoped(() => new Promise(resolve => { release = resolve })),
      switchWorkspace,
    }, history)
    const resolving = integration.resolveAddress()
    active = "new-workspace"
    integration.syncActiveBoard(active)
    release(doc("old-workspace", "old", "Untitled") as unknown as WorkspaceDocumentV2)
    await resolving
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(history.location().pathname).toBe("/boards/new/new-workspace")
  })
  it("reveals a saved preview only when the current identity already has the exact active board", () => {
    const history = historyAt("/boards/board-target/old-title?message=m#message-m")
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }],
      getActiveWorkspaceId: () => "workspace-a",
      getActiveBoard: () => ({ id: "board-target", title: "Current title" }),
      getIdentityId: () => "person-1",
      withWorkspaceDoc: vi.fn(),
      switchWorkspace: vi.fn(),
    }, history)
    expect(integration.resolveActivePreview()).toBe("available")
    expect(history.location()).toEqual({ pathname: "/boards/board-target/current-title", search: "?message=m", hash: "#message-m" })
  })

  it("keeps saved preview hidden when route points at another board or identity is not loaded", () => {
    const switchWorkspace = vi.fn()
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }],
      getActiveWorkspaceId: () => "workspace-a",
      getActiveBoard: () => ({ id: "board-a", title: "Unrelated" }),
      getIdentityId: () => "person-1",
      withWorkspaceDoc: vi.fn(),
      switchWorkspace,
    }, historyAt("/boards/private-target/shared-slug"))
    expect(integration.resolveActivePreview()).toBe("resolving")
    expect(switchWorkspace).not.toHaveBeenCalled()

    const anonymous = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }],
      getActiveWorkspaceId: () => "workspace-a",
      getActiveBoard: () => ({ id: "private-target", title: "Private" }),
      getIdentityId: () => null,
      withWorkspaceDoc: vi.fn(),
      switchWorkspace: vi.fn(),
    }, historyAt("/boards/private-target/private"))
    expect(anonymous.resolveActivePreview()).toBe("resolving")
  })

  it("loads only entitled workspace summaries on explicit target resolution and activates exact board", async () => {
    const records = new Map([ ["workspace-a", doc("workspace-a", "board-a", "A")], ["workspace-b", doc("workspace-b", "board-target", "Current title")] ])
    let active = { id: "workspace-a" }
    const readWorkspaceDoc = vi.fn(async (id: string) => records.get(id)! as unknown as WorkspaceDocumentV2)
    const switched: string[] = []
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }, { id: "workspace-b" }],
      getActiveWorkspaceId: () => active.id,
      getActiveBoard: () => active.id === "workspace-b" ? { id: "board-target", title: "Current title" } : { id: "board-a", title: "A" },
      getIdentityId: () => "person-1",
      withWorkspaceDoc: scoped(readWorkspaceDoc),
      switchWorkspace: async id => { switched.push(id); active = { id } },
    }, historyAt("/boards/board-target/old-title?message=m#message-m"))
    expect(await integration.resolveAddress()).toBe("available")
    expect(readWorkspaceDoc.mock.calls.map(([id]) => id)).toEqual(["workspace-a", "workspace-b"])
    expect(switched).toEqual(["workspace-b"])
    expect(integration.history.location()).toEqual({ pathname: "/boards/board-target/current-title", search: "?message=m", hash: "#message-m" })
  })

  it("rejects inaccessible targets without exposing the unrelated active board", async () => {
    const onUnavailable = vi.fn()
    const switchWorkspace = vi.fn()
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }],
      getActiveWorkspaceId: () => "workspace-a",
      getActiveBoard: () => ({ id: "board-a", title: "Unrelated" }),
      getIdentityId: () => "person-1",
      withWorkspaceDoc: scoped(async () => doc("workspace-a", "board-a", "Unrelated") as unknown as WorkspaceDocumentV2),
      switchWorkspace,
      onUnavailable,
    }, historyAt("/boards/private-target/shared-slug"))
    expect(await integration.resolveAddress()).toBe("unavailable")
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledWith("private-target")
  })

  it("uses the exact hinted workspace only when it remains in current identity catalog", async () => {
    const readWorkspaceDoc = vi.fn(async (id: string) => { void id; return doc("workspace-other", "target", "Target") as unknown as WorkspaceDocumentV2 })
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-eligible" }],
      getHintedWorkspaceId: () => "workspace-foreign",
      getActiveWorkspaceId: () => "workspace-eligible",
      getActiveBoard: () => ({ id: "other", title: "Other" }),
      getIdentityId: () => "person-current",
      withWorkspaceDoc: scoped(readWorkspaceDoc),
      switchWorkspace: vi.fn(),
    }, historyAt("/boards/target/target"))
    expect(await integration.resolveAddress()).toBe("unavailable")
    expect(readWorkspaceDoc.mock.calls.map(([id]) => id)).toEqual(["workspace-eligible"])
  })
})

function historyAt(path: string) {
  const url = new URL(path, "https://example.test")
  const listeners = new Set<(event: Event) => void>()
  const history = {
    location: () => ({ pathname: url.pathname, search: url.search, hash: url.hash }),
    pushState: vi.fn((_state: unknown, _title: string, next: string) => { url.href = new URL(next, url).href }),
    replaceState: vi.fn((_state: unknown, _title: string, next: string) => { url.href = new URL(next, url).href }),
    addEventListener: (_type: string, callback: (event: Event) => void) => listeners.add(callback),
    removeEventListener: (_type: string, callback: (event: Event) => void) => listeners.delete(callback),
    fire: () => { for (const listener of listeners) listener(new Event("popstate")) },
  }
  return history
}

function scoped(read: (id: string) => Promise<WorkspaceDocumentV2>): BoardAddressRuntime["withWorkspaceDoc"] {
  return async (id, inspect) => inspect(await read(id))
}
