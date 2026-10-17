import { expect, it } from "vitest"
import { validateFieldValue } from "./fields"
import type { FieldDefinition, Board, Item } from "./model"
import { projectItemPriority } from "./priority"
import { validateBoardSchemaDraft } from "./schema"

const field = { id: "source", title: "Source text", valueType: "text", required: false } as FieldDefinition
it("Given ordinary text, when it resembles JSON, then it remains unrestricted text", () => {
  expect(validateFieldValue(field, '{"decision":')).toEqual({ valid: true })
})
it("Given explicit JSON format, when text is malformed, then validation identifies the field", () => {
  expect(validateFieldValue({ ...field, format: "json" } as FieldDefinition, '{"decision":')).toEqual({ valid: false, issue: "Source text must be valid JSON" })
  expect(validateFieldValue({ ...field, format: "json" } as FieldDefinition, '{"a":1}')).toEqual({ valid: true })
})
it("Given plain source text and an unsupported evaluator, when projecting a card, then saved values remain unchanged", () => {
  const board = { priorityPolicy: { evaluator: "job-fit-v1", assessmentFieldId: "source", priorityFieldId: "priority", fitFieldId: "fit", rules: [], bands: [{ optionId: "zero", minScore: 0 }] } } as unknown as Board
  const item = { values: { source: '{"decision":{"assessment":{}}}', priority: "saved", fit: 7 } } as unknown as Item
  expect(projectItemPriority(board, item)).toBe(item)
})
it("Given text formatting on a numeric field, when schema is validated, then configuration is rejected", () => {
  const result = validateBoardSchemaDraft({ boardId: "board", boardTitle: "Board", entityName: "item", columns: [{ title: "Queue" }], fields: [{ title: "Size", valueType: "number", required: false, format: "code" }] })
  expect(result.errors).toContainEqual({ path: "/fields/0/format", message: "Format is only supported for text fields" })
})
