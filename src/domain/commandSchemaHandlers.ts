import type { CommandHandler } from "./commandHandlerTypes"
import { hasEntityKind } from "./model"
import { err } from "./commandTypes"
import { validateBoardSchemaDraft } from "./schema"
import { validateWorkspaceSettingsDraft } from "./workspaceSettings"
import { applyBoardSchemaSettings, applyDocumentTemplates } from "./commandSupport"
import { validPublicBoardOrigin } from "../public/publicBoardLink"

export const setBoardPublicationOrigin: CommandHandler<"setBoardPublicationOrigin"> = (doc, command, context) => {
  const board = doc.entities[command.boardId]
  if (!board || !hasEntityKind(board, "board")) return err("not_found", `Board ${command.boardId} not found`)
  if (!validPublicBoardOrigin(command.origin)) return err("invalid_input", "A publication server needs a secure Rusty address")
  return { ok: true, value: { changedEntityIds: [board.id], apply: draft => {
    const target = draft.entities[board.id]
    if (!target || !hasEntityKind(target, "board")) throw new Error("Publication board is no longer available")
    target.publicationOrigin = command.origin
    target.updatedAt = context.nowIso
  } } }
}

export const updateBoardSchema: CommandHandler<"updateBoardSchema"> = (doc, command, context) => {
  const board = doc.entities[command.boardId]
  if (!board || !hasEntityKind(board, "board")) return err("not_found", `Board ${command.boardId} not found`)
  if (command.schema.boardId !== board.id) return err("invalid_input", "Schema draft belongs to another board")
  if (!headsMatch(context.beforeHeads, command.expectedHeads)) return err("conflict", "Concurrent edits arrived while schema draft was open")
  const retainedColumns = new Set(Array.isArray(command.schema.columns) ? command.schema.columns.flatMap(column => column?.id ? [column.id] : []) : [])
  const buttons = command.schema.cardStageButtons
  const schema = { ...command.schema, cardStageButtons: Array.isArray(buttons) ? buttons.filter(button => !button || retainedColumns.has(button.columnId) || !hasEntityKind(doc.entities[button.columnId], "column")) : buttons }
  const validation = validateBoardSchemaDraft(schema, doc)
  if (!validation.valid) return validationError(validation.errors)
  const changedEntityIds = [command.boardId]
  return { ok: true, value: { changedEntityIds, apply: draft => applyBoardSchemaSettings(draft, command.boardId, schema, context.nowIso, changedEntityIds) } }
}

export const updateWorkspaceSettings: CommandHandler<"updateWorkspaceSettings"> = (doc, command, context) => {
  const validation = validateWorkspaceSettingsDraft(command.settings, doc)
  if (!validation.valid) return validationError(validation.errors)
  if (!headsMatch(context.beforeHeads, command.expectedHeads)) return err("conflict", "Concurrent edits arrived while workspace settings were open")
  const changedEntityIds: string[] = []
  return { ok: true, value: { changedEntityIds, apply: draft => {
    draft.title = command.settings.workspace.title.trim()
    applyBoardSchemaSettings(draft, command.settings.board.boardId, command.settings.board, context.nowIso, changedEntityIds)
    applyDocumentTemplates(draft, command.settings.documentTemplates, context.nowIso, changedEntityIds)
  } } }
}

function headsMatch(actual: string[], expected?: string[]): boolean {
  if (!expected?.length) return true
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((head, index) => head === sorted[index])
}

function validationError(errors: Array<{ message: string; path: string }>) {
  const error = errors[0]
  return {
    ok: false as const,
    error: { code: "invalid_input" as const, message: error.message, field: error.path },
  }
}
