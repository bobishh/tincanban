import { textFormatSchema } from "./entitySchemas"
import { hasEntityKind } from "./model"
import type { AttachedDocument, Column, DocumentTemplate, FieldDefinition, WorkspaceDocumentV2 } from "./model"
import { compareRanks, calculateRankBetween } from "./ancestry"
import { patchFieldDefinition } from "./fields"
import { err } from "./commandTypes"
import type { CommandByKind, CommandContext, CommandHandler } from "./commandHandlerTypes"
import { applyRenumbering, computeInsertionRank } from "./commandSupport"
import { isArchiveColumn } from "./archive"
import { cardStageButtons } from "./cardStageButtons"

export const createColumn: CommandHandler<"createColumn"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Column title cannot be empty", "title")
  const board = doc.entities[command.boardId]
  if (!board || !hasEntityKind(board, "board")) return err("not_found", `Board ${command.boardId} not found`)
  const hasArchiveColumn = board.archiveColumnId !== undefined
    ? board.archiveColumnId !== null
    : Object.values(doc.entities).some(entity => hasEntityKind(entity, "column") && !entity.archivedAt && entity.placement.parentId === command.boardId && isArchiveColumn(entity))
  if (command.archive && hasArchiveColumn) return err("invalid_input", "Only one archive column is allowed", "archive")
  const id = crypto.randomUUID()
  const insertion = computeInsertionRank(doc.entities, command.boardId, command.beforeId)
  const existingColumns = Object.values(doc.entities).filter((entity): entity is Column => hasEntityKind(entity, "column") && entity.placement.parentId === command.boardId && !entity.archivedAt).sort((a, b) => compareRanks(a.placement.rank, b.placement.rank))
  const buttons = cardStageButtons(board, existingColumns)
  return { ok: true, value: { changedEntityIds: [id, command.boardId], apply: draft => {
    applyRenumbering(draft, insertion.renumbered)
    draft.entities[id] = { id, kind: "column", title: command.title.trim(), placement: { parentId: command.boardId, rank: insertion.rank }, archivedAt: null, ...(command.collapsible !== undefined ? { collapsible: command.collapsible } : {}), createdAt: context.nowIso, updatedAt: context.nowIso }
    const targetBoard = draft.entities[command.boardId]
    if (hasEntityKind(targetBoard, "board")) {
      targetBoard.cardStageButtons = [...buttons, { columnId: id }]
      if (command.archive) targetBoard.archiveColumnId = id
    }
  } } }
}

export const createField: CommandHandler<"createField"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Field title cannot be empty", "title")
  const valueType = command.valueType
  if (!isSupportedFieldType(valueType)) return err("invalid_input", "Field type is invalid", "valueType")
  if (command.format !== undefined && (command.valueType !== "text" || !textFormatSchema.safeParse(command.format).success)) return err("invalid_input", "Invalid text field format", "format")
  const board = doc.entities[command.boardId]
  if (!board || !hasEntityKind(board, "board")) return err("not_found", `Board ${command.boardId} not found`)
  const id = crypto.randomUUID()
  const rank = computeInsertionRank(doc.entities, command.boardId).rank
  return { ok: true, value: { changedEntityIds: [id], apply: draft => { draft.entities[id] = fieldEntity(command, valueType, id, rank, context.nowIso) } } }
}

function fieldEntity(command: CommandByKind<"createField">, valueType: FieldDefinition["valueType"], id: string, rank: string, nowIso: string): FieldDefinition {
  const base = { id, kind: "field" as const, title: command.title.trim(), placement: { parentId: command.boardId, rank }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso, required: command.required }
  if (valueType === "select") return { ...base, valueType, options: fieldOptions(command) }
  if (valueType === "number") return { ...base, valueType, min: command.min ?? null, max: command.max ?? null }
  return { ...base, valueType, ...(valueType === "text" && command.format ? { format: command.format } : {}) }
}

function isSupportedFieldType(
  valueType: string,
): valueType is FieldDefinition["valueType"] {
  return ["text", "url", "date", "datetime", "boolean", "number", "select"].includes(valueType)
}

function fieldOptions(command: CommandByKind<"createField">) {
  return Object.fromEntries(Object.values(command.options ?? {}).map((option, index) => {
    const id = crypto.randomUUID()
    return [id, { id, title: option.title, rank: `${index}/1`, archivedAt: null }]
  }))
}

function itemChildInsertion(doc: WorkspaceDocumentV2, itemId: string) {
  const item = doc.entities[itemId]
  if (!item || !Object.hasOwn(item, "values")) return undefined
  return computeInsertionRank(doc.entities, itemId)
}

function createItemChildResult(
  id: string,
  insertion: ReturnType<typeof computeInsertionRank>,
  context: CommandContext,
  write: (draft: WorkspaceDocumentV2) => void,
) {
  return {
    ok: true as const,
    value: {
      changedEntityIds: [id],
      apply: (draft: WorkspaceDocumentV2) => {
        applyRenumbering(draft, insertion.renumbered)
        write(draft)
      },
    },
  }
}

export const patchField: CommandHandler<"patchField"> = (doc, command) => {
  const field = doc.entities[command.fieldId]
  if (!field || !hasEntityKind(field, "field")) return err("not_found", `Field ${command.fieldId} not found`)
  const patched = patchFieldDefinition(field, command)
  if (!patched.ok) return patched
  return { ok: true, value: { changedEntityIds: [command.fieldId], apply: draft => { draft.entities[command.fieldId] = patched.value } } }
}

export const createTemplate: CommandHandler<"createTemplate"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Template title is required", "title")
  const id = command.id ?? crypto.randomUUID()
  const insertion = computeInsertionRank(doc.entities, null)
  return { ok: true, value: { changedEntityIds: [id], apply: draft => {
    applyRenumbering(draft, insertion.renumbered)
    draft.entities[id] = { id, kind: "document_template", title: command.title.trim(), markdown: command.markdown, placement: { parentId: null, rank: insertion.rank }, archivedAt: null, createdAt: context.nowIso, updatedAt: context.nowIso }
  } } }
}

export const patchTemplate: CommandHandler<"patchTemplate"> = (doc, command, context) => {
  const template = doc.entities[command.templateId]
  if (!template || (!hasEntityKind(template, "document_template") && !hasEntityKind(template, "template"))) return err("not_found", `Document template ${command.templateId} not found`)
  return { ok: true, value: { changedEntityIds: [command.templateId], apply: draft => {
    const target = draft.entities[command.templateId] as DocumentTemplate
    if (command.title !== undefined) target.title = command.title.trim()
    if (command.markdown !== undefined) target.markdown = command.markdown
    target.updatedAt = context.nowIso
  } } }
}

export const addDocument: CommandHandler<"addDocument"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Document title is required", "title")
  const insertion = itemChildInsertion(doc, command.itemId)
  if (!insertion) return err("not_found", `Item ${command.itemId} not found`)
  const id = command.id ?? crypto.randomUUID()
  return createItemChildResult(id, insertion, context, draft => {
    draft.entities[id] = {
      id,
      kind: "document",
      title: command.title.trim(),
      documentKind: command.documentKind,
      format: command.format,
      content: command.content ?? null,
      file: command.file ?? (command.localPath
        ? { type: "local-file", fileId: crypto.randomUUID(), fileName: command.localPath }
        : null),
      placement: { parentId: command.itemId, rank: insertion.rank },
      archivedAt: null,
      createdAt: context.nowIso,
      updatedAt: context.nowIso,
    }
  })
}

export const patchDocument: CommandHandler<"patchDocument"> = (doc, command, context) => {
  if (!hasEntityKind(doc.entities[command.documentId], "document")) return err("not_found", `Document ${command.documentId} not found`)
  return { ok: true, value: { changedEntityIds: [command.documentId], apply: draft => {
    const target = draft.entities[command.documentId] as AttachedDocument
    if (command.title !== undefined) target.title = command.title.trim()
    if (command.content !== undefined) target.content = command.content
    target.updatedAt = context.nowIso
  } } }
}

export const recordArtifact: CommandHandler<"recordArtifact"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Artifact title is required", "title")
  const insertion = itemChildInsertion(doc, command.itemId)
  if (!insertion) return err("not_found", `Item ${command.itemId} not found`)
  const id = command.id ?? crypto.randomUUID()
  return createItemChildResult(id, insertion, context, draft => {
    draft.entities[id] = {
      id,
      kind: "artifact",
      title: command.title.trim(),
      artifactKind: command.artifactKind,
      templateId: command.templateId,
      pdf: command.pdf,
      sourceMarkdown: command.sourceMarkdown ?? null,
      placement: { parentId: command.itemId, rank: insertion.rank },
      archivedAt: null,
      createdAt: context.nowIso,
      updatedAt: context.nowIso,
    }
  })
}

export const createFieldOption: CommandHandler<"createFieldOption"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Option title is required", "title")
  const field = doc.entities[command.fieldId]
  if (!field || !hasEntityKind(field, "field")) return err("not_found", `Field ${command.fieldId} not found`)
  if (field.valueType !== "select") return err("invalid_input", `Field ${command.fieldId} is not a select field`)
  const id = crypto.randomUUID()
  const rank = optionRank(field, command.beforeId)
  return { ok: true, value: { changedEntityIds: [command.fieldId], apply: draft => {
    const target = draft.entities[command.fieldId] as Extract<FieldDefinition, { valueType: "select" }>
    target.options ??= {}
    target.options[id] = { id, title: command.title.trim(), rank, archivedAt: null }
    target.updatedAt = context.nowIso
  } } }
}

function optionRank(field: Extract<FieldDefinition, { valueType: "select" }>, beforeId?: string | null): string {
  const options = Object.values(field.options ?? {}).filter(option => !option.archivedAt).sort((left, right) => compareRanks(left.rank, right.rank))
  const index = beforeId ? options.findIndex(option => option.id === beforeId) : -1
  if (index === 0) return calculateRankBetween(null, options[0].rank)
  if (index > 0) return calculateRankBetween(options[index - 1].rank, options[index].rank)
  return options.length ? calculateRankBetween(options.at(-1)?.rank ?? null, null) : "0/1"
}

export const patchFieldOption: CommandHandler<"patchFieldOption"> = (doc, command, context) => {
  const field = doc.entities[command.fieldId]
  if (!field || !hasEntityKind(field, "field")) return err("not_found", `Field ${command.fieldId} not found`)
  if (field.valueType !== "select") return err("invalid_input", `Field ${command.fieldId} is not a select field`)
  if (!field.options?.[command.optionId]) return err("not_found", `Option ${command.optionId} not found`)
  return { ok: true, value: { changedEntityIds: [command.fieldId], apply: draft => {
    const target = draft.entities[command.fieldId] as Extract<FieldDefinition, { valueType: "select" }>
    const option = target.options[command.optionId]
    if (command.title !== undefined) option.title = command.title.trim()
    if (command.archived !== undefined) option.archivedAt = command.archived ? context.nowIso : null
    target.updatedAt = context.nowIso
  } } }
}
