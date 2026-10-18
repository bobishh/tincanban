import "fake-indexeddb/auto"
import { hasEntityKind } from "./domain/model"
import { defaultStorage } from "./storage"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { initializeAutomerge } from "./crdt"
import { registerWebMcp, type ModelContext } from "./webmcp"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { useTincanban, hydrate, resetStateForTest } from "./state"
import { isItem } from "./domain/model"
import { clearMeshTrace, meshTrace } from "./sync/meshTrace"
import { itemLifecycle } from "./domain/archive"
import type { WorkspaceSettingsDraft } from "./domain/workspaceSettings"

type RegisteredTool = Parameters<ModelContext["registerTool"]>[0]
let registeredTools: Map<string, RegisteredTool>
type TestTool<TResult> = Omit<RegisteredTool, "execute"> & {
  execute(input: unknown): TResult | Promise<TResult>
}

function requiredTool<TResult>(name: string): TestTool<TResult> {
  const tool = registeredTools.get(name)
  if (!tool) throw new Error(`WebMCP tool ${name} was not registered`)
  return { ...tool, execute: (input) => tool.execute(input) as TResult | Promise<TResult> }
}

function requiredSyncTool<TResult>(name: string): Omit<TestTool<TResult>, "execute"> & {
  execute(input: unknown): TResult
} {
  const tool = requiredTool<TResult>(name)
  return {
    ...tool,
    execute(input: unknown) {
      const result = tool.execute(input)
      if (result instanceof Promise) throw new Error(`WebMCP tool ${name} returned a promise`)
      return result
    },
  }
}

function nestedRecord(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let value: unknown = root
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Missing schema path: ${key}`)
    value = (value as Record<string, unknown>)[key]
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected schema object")
  return value as Record<string, unknown>
}

beforeAll(async () => {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? options as () => Promise<unknown>)() } })
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("generic WebMCP tools", () => {
  let mockContext: ModelContext
  let tincanban: ReturnType<typeof useTincanban>

  beforeEach(async () => {
    for (const workspace of [...await defaultStorage.listWorkspaces(), ...await defaultStorage.listArchivedWorkspaces()]) await defaultStorage.purgeWorkspaceForTest(workspace.id)
    resetIdentityStorageForTest()
    resetStateForTest()
    await bootstrapIdentity("WebMCP Test User")
    await hydrate()
    tincanban = useTincanban()

    registeredTools = new Map()
    mockContext = {
      registerTool: vi.fn((tool) => {
        registeredTools.set(tool.name, tool)
      }),
    }
  })

  it("Given the served agent guide, when tools are registered, then documented names exactly match the runtime surface", async () => {
    await registerWebMcp({ getActiveDoc: tincanban.getActiveDoc }, mockContext)
    const guide = await readFile("public/agent/index.html", "utf8")
    const documented = [...guide.matchAll(/class="tool-name">([^<]+)</g)].map(match => match[1]).sort()
    expect(documented).toEqual([...registeredTools.keys()].sort())
  })

  it("registers generic workspace commands without job-search aliases", async () => {
    const sendChatMessage = vi.fn().mockResolvedValue(undefined)
    await registerWebMcp({
      getActiveDoc: tincanban.getActiveDoc,
      executeCommandAsync: tincanban.executeCommandAsync,
      createWorkspaceAsync: tincanban.createWorkspaceAsync,
      availableWorkspaces: tincanban.availableWorkspaces,
      activeWorkspace: tincanban.activeWorkspace,
      sendChatMessage,
    }, mockContext)

    expect(registeredTools.has("list_workspaces")).toBe(true)
    expect(registeredTools.has("switch_workspace")).toBe(true)
    expect(registeredTools.has("create_workspace")).toBe(true)
    expect(registeredTools.has("rename_workspace")).toBe(true)
    expect(registeredTools.has("list_items")).toBe(true)
    expect(registeredTools.has("create_item")).toBe(true)
    expect(registeredTools.has("patch_item")).toBe(true)
    expect(registeredTools.has("move_entity")).toBe(true)
    expect(registeredTools.has("rename_entity")).toBe(true)
    expect(registeredTools.has("set_item_archived")).toBe(true)
    expect(registeredTools.has("list_archived_items")).toBe(true)
    expect(registeredTools.has("list_placement_issues")).toBe(true)
    expect(registeredTools.has("get_workspace_settings")).toBe(true)
    expect(registeredTools.has("apply_workspace_settings")).toBe(true)

    for (const alias of [
      "list_leads", "create_lead", "move_lead", "list_templates", "get_generation_context",
      "record_pdf_artifact", "add_document", "export_workspace",
    ]) expect(registeredTools.has(alias)).toBe(false)
    expect(registeredTools.has("send_chat_message")).toBe(true)

    await expect(requiredTool<{ sent: boolean }>("send_chat_message").execute({ body: "Vacancy audit complete" }))
      .resolves.toEqual({ sent: true })
    expect(sendChatMessage).toHaveBeenCalledWith("Vacancy audit complete")
  })

  it("Given workspace entities, when their summary is requested, then stable IDs and kinds are discoverable without entity contents", async () => {
    await registerWebMcp({ getActiveDoc: tincanban.getActiveDoc }, mockContext)
    const doc = tincanban.getActiveDoc()!
    const result = requiredSyncTool<{ entities: { id: string; kind: string; title: string }[] }>("get_workspace").execute({})
    expect(result.entities).toHaveLength(Object.keys(doc.entities).length)
    const board = tincanban.activeBoard.value!
    expect(result.entities).toContainEqual({ id: board.id, kind: "board", title: board.title })
    expect(result.entities.every(entity => Object.keys(entity).sort().join() === "id,kind,title")).toBe(true)
    expect(tincanban.getActiveDoc()).toBe(doc)
  })

  it("reads lifecycle evidence without changing workspace data or allowing write inputs", async () => {
    clearMeshTrace()
    meshTrace("session.closed", { connectionId: "in-7", cause: "heartbeat failed" })
    await registerWebMcp({ getActiveDoc: tincanban.getActiveDoc }, mockContext)
    const trace = requiredSyncTool<{ events: { event: string; connectionId?: string; cause?: string }[] }>("get_sync_trace")
    const before = tincanban.getActiveDoc()
    expect(trace.annotations?.readOnlyHint).toBe(true)
    const result = trace.execute({})
    expect(result.events).toEqual([expect.objectContaining({
      event: "session.closed", connectionId: "in-7", cause: "heartbeat failed",
    })])
    expect(() => structuredClone(result)).not.toThrow()
    expect(tincanban.getActiveDoc()).toBe(before)
    expect(() => trace.execute({ reconnect: true })).toThrow()
    clearMeshTrace()
  })

  it("returns cloneable workspace records and switches the active workspace", async () => {
    const originalId = tincanban.activeWorkspace.id
    const second = await tincanban.createWorkspaceAsync("Second workspace", "blank")
    await registerWebMcp({
      getActiveDoc: tincanban.getActiveDoc,
      executeCommandAsync: tincanban.executeCommandAsync,
      createWorkspaceAsync: tincanban.createWorkspaceAsync,
      switchWorkspaceAsync: tincanban.switchWorkspace,
      availableWorkspaces: tincanban.availableWorkspaces,
      activeWorkspace: tincanban.activeWorkspace,
    }, mockContext)

    const workspaces = await requiredTool<{ id: string; title: string; active: boolean }[]>("list_workspaces").execute({})
    expect(() => structuredClone(workspaces)).not.toThrow()
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalId, active: false }),
      expect.objectContaining({ id: second.id, title: "Second workspace", active: true }),
    ]))

    await expect(requiredTool<{ switched: boolean; id: string }>("switch_workspace").execute({ workspaceId: originalId }))
      .resolves.toEqual(expect.objectContaining({ switched: true, id: originalId }))
    expect(tincanban.activeWorkspace.id).toBe(originalId)
    await expect(requiredTool<{ switched: boolean; id: string }>("switch_workspace").execute({ workspaceId: "missing" }))
      .rejects.toThrow("Workspace not found")
  })

  it("reads and atomically applies the complete workspace settings through WebMCP", async () => {
    await registerWebMcp({
      getActiveDoc: tincanban.getActiveDoc,
      executeCommandAsync: tincanban.executeCommandAsync,
      createWorkspaceAsync: tincanban.createWorkspaceAsync,
      availableWorkspaces: tincanban.availableWorkspaces,
      activeWorkspace: tincanban.activeWorkspace,
    }, mockContext)

    const columnsSchema = nestedRecord(requiredTool<{ applied: boolean; settings: WorkspaceSettingsDraft }>("apply_workspace_settings").inputSchema,
      ["properties", "settings", "properties", "board", "properties", "columns", "items", "properties"])
    expect(columnsSchema).toHaveProperty("collapsible")
    expect(columnsSchema).toHaveProperty("color")
    const read = await requiredTool<{ settings: WorkspaceSettingsDraft; heads: string[] }>("get_workspace_settings").execute({})
    read.settings.workspace.title = "Agent workspace"
    read.settings.board.entityName = "record"
    read.settings.board.fields = [
      { title: "Due Date", valueType: "datetime", required: false },
    ]
    read.settings.documentTemplates = [{ title: "Agent template", markdown: "# Record" }]
    const result = await requiredTool<{ applied: boolean; settings: WorkspaceSettingsDraft }>("apply_workspace_settings").execute({ settings: read.settings, expectedHeads: read.heads })

    expect(result.applied).toBe(true)
    expect(result.settings.workspace.title).toBe("Agent workspace")
    expect(result.settings.board.entityName).toBe("record")
    expect(result.settings.board.fields[0].title).toBe("Due Date")
    expect(result.settings.board.fields[0].valueType).toBe("datetime")
    expect(result.settings.documentTemplates[0].title).toBe("Agent template")
  })

  it("executes valid create_item and rejects invalid create_item without mutating", async () => {
    await registerWebMcp({
      getActiveDoc: tincanban.getActiveDoc,
      executeCommandAsync: tincanban.executeCommandAsync,
      createWorkspaceAsync: tincanban.createWorkspaceAsync,
      availableWorkspaces: tincanban.availableWorkspaces,
      activeWorkspace: tincanban.activeWorkspace,
    }, mockContext)

    const createItem = requiredTool<{ id: string }>("create_item")
    const doc = tincanban.getActiveDoc()!
    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column"))!
    expect(col).toBeDefined()

    // 1. Invalid input: missing parentId or empty title
    await expect(createItem.execute({ parentId: col.id, title: "" })).rejects.toThrow(/title is required/i)
    await expect(createItem.execute({ title: "Valid Title" })).rejects.toThrow(/parentId is required/i)

    // Invariant: no item created on failure
    const itemCountBefore = Object.values(tincanban.getActiveDoc()!.entities).filter(isItem).length
    expect(itemCountBefore).toBe(0)

    // 2. Valid input: creates item visibly
    const result = await createItem.execute({ parentId: col.id, title: "Architectural Review", body: "Review BDD dual-loop" })
    expect(result).toHaveProperty("created", true)

    const docAfter = tincanban.getActiveDoc()!
    const items = Object.values(docAfter.entities).filter(isItem)
    expect(items.length).toBe(1)
    expect(items[0].title).toBe("Architectural Review")
  })

  it("executes move_entity and rename_entity with proper validation", async () => {
    await registerWebMcp({
      getActiveDoc: tincanban.getActiveDoc,
      executeCommandAsync: tincanban.executeCommandAsync,
      createWorkspaceAsync: tincanban.createWorkspaceAsync,
      availableWorkspaces: tincanban.availableWorkspaces,
      activeWorkspace: tincanban.activeWorkspace,
    }, mockContext)

    const doc = tincanban.getActiveDoc()!
    const cols = Object.values(doc.entities).filter((e) => hasEntityKind(e, "column"))
    const col1 = cols[0]
    const col2 = cols[1]

    const createItem = requiredTool<{ id: string }>("create_item")
    const moveEntity = requiredTool<unknown>("move_entity")
    const renameEntity = requiredTool<unknown>("rename_entity")

    const res = await createItem.execute({ parentId: col1.id, title: "Original Item" })
    const itemId = res.id

    // Rename
    await expect(renameEntity.execute({ entityId: itemId, title: "" })).rejects.toThrow(/title is required/i)
    await renameEntity.execute({ entityId: itemId, title: "Renamed Item" })
    expect(tincanban.getActiveDoc()!.entities[itemId].title).toBe("Renamed Item")

    // Move to col2
    await moveEntity.execute({ entityId: itemId, parentId: col2.id })
    expect(tincanban.getActiveDoc()!.entities[itemId].placement.parentId).toBe(col2.id)
  })

  it("archives an item and lists it through the same archive state", async () => {
    await registerWebMcp({
      getActiveDoc: tincanban.getActiveDoc,
      executeCommandAsync: tincanban.executeCommandAsync,
      createWorkspaceAsync: tincanban.createWorkspaceAsync,
      availableWorkspaces: tincanban.availableWorkspaces,
      activeWorkspace: tincanban.activeWorkspace,
    }, mockContext)

    const doc = tincanban.getActiveDoc()!
    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column"))!
    const createItem = requiredTool<{ id: string }>("create_item")
    const setArchived = requiredTool<unknown>("set_item_archived")
    const listArchived = requiredTool<{ id: string }[]>("list_archived_items")

    const res = await createItem.execute({ parentId: col.id, title: "To Archive" })
    const itemId = res.id

    await setArchived.execute({ itemId, archived: true })
    const archivedItem = tincanban.getActiveDoc()!.entities[itemId]
    expect(isItem(archivedItem) && itemLifecycle(archivedItem)).toEqual(expect.objectContaining({ state: "archived", changedAt: expect.any(String) }))

    const archived = await listArchived.execute({})
    expect(archived.some(item => item.id === itemId)).toBe(true)
  })

})
