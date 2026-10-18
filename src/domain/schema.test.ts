import { hasEntityKind } from "./model"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import {
  projectBoardSchema,
  validateBoardSchemaDraft,
  diffBoardSchema,
  type BoardSchemaDraft,
} from "./schema"
import { executeCommand } from "./commands"
import type { WorkspaceDocumentV2, FieldDefinition, Item } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Board Schema Projection, Validation and Atomic Diff (Gate E)", () => {
  let profile: LocalProfile

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Alice")
  })

  it("projects canonical entities to disposable typed JSON schema draft without exposing private keys or card data", () => {
    const raw = createWorkspaceDoc("ws_test", "Product Roadmap", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => hasEntityKind(e, "board"))!
    const draft = projectBoardSchema(doc, board.id)

    expect(draft.boardId).toBe(board.id)
    expect(draft.boardTitle).toBe("Product Roadmap")
    expect(draft.columns.map((c) => c.title)).toEqual(["To do", "Doing", "Done"])
    expect(draft.fields).toEqual([])
    expect(draft.cardAgingPolicy).toEqual({ version: 1, thresholds: { watch: 7, aged: 14, overdue: 30 } })

    // Verify no private identity, devices, certificates, or items are in draft
    expect(draft).not.toHaveProperty("ownerPersonId")
    expect(draft).not.toHaveProperty("entities")
    expect(draft).not.toHaveProperty("leads")
  })

  it("validates draft with precise JSON paths for invalid column and field definitions", () => {
    const invalidDraft = {
      boardId: "board-1",
      boardTitle: "",
      entityName: "",
      columns: [
        { id: "c1", title: "Valid" },
        { id: "c2", title: "   " }, // empty title
      ],
      fields: [
        {
          id: "f1",
          title: "Status Field",
          valueType: "unknown_type",
          required: false,
        },
        {
          id: "f2",
          title: "Priority",
          valueType: "select",
          required: true,
          options: [{ id: "opt1", title: "" }], // empty option title
        },
      ],
    }

    const res = validateBoardSchemaDraft(invalidDraft)
    expect(res.valid).toBe(false)
    const paths = res.errors.map((e) => e.path)
    expect(paths).toContain("/boardTitle")
    expect(paths).toContain("/entityName")
    expect(paths).toContain("/columns/1/title")
    expect(paths).toContain("/fields/0/valueType")
    expect(paths).toContain("/fields/1/options/0/title")

    const validDraftWithDatetime: BoardSchemaDraft = {
      boardId: "board-1",
      boardTitle: "Valid Board",
      entityName: "item",
      columns: [{ title: "Col 1" }],
      fields: [
        {
          title: "Created At",
          valueType: "datetime",
          required: false,
        },
      ],
    }
    expect(validateBoardSchemaDraft(validDraftWithDatetime).valid).toBe(true)

    validDraftWithDatetime.cardAgingPolicy = { version: 1, thresholds: { watch: 14, aged: 7, overdue: 30 } }
    expect(validateBoardSchemaDraft(validDraftWithDatetime).errors).toContainEqual({
      path: "/cardAgingPolicy/thresholds",
      message: "Aging thresholds must increase from watch to aged to overdue",
    })
  })

  it("projects one explicit archive role and rejects a second archive column", () => {
    const raw = createWorkspaceDoc("ws_test", "Applications", profile.identity.personId, "job-search")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)
    const board = Object.values(doc.entities).find((entity) => hasEntityKind(entity, "board"))!
    const draft = projectBoardSchema(doc, board.id)
    const archiveIndex = draft.columns.findIndex((column) => column.archive)

    expect(archiveIndex).toBeGreaterThanOrEqual(0)
    expect(draft.columns[archiveIndex]).toMatchObject({ title: "Archive", archive: true })

    draft.columns[0].archive = true
    expect(validateBoardSchemaDraft(draft)).toMatchObject({
      valid: false,
      errors: [{ path: `/columns/${archiveIndex}/archive`, message: "Only one archive column is allowed" }],
    })
  })

  it("rejects moving Archive role onto a column with active items", () => {
    const raw = createWorkspaceDoc("ws_archive_occupied", "Applications", profile.identity.personId, "job-search")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)
    const board = Object.values(doc.entities).find((entity) => hasEntityKind(entity, "board"))!
    const draft = projectBoardSchema(doc, board.id)
    const target = draft.columns.find(column => column.title === "Rejected")!
    const active: Item = {
      id: "active-rejected",
      title: "Active card",
      body: "",
      values: {},
      placement: { parentId: target.id!, rank: "0/1" },
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
      lifecycle: JSON.stringify({ state: "active", changedAt: "2026-10-07T00:00:00.000Z" }),
    }
    const withActive = Automerge.change(doc, mutable => { mutable.entities[active.id] = active })
    const archive = draft.columns.find(column => column.archive)!
    delete archive.archive
    target.archive = true

    expect(validateBoardSchemaDraft(draft, withActive)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([{ path: `/columns/${draft.columns.indexOf(target)}/archive`, message: "Archive role cannot hide active items" }]),
    })
  })

  it("rejects removing the Archive role while archived items would become hidden", () => {
    const raw = createWorkspaceDoc("ws_archive_removal", "Applications", profile.identity.personId, "job-search")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    const draft = projectBoardSchema(doc, board.id)
    const lead = draft.columns.find(column => column.title === "Lead")!
    const archived: Item = {
      id: "archived-without-role",
      title: "Keep archived",
      body: "",
      values: {},
      placement: { parentId: lead.id!, rank: "0/1" },
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
      lifecycle: JSON.stringify({ state: "archived", changedAt: "2026-10-07T00:00:00.000Z" }),
    }
    const withArchived = Automerge.change(doc, mutable => { mutable.entities[archived.id] = archived })
    delete draft.columns.find(column => column.archive)!.archive

    expect(validateBoardSchemaDraft(draft, withArchived)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([{ path: "/columns", message: "Archive role cannot be removed while archived items exist" }]),
    })
  })

  it("diffs schema draft against canonical doc showing renames, archiving, and option retention", () => {
    const raw = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => hasEntityKind(e, "board"))!
    const draft = projectBoardSchema(doc, board.id)

    // Rename first column, remove second column (archive), add a new column
    draft.columns[0].title = "Backlog"
    const removedColId = draft.columns[1].id!
    draft.columns.splice(1, 1) // removes "Doing"
    draft.columns.push({ title: "Archived Columns" })

    // Add a field with options
    draft.fields.push({
      title: "Severity",
      valueType: "select",
      required: true,
      options: [
        { id: "opt-p1", title: "P1" },
        { id: "opt-p2", title: "P2" },
      ],
    })

    const diff = diffBoardSchema(doc, board.id, draft)
    expect(diff.columnsRenamed).toEqual([
      { id: draft.columns[0].id!, oldTitle: "To do", newTitle: "Backlog" },
    ])
    expect(diff.columnsArchived.map((c) => c.id)).toContain(removedColId)
    expect(diff.columnsAdded.map((c) => c.title)).toContain("Archived Columns")
    expect(diff.fieldsAdded.map((f) => f.title)).toContain("Severity")
  })

  it("applies schema draft through atomic updateBoardSchema command retaining stable IDs and archiving removals", async () => {
    const raw = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => hasEntityKind(e, "board"))!
    const initialDraft = projectBoardSchema(doc, board.id)
    const originalCol0Id = initialDraft.columns[0].id!
    const removedColId = initialDraft.columns[1].id!

    // Modify schema draft
    initialDraft.columns[0].title = "Inbox"
    initialDraft.columns.splice(1, 1) // archive "Doing"
    initialDraft.columns.push({ title: "Shipped" })
    initialDraft.fields.push({
      title: "Priority",
      valueType: "select",
      required: false,
      options: [
        { id: "opt-low", title: "Low" },
        { id: "opt-high", title: "High" },
      ],
    })

    const result = await executeCommand(
      doc,
      {
        kind: "updateBoardSchema",
        boardId: board.id,
        schema: initialDraft,
      },
      profile
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const newDoc = result.value.newDoc
    const updatedCol0 = newDoc.entities[originalCol0Id]
    expect(updatedCol0?.title).toBe("Inbox")
    expect(updatedCol0?.archivedAt).toBeNull()

    // Removed column is soft-archived, NOT destroyed
    const archivedCol = newDoc.entities[removedColId]
    expect(archivedCol).toBeDefined()
    expect(archivedCol?.archivedAt).toEqual(expect.any(String))

    // New column created
    const shippedCol = Object.values(newDoc.entities).find(
      (e) => hasEntityKind(e, "column") && e.title === "Shipped" && !e.archivedAt
    )
    expect(shippedCol).toBeDefined()

    // New field created with options
    const priorityField = Object.values(newDoc.entities).find(
      (e): e is FieldDefinition => hasEntityKind(e, "field") && e.title === "Priority" && !e.archivedAt
    )
    expect(priorityField).toBeDefined()
    if (priorityField && priorityField.valueType === "select") {
      expect(priorityField.options["opt-low"].title).toBe("Low")
      expect(priorityField.options["opt-high"].title).toBe("High")
    }
  })

  it("detects concurrent draft conflict if expectedHeads do not match current doc heads", async () => {
    const raw = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)

    const board = Object.values(doc.entities).find((e) => hasEntityKind(e, "board"))!
    const draft = projectBoardSchema(doc, board.id)

    // Stale expected heads
    const staleHeads = ["stale-head-hash"]

    const result = await executeCommand(
      doc,
      {
        kind: "updateBoardSchema",
        boardId: board.id,
        schema: draft,
        expectedHeads: staleHeads,
      },
      profile
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("conflict")
      expect(result.error.message).toContain("Concurrent edits arrived")
    }
  })
})
