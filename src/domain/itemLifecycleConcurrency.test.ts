import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { isArchiveColumn, itemLifecycle, itemWorkflow, setItemLifecycle } from "./archive"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { executeCommand } from "./commands"
import { prepareCommand } from "./commandHandlers"
import { hasEntityKind, type Item, type WorkspaceDocumentV2 } from "./model"
import { validateWorkspaceDoc } from "./validation"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

function applyAt(doc: Automerge.Doc<WorkspaceDocumentV2>, command: Parameters<typeof executeCommand>[1], actor: string, nowIso: string) {
  const prepared = prepareCommand(doc, command, nowIso, Automerge.getHeads(doc).sort())
  if (!prepared.ok) throw new Error(prepared.error.message)
  return Automerge.change(Automerge.clone(doc, { actor }), draft => prepared.value.apply(draft))
}

describe("item lifecycle/workflow Automerge concurrency", () => {
  let profile: LocalProfile
  let base: Automerge.Doc<WorkspaceDocumentV2>
  let boardId: string
  let columns: string[]
  let itemId: string

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Concurrency test")
    base = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("concurrent-items", "Board", profile.identity.personId, "blank"))
    const board = Object.values(base.entities).find(entity => hasEntityKind(entity, "board"))!
    boardId = board.id
    columns = Object.values(base.entities).filter(entity => hasEntityKind(entity, "column") && entity.placement.parentId === boardId).map(column => column.id)
    itemId = "concurrent-item"
    base = Automerge.change(base, draft => {
      draft.entities[itemId] = {
        id: itemId, title: "Card", body: "", values: {}, placement: { parentId: columns[0]!, rank: "0/1" },
        archivedAt: "2026-01-01T00:00:00.000Z", lifecycle: JSON.stringify({ state: "archived", changedAt: "2026-01-01T00:00:00.000Z" }),
        workflow: JSON.stringify({ columnId: columns[0]!, changedAt: "2026-01-01T00:00:00.000Z" }),
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      } as Item
    })
  })

  it("merges concurrent archive and restore branches into a valid paired lifecycle record", async () => {
    const restore = applyAt(base, { kind: "setEntityArchived", entityId: itemId, archived: false }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-02-02T00:00:00.000Z")
    const archive = applyAt(base, { kind: "setEntityArchived", entityId: itemId, archived: true }, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2026-02-03T00:00:00.000Z")
    const merged = Automerge.merge(restore, archive)
    const item = merged.entities[itemId] as Item
    const lifecycle = itemLifecycle(item)
    const validLifecycleValues = [
      { state: "active", changedAt: "2026-02-02T00:00:00.000Z" },
      { state: "archived", changedAt: "2026-02-03T00:00:00.000Z" },
    ]
    expect(validLifecycleValues.some(value => lifecycle?.state === value.state && lifecycle?.changedAt === value.changedAt)).toBe(true)
    expect(validateWorkspaceDoc(merged).ok).toBe(true)
  })

  it("keeps exactly one designated archive column after concurrent archive-column creation", async () => {
    const clean = Automerge.change(base, draft => {
      delete (draft.entities[boardId] as { archiveColumnId?: string | null }).archiveColumnId
      delete (draft.entities[boardId] as { cardStageButtons?: unknown }).cardStageButtons
    })
    const command = (title: string) => ({ kind: "createColumn" as const, boardId, title, archive: true as const })
    const left = await executeCommand(Automerge.clone(clean, { actor: "cccccccccccccccccccccccccccccccc" }), command("Archive left"), profile, "cccccccccccccccccccccccccccccccc")
    const right = await executeCommand(Automerge.clone(clean, { actor: "dddddddddddddddddddddddddddddddd" }), command("Archive right"), profile, "dddddddddddddddddddddddddddddddd")
    expect(left.ok && right.ok).toBe(true)
    if (!left.ok || !right.ok) return

    const merged = Automerge.merge(left.value.newDoc, right.value.newDoc)
    const board = merged.entities[boardId] as { archiveColumnId?: string | null }
    const designated = Object.values(merged.entities).filter(entity => hasEntityKind(entity, "column") && entity.id === board.archiveColumnId)
    expect(board.archiveColumnId).toBeTruthy()
    expect(designated).toHaveLength(1)
    expect(validateWorkspaceDoc(merged).ok).toBe(true)
  })

  it("lets explicit null suppress a legacy archive marker", () => {
    const legacyColumn = { id: "legacy-archive", kind: "column" as const, title: "Archive", archive: true as const,
      placement: { parentId: boardId, rank: "3/1" }, archivedAt: null, createdAt: "", updatedAt: "" }
    const board = { ...(base.entities[boardId] as object), archiveColumnId: null } as { archiveColumnId: string | null }
    expect(isArchiveColumn(legacyColumn, board)).toBe(false)
    expect(isArchiveColumn(legacyColumn)).toBe(true)
  })

  it("merges a cross-column move with a same-column reorder without splitting workflow placement", () => {
    const active = Automerge.change(base, draft => {
      const item = draft.entities[itemId] as Item
      item.archivedAt = null
      setItemLifecycle(item, false, "2026-02-01T00:00:00.000Z")
      draft.entities["neighbor-item"] = {
        id: "neighbor-item", title: "Neighbor", body: "", values: {}, placement: { parentId: columns[0]!, rank: "1/1" },
        archivedAt: null, lifecycle: JSON.stringify({ state: "active", changedAt: "2026-02-01T00:00:00.000Z" }),
        workflow: JSON.stringify({ columnId: columns[0]!, changedAt: "2026-02-01T00:00:00.000Z" }),
        createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z",
      } as Item
    })
    const moved = applyAt(active, { kind: "moveEntity", entityId: itemId, parentId: columns[1]! }, "11111111111111111111111111111111", "2026-02-02T00:00:00.000Z")
    const reordered = applyAt(active, { kind: "moveEntity", entityId: itemId, parentId: columns[0]!, beforeId: "neighbor-item" }, "22222222222222222222222222222222", "2026-02-03T00:00:00.000Z")
    const merged = Automerge.merge(moved, reordered)
    const item = merged.entities[itemId] as Item
    expect(itemWorkflow(item)?.columnId).toBe(item.placement.parentId)
    expect(itemLifecycle(item)).toEqual({ state: "active", changedAt: "2026-02-01T00:00:00.000Z" })
    expect(validateWorkspaceDoc(merged).ok).toBe(true)
  })

  it("updates nested item workflow when a parent item moves across columns", async () => {
    const active = Automerge.change(base, draft => {
      const parent = draft.entities[itemId] as Item
      parent.archivedAt = null
      setItemLifecycle(parent, false, "2026-02-01T00:00:00.000Z")
      draft.entities["nested-item"] = {
        id: "nested-item", title: "Nested", body: "", values: {}, placement: { parentId: itemId, rank: "0/1" },
        archivedAt: null, lifecycle: JSON.stringify({ state: "active", changedAt: "2026-02-01T00:00:00.000Z" }),
        workflow: JSON.stringify({ columnId: columns[0]!, changedAt: "2026-02-01T00:00:00.000Z" }),
        createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z",
      } as Item
      draft.entities["nested-child"] = {
        id: "nested-child", title: "Nested child", body: "", values: {}, placement: { parentId: "nested-item", rank: "0/1" },
        archivedAt: null, lifecycle: JSON.stringify({ state: "active", changedAt: "2026-02-01T00:00:00.000Z" }),
        workflow: JSON.stringify({ columnId: columns[0]!, changedAt: "2026-02-01T00:00:00.000Z" }),
        createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z",
      } as Item
    })
    const moved = await executeCommand(active, { kind: "moveEntity", entityId: itemId, parentId: columns[1]! }, profile)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(itemWorkflow(moved.value.newDoc.entities["nested-item"] as Item)?.columnId).toBe(columns[1])
    expect(itemWorkflow(moved.value.newDoc.entities["nested-child"] as Item)?.columnId).toBe(columns[1])
    expect(moved.value.receipt.changedEntityIds).toContain("nested-item")
    expect(moved.value.receipt.changedEntityIds).toContain("nested-child")
    expect(validateWorkspaceDoc(moved.value.newDoc).ok).toBe(true)
  })

  it("merges concurrent moves with workflow tracking final placement and preserving lifecycle fields", async () => {
    const active = Automerge.change(base, draft => {
      const item = draft.entities[itemId] as Item
      item.archivedAt = null
      setItemLifecycle(item, false, "2026-02-01T00:00:00.000Z")
    })
    const left = await executeCommand(Automerge.clone(active, { actor: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }), { kind: "moveEntity", entityId: itemId, parentId: columns[1]! }, profile, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
    const right = await executeCommand(Automerge.clone(active, { actor: "ffffffffffffffffffffffffffffffff" }), { kind: "moveEntity", entityId: itemId, parentId: columns[2]! }, profile, "ffffffffffffffffffffffffffffffff")
    expect(left.ok && right.ok).toBe(true)
    if (!left.ok || !right.ok) return

    const merged = Automerge.merge(left.value.newDoc, right.value.newDoc)
    const item = merged.entities[itemId] as Item
    expect(itemWorkflow(item)?.columnId).toBe(item.placement.parentId)
    expect(itemLifecycle(item)).toEqual({ state: "active", changedAt: "2026-02-01T00:00:00.000Z" })
    expect(item.archivedAt).toBeUndefined()
    expect(validateWorkspaceDoc(merged).ok).toBe(true)
  })
})
