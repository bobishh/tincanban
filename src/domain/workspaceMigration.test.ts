import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "../test/boardFixture"
import { validateWorkspaceDoc } from "./validation"
import { needsWorkspaceStateMigration, planWorkspaceMigration } from "./workspaceMigration"
import { hasEntityKind, isItem, type WorkspaceDocumentV2 } from "./model"
import { itemLifecycle, itemWorkflow } from "./archive"

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object fixture")
  return value as Record<string, unknown>
}

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm("/automerge.wasm")
})

function legacyWorkspace(): WorkspaceDocumentV2 {
  const current = asRecord(createWorkspaceDoc("legacy-board", "Legacy board", "owner", "job-search", "2026-01-01T00:00:00.000Z"))
  current.formatVersion = 2
  current.deleted = false
  delete current.archivedAt
  const entities = asRecord(current.entities)
  for (const rawEntity of Object.values(entities)) {
    const entity = asRecord(rawEntity)
    entity.deleted = false
    delete entity.archivedAt
    if (entity.kind === "column") {
      entity.displayHint = "normal"
      if (entity.title === "Archive") entity.archive = true
    }
    if (entity.kind === "board") delete entity.archiveColumnId
    if (entity.kind === "field" && entity.valueType === "select") {
      const options = asRecord(entity.options)
      for (const rawOption of Object.values(options)) {
        const option = asRecord(rawOption)
        option.deleted = false
        delete option.archivedAt
      }
    }
  }
  const lead = Object.values(entities).map(asRecord).find(entity => entity.kind === "column" && entity.title === "Lead")
  if (!lead || typeof lead.id !== "string") throw new Error("Expected Lead column")
  entities["legacy-item"] = { id: "legacy-item", title: "Legacy", body: "", values: {}, placement: { parentId: lead.id, rank: "0/1" }, deleted: true, createdAt: "2025-12-30T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
  return current as unknown as WorkspaceDocumentV2
}

describe("workspace format migration", () => {
  it("detects only format 3 documents missing normalized state", () => {
    const current = createWorkspaceDoc("migration-detection", "Current", "owner", "blank")
    expect(needsWorkspaceStateMigration(null)).toBe(false)
    expect(needsWorkspaceStateMigration([])).toBe(false)
    expect(needsWorkspaceStateMigration({ ...current, formatVersion: 2 })).toBe(false)
    const normalized = structuredClone(current)
    const normalization = planWorkspaceMigration(normalized, "2026-02-01T00:00:00.000Z")
    expect(normalization.ok).toBe(true)
    if (!normalization.ok) return
    normalization.value.apply(normalized)
    expect(needsWorkspaceStateMigration(normalized)).toBe(false)

    const board = Object.values(current.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(current.entities).find(entity => hasEntityKind(entity, "column"))!
    const item = { id: "legacy", title: "Legacy", body: "", values: {}, placement: { parentId: column.id, rank: "0/1" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
    expect(needsWorkspaceStateMigration({ ...current, entities: { ...current.entities, [board.id]: { ...board, archiveColumnId: undefined } } })).toBe(true)
    expect(needsWorkspaceStateMigration({ ...current, entities: { ...current.entities, [column.id]: { ...column, archive: true } } })).toBe(true)
    expect(needsWorkspaceStateMigration({ ...current, entities: { ...current.entities, [item.id]: item } })).toBe(true)
  })

  it("Given signed format 2 data, when owner migrates, then history remains and archive state survives", () => {
    const source = Automerge.from<WorkspaceDocumentV2>(legacyWorkspace())
    const before = Automerge.getAllChanges(source)
    const plan = planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z")
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const migrated = Automerge.change(Automerge.clone(source), draft => plan.value.apply(draft as unknown as WorkspaceDocumentV2))
    expect(Automerge.getAllChanges(migrated).slice(0, before.length)).toEqual(before)
    expect(Automerge.getAllChanges(migrated)).toHaveLength(before.length + 1)
    expect(validateWorkspaceDoc(migrated).ok).toBe(true)
    const archive = Object.values(migrated.entities).find(entity => hasEntityKind(entity, "column") && entity.title === "Archive")
    const board = Object.values(migrated.entities).find(entity => hasEntityKind(entity, "board"))
    const item = migrated.entities["legacy-item"]
    if (!archive || !hasEntityKind(board, "board") || !isItem(item)) throw new Error("Expected migrated board, archive, and item")
    expect(board.archiveColumnId).toBe(archive.id)
    expect(archive.archivedAt).toBeNull()
    expect(archive).not.toHaveProperty("archive")
    expect(itemLifecycle(item)).toEqual({ state: "archived", changedAt: "2026-01-01T00:00:00.000Z" })
    expect(itemWorkflow(item)).toEqual({ columnId: item.placement.parentId, changedAt: "2026-01-01T00:00:00.000Z" })
    expect(item).not.toHaveProperty("archivedAt")
    expect(archive).not.toHaveProperty("deleted")
    expect(archive).not.toHaveProperty("displayHint")
  })

  it("Given malformed format 2 data, when migration is planned, then it fails without changing source", () => {
    const old = legacyWorkspace()
    const column = Object.values(old.entities).find(entity => hasEntityKind(entity, "column"))
    if (!column || !hasEntityKind(column, "column")) throw new Error("Expected column")
    asRecord(column).deleted = "yes"
    const source = Automerge.from<WorkspaceDocumentV2>(old)
    const heads = Automerge.getHeads(source)
    expect(planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z").ok).toBe(false)
    expect(Automerge.getHeads(source)).toEqual(heads)
  })

  it("rejects invalid archive times and recovers malformed transition JSON from legacy state", () => {
    const badArchive = legacyWorkspace()
    asRecord(badArchive).deleted = true
    asRecord(badArchive).updatedAt = "not-a-time"
    expect(planWorkspaceMigration(badArchive, "2026-02-01T00:00:00.000Z").ok).toBe(false)

    const old = legacyWorkspace()
    const legacy = asRecord(old.entities["legacy-item"])
    legacy.lifecycle = "[not a transition]"
    legacy.workflow = "{not-json"
    const source = Automerge.from<WorkspaceDocumentV2>(old)
    const plan = planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z")
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const migrated = Automerge.change(Automerge.clone(source), draft => plan.value.apply(draft as unknown as WorkspaceDocumentV2))
    const item = migrated.entities["legacy-item"]
    if (!isItem(item)) throw new Error("Expected migrated item")
    expect(itemLifecycle(item)).toEqual({ state: "archived", changedAt: "2026-01-01T00:00:00.000Z" })
    expect(itemWorkflow(item)).toEqual({ columnId: item.placement.parentId, changedAt: "2026-01-01T00:00:00.000Z" })
    expect(validateWorkspaceDoc(migrated).ok).toBe(true)
  })

  it("Given mixed archive fields, when migrating, then current archive state wins over stale deleted", () => {
    const old = legacyWorkspace()
    const column = Object.values(old.entities).find(entity => hasEntityKind(entity, "column"))
    if (!column || !hasEntityKind(column, "column")) throw new Error("Expected column")
    asRecord(column).deleted = true
    asRecord(column).archivedAt = null
    const source = Automerge.from<WorkspaceDocumentV2>(old)
    const plan = planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z")
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const migrated = Automerge.change(Automerge.clone(source), draft => plan.value.apply(draft as unknown as WorkspaceDocumentV2))
    expect(migrated.entities[column.id]?.archivedAt).toBeNull()
    expect(migrated.entities[column.id]).not.toHaveProperty("deleted")
    expect(validateWorkspaceDoc(migrated).ok).toBe(true)
  })

  it("Given a legacy format 3 document, when owner migrates, then archive flags and item archiveAt become scalar transitions", () => {
    const old = legacyWorkspace()
    asRecord(old).formatVersion = 3
    const source = Automerge.from<WorkspaceDocumentV2>(old)
    const plan = planWorkspaceMigration(source, "2026-02-01T00:00:00.000Z")
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const migrated = Automerge.change(Automerge.clone(source), draft => plan.value.apply(draft as unknown as WorkspaceDocumentV2))
    const board = Object.values(migrated.entities).find(entity => hasEntityKind(entity, "board"))
    if (!hasEntityKind(board, "board")) throw new Error("Expected migrated board")
    const archive = board.archiveColumnId ? migrated.entities[board.archiveColumnId] : undefined
    const item = migrated.entities["legacy-item"]
    if (!archive || !hasEntityKind(archive, "column") || !isItem(item)) throw new Error("Expected migrated archive and item")
    expect(board.archiveColumnId).toBe(archive.id)
    expect(archive).not.toHaveProperty("archive")
    expect(itemLifecycle(item)).toEqual({ state: "archived", changedAt: "2026-01-01T00:00:00.000Z" })
    expect(itemWorkflow(item)).toEqual({ columnId: item.placement.parentId, changedAt: "2026-01-01T00:00:00.000Z" })
    expect(item).not.toHaveProperty("archivedAt")
    expect(validateWorkspaceDoc(migrated).ok).toBe(true)
  })
})
