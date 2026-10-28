import { describe, expect, it } from "vitest"
import { createWorkspaceDoc, seedBoard } from "../test/boardFixture"
import { hasEntityKind } from "./model"
import { prepareCommand } from "./commandHandlers"
import { diffBoardSchema, projectBoardSchema } from "./schema"

function fixture() {
  const doc = createWorkspaceDoc("workspace", "Board A", "owner", "blank")
  const boardA = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
  const boardB = seedBoard(doc.entities, "Board B", "blank")
  const schema = projectBoardSchema(doc, boardA.id)
  doc.entities.foreignField = { id: "foreignField", kind: "field", title: "Foreign field", valueType: "text", required: false,
    placement: { parentId: boardB.id, rank: "0/1" }, archivedAt: null,
    createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z" }
  return { doc, boardA, boardB, schema }
}

describe("board schema ownership", () => {
  it("Given a schema from board A, when a command targets board B, then reject before applying either board's settings", () => {
    const { doc, boardB, schema } = fixture()
    const before = structuredClone(doc)
    const result = prepareCommand(doc, { kind: "updateBoardSchema", boardId: boardB.id, schema }, "2026-10-28", [], "owner")
    expect(result.ok).toBe(false)
    expect(doc).toEqual(before)
  })

  it.each(["column", "field"])("Given board A settings containing an existing board B %s, when preparing changes, then reject its foreign identifier", kind => {
    const { doc, boardA, boardB, schema } = fixture()
    if (kind === "column") {
      const foreign = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column") && entity.placement.parentId === boardB.id)!
      schema.columns.push({ id: foreign.id, title: "Captured foreign column" })
    } else schema.fields.push({ id: "foreignField", title: "Captured foreign field", valueType: "text", required: false })
    const result = prepareCommand(doc, { kind: "updateBoardSchema", boardId: boardA.id, schema }, "2026-10-28", [], "owner")
    expect(result.ok).toBe(false)
  })

  it("Given two column definitions sharing an identifier, when preparing board settings, then reject the ambiguous schema", () => {
    const { doc, boardA, schema } = fixture()
    schema.columns.push({ ...schema.columns[0]!, title: "Duplicate" })
    expect(prepareCommand(doc, { kind: "updateBoardSchema", boardId: boardA.id, schema }, "2026-10-28", [], "owner").ok).toBe(false)
  })

  it("Given a new column identifier colliding with a field, when preparing settings, then preserve the existing entity", () => {
    const { doc, boardA, schema } = fixture()
    schema.columns.push({ id: "foreignField", title: "Overwrite field" })
    expect(prepareCommand(doc, { kind: "updateBoardSchema", boardId: boardA.id, schema }, "2026-10-28", [], "owner").ok).toBe(false)
  })

  it("Given unused caller-allocated IDs, when adding definitions to their declared board, then retain supported creation behavior", () => {
    const { doc, boardA, schema } = fixture()
    schema.columns.push({ id: "new-column", title: "New column" })
    schema.fields.push({ id: "new-field", title: "New field", valueType: "text", required: false })
    const result = prepareCommand(doc, { kind: "updateBoardSchema", boardId: boardA.id, schema }, "2026-10-28", [], "owner")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    result.value.apply(doc)
    expect(doc.entities["new-column"].placement.parentId).toBe(boardA.id)
    expect(doc.entities["new-field"].placement.parentId).toBe(boardA.id)
    expect(doc.entities.foreignField.placement.parentId).not.toBe(boardA.id)
  })

  it("Given a new column with a caller-allocated ID, when reviewing its schema, then show an addition rather than dereference a missing retained column", () => {
    const { doc, boardA, schema } = fixture()
    schema.columns.push({ id: "new-column", title: "New column" })
    const diff = diffBoardSchema(doc, boardA.id, schema)
    expect(diff.columnsAdded).toEqual([{ title: "New column" }])
    expect(diff.columnsRenamed).toEqual([])
  })
})
