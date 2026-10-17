import { describe, expect, it } from "vitest"
import { archivedItemsForBoard, effectiveColumnStatus, isArchiveColumn, isArchiveColumnInWorkspace, isItemArchived, itemLifecycle, itemWorkflow, setItemLifecycle, setItemWorkflow, workflowColumnId } from "./archive"
import { createWorkspaceDoc } from "../test/boardFixture"
import { validateWorkspaceDoc } from "./validation"
import { hasEntityKind, type Item, type WorkspaceDocumentV2, type WorkspaceEntity } from "./model"
import { planWorkspaceMigration } from "./workspaceMigration"

const changedAt = "2026-02-01T00:00:00.000Z"

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item", title: "Item", body: "", values: {}, placement: { parentId: "column", rank: "0/1" },
    createdAt: changedAt, updatedAt: changedAt,
    ...overrides,
  }
}

describe("item lifecycle and workflow records", () => {
  it("includes legacy archived subitems from the same board", () => {
    const doc = createWorkspaceDoc("archive-legacy-subitems", "Board", "owner", "blank")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    const parent = item({ id: "parent", placement: { parentId: column.id, rank: "0/1" }, archivedAt: changedAt })
    const child = item({ id: "child", placement: { parentId: parent.id, rank: "0/1" }, archivedAt: changedAt })
    doc.entities[parent.id] = parent
    doc.entities[child.id] = child
    expect(archivedItemsForBoard(doc, board.id).map(value => value.id)).toEqual(["parent", "child"])
  })

  it("parses scalar and legacy object records, rejecting malformed JSON", () => {
    expect(itemLifecycle(item({ lifecycle: JSON.stringify({ state: "archived", changedAt }) }))).toEqual({ state: "archived", changedAt })
    expect(itemLifecycle(item({ lifecycle: { state: "active", changedAt } }))).toEqual({ state: "active", changedAt })
    expect(itemLifecycle(item({ lifecycle: "{" }))).toBeUndefined()
    expect(itemWorkflow(item({ workflow: JSON.stringify({ columnId: "column", changedAt }) }))).toEqual({ columnId: "column", changedAt })
    expect(itemWorkflow(item({ workflow: "not-json" }))).toBeUndefined()
  })

  it("uses lifecycle as archive authority and falls back to legacy archivedAt only when transition is absent or malformed", () => {
    expect(isItemArchived(item({ lifecycle: JSON.stringify({ state: "active", changedAt }), archivedAt: changedAt }))).toBe(false)
    expect(isItemArchived(item({ lifecycle: JSON.stringify({ state: "archived", changedAt }) }))).toBe(true)
    expect(isItemArchived(item({ lifecycle: "bad-json", archivedAt: changedAt }))).toBe(true)
    expect(isItemArchived(item({ archivedAt: changedAt }))).toBe(true)
    expect(isItemArchived(item({ archivedAt: null }))).toBe(false)
  })

  it("writes each value and timestamp as one transition scalar", () => {
    const value = item({ archivedAt: changedAt })
    setItemLifecycle(value, false, changedAt)
    setItemWorkflow(value, "new-column", changedAt)
    expect(itemLifecycle(value)).toEqual({ state: "active", changedAt })
    expect(itemWorkflow(value)).toEqual({ columnId: "new-column", changedAt })
    expect(value).not.toHaveProperty("archivedAt")
  })

  it("honors explicit null archive role and follows nested item ancestry", () => {
    const legacyColumn = { id: "column", archive: true as const }
    expect(isArchiveColumn(legacyColumn, { archiveColumnId: null })).toBe(false)
    expect(isArchiveColumn(legacyColumn)).toBe(true)

    const doc = createWorkspaceDoc("archive-helper", "Board", "owner", "blank")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    const nested = item({ id: "nested", placement: { parentId: "parent", rank: "0/1" } })
    const parent = item({ id: "parent", placement: { parentId: column.id, rank: "0/1" } })
    const entities = { ...doc.entities, parent, nested }
    const legacyBoard = { ...board }
    delete legacyBoard.archiveColumnId
    expect(isArchiveColumnInWorkspace({ ...legacyColumn, placement: { parentId: board.id } }, { ...entities, [board.id]: { ...board, archiveColumnId: null } })).toBe(false)
    expect(isArchiveColumnInWorkspace({ ...legacyColumn, placement: { parentId: board.id } }, { ...entities, [board.id]: legacyBoard })).toBe(true)
    expect(workflowColumnId(entities, "nested")).toBe(column.id)
    expect(workflowColumnId(entities, "missing")).toBeUndefined()
  })

  it("lists archived items by lifecycle while excluding active and broken ancestry", () => {
    const doc = createWorkspaceDoc("archive-list", "Board", "owner", "blank")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    const archived = item({ id: "archived", placement: { parentId: column.id, rank: "0/1" }, lifecycle: JSON.stringify({ state: "archived", changedAt }) })
    const active = item({ id: "active", placement: { parentId: column.id, rank: "1/1" }, lifecycle: JSON.stringify({ state: "active", changedAt }), archivedAt: changedAt })
    const broken = item({ id: "broken", placement: { parentId: "missing", rank: "0/1" }, lifecycle: JSON.stringify({ state: "archived", changedAt }) })
    const workspace = { ...doc, entities: { ...doc.entities, [archived.id]: archived, [active.id]: active, [broken.id]: broken } } as WorkspaceDocumentV2
    expect(archivedItemsForBoard(workspace, board.id).map(value => value.id)).toEqual([archived.id])
    expect(workflowColumnId(workspace.entities, archived.id)).toBe(column.id)
  })

  it("does not let stale preset archived status transfer archive styling to an ordinary column", () => {
    const formerArchive = { id: "former", archive: true as const }
    expect(effectiveColumnStatus(formerArchive, { archiveColumnId: "current" }, "archived")).toBeUndefined()
    expect(effectiveColumnStatus(formerArchive, { archiveColumnId: null }, "archived")).toBeUndefined()
    expect(effectiveColumnStatus(formerArchive, { archiveColumnId: "former" }, "archived")).toBe("archived")
    expect(effectiveColumnStatus({ id: "ordinary" }, { archiveColumnId: null }, "rejected")).toBe("rejected")
  })

  it("rejects malformed lifecycle and workflow transitions with field-specific errors", () => {
    const doc = createWorkspaceDoc("invalid-transition", "Board", "owner", "blank")
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    const malformed = item({ lifecycle: JSON.stringify({ state: "removed", changedAt: "invalid" }) })
    const invalidLifecycle = { ...doc, entities: { ...doc.entities, [malformed.id]: malformed } } as WorkspaceDocumentV2
    expect(validateWorkspaceDoc(invalidLifecycle)).toMatchObject({ ok: false, error: { field: `entities.${malformed.id}.lifecycle` } })

    const validLifecycle = JSON.stringify({ state: "active", changedAt })
    const malformedWorkflow = item({ lifecycle: validLifecycle, workflow: JSON.stringify({ columnId: column.id, changedAt: "bad-time" }) })
    const invalidWorkflow = { ...doc, entities: { ...doc.entities, [malformedWorkflow.id]: malformedWorkflow } } as WorkspaceDocumentV2
    expect(validateWorkspaceDoc(invalidWorkflow)).toMatchObject({ ok: false, error: { field: `entities.${malformedWorkflow.id}.workflow` } })
  })

  it("rejects missing archive references and multiple legacy archive markers", () => {
    const missingReference = createWorkspaceDoc("missing-archive-ref", "Board", "owner", "blank")
    const board = Object.values(missingReference.entities).find(entity => hasEntityKind(entity, "board"))!
    missingReference.entities[board.id] = { ...board, archiveColumnId: "missing-column" }
    expect(validateWorkspaceDoc(missingReference)).toMatchObject({ ok: false, error: { field: `entities.${board.id}.archiveColumnId` } })

    const duplicateMarkers = createWorkspaceDoc("duplicate-archive-markers", "Board", "owner", "blank")
    const duplicateBoard = Object.values(duplicateMarkers.entities).find(entity => hasEntityKind(entity, "board"))!
    const columns = Object.values(duplicateMarkers.entities).filter(entity => hasEntityKind(entity, "column") && entity.placement.parentId === duplicateBoard.id)
    const first = columns[0]!
    const second = columns[1]!
    duplicateMarkers.entities[first.id] = { ...first, archive: true as const } as WorkspaceEntity
    duplicateMarkers.entities[second.id] = { ...second, archive: true as const } as WorkspaceEntity
    expect(validateWorkspaceDoc(duplicateMarkers)).toMatchObject({ ok: false, error: { field: `entities.${duplicateBoard.id}.archiveColumnId` } })
  })

  it("rejects timestamp and ancestry conflicts in serialized transitions", () => {
    const doc = createWorkspaceDoc("transition-conflicts", "Board", "owner", "blank")
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    const baseLifecycle = JSON.stringify({ state: "active", changedAt })
    const badLifecycle = item({ lifecycle: JSON.stringify({ state: "active", changedAt: "bad-date" }) })
    expect(validateWorkspaceDoc({ ...doc, entities: { ...doc.entities, [badLifecycle.id]: badLifecycle } } as WorkspaceDocumentV2))
      .toMatchObject({ ok: false, error: { field: `entities.${badLifecycle.id}.lifecycle` } })

    const wrongColumn = item({ lifecycle: baseLifecycle, workflow: JSON.stringify({ columnId: "other-column", changedAt }) })
    expect(validateWorkspaceDoc({ ...doc, entities: { ...doc.entities, [wrongColumn.id]: wrongColumn } } as WorkspaceDocumentV2))
      .toMatchObject({ ok: false, error: { field: `entities.${wrongColumn.id}.workflow` } })

    const cyclic = item({ placement: { parentId: "cycle-parent", rank: "0/1" }, lifecycle: baseLifecycle,
      workflow: JSON.stringify({ columnId: column.id, changedAt }) })
    const cycleParent = item({ id: "cycle-parent", placement: { parentId: cyclic.id, rank: "0/1" }, lifecycle: baseLifecycle })
    expect(validateWorkspaceDoc({ ...doc, entities: { ...doc.entities, [cyclic.id]: cyclic, [cycleParent.id]: cycleParent } } as WorkspaceDocumentV2))
      .toMatchObject({ ok: false, error: { field: `entities.${cyclic.id}.workflow` } })
  })

  it("migration preserves explicit null archive selection while clearing legacy marker", () => {
    const doc = createWorkspaceDoc("null-archive-migration", "Board", "owner", "job-search")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    const archive = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column") && entity.title === "Archive")!
    const source = { ...doc, formatVersion: 3 as const, entities: {
      ...doc.entities,
      [board.id]: { ...board, archiveColumnId: null },
      [archive.id]: { ...archive, archive: true as const },
    } }
    const plan = planWorkspaceMigration(source, changedAt)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const migrated = { ...source, entities: { ...source.entities } }
    plan.value.apply(migrated as WorkspaceDocumentV2)
    const migratedBoard = migrated.entities[board.id]
    const migratedArchive = migrated.entities[archive.id]
    if (!hasEntityKind(migratedBoard, "board") || !hasEntityKind(migratedArchive, "column")) throw new Error("Expected migrated board and archive column")
    expect(migratedBoard.archiveColumnId).toBeNull()
    expect(migratedArchive).not.toHaveProperty("archive")
    expect(validateWorkspaceDoc(migrated as WorkspaceDocumentV2).ok).toBe(true)
  })
})
