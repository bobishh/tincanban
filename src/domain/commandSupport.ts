import { hasEntityKind } from "./model"
import type { WorkspaceDocumentV2, WorkspaceEntity, Column, FieldDefinition, Board, DocumentTemplate, LegacyWritingTemplate } from "./model"
import { isItem } from "./model"
import { calculateRankBetween, getChildren, renumberSiblings } from "./ancestry"
import type { BoardSchemaDraft } from "./schema"

export function findRootBoardId(entities: Record<string, WorkspaceEntity>, entityId: string): string | null {
  const visited = new Set<string>()
  let current: WorkspaceEntity | undefined = entities[entityId]
  while (current) {
    if (visited.has(current.id)) return null
    visited.add(current.id)
    if (!isItem(current) && hasEntityKind(current, "board")) return current.id
    if (current.placement.parentId === null) return null
    current = entities[current.placement.parentId]
  }
  return null
}

export function computeInsertionRank(entities: Record<string, WorkspaceEntity>, parentId: string | null, beforeId?: string | null): { rank: string; renumbered?: Record<string, string> } {
  const siblings = getChildren(entities, parentId).filter(entity => entity.kind !== "application_source")
  if (!siblings.length) return { rank: "0/1" }
  if (!beforeId) return { rank: calculateRankBetween(siblings.at(-1)?.placement.rank ?? null, null) }
  const targetIndex = siblings.findIndex(sibling => sibling.id === beforeId)
  if (targetIndex < 0) return { rank: calculateRankBetween(siblings.at(-1)?.placement.rank ?? null, null) }
  if (!targetIndex) return { rank: calculateRankBetween(null, siblings[0].placement.rank) }
  return rankBeforeTarget(siblings, targetIndex)
}

function rankBeforeTarget(siblings: WorkspaceEntity[], targetIndex: number): { rank: string; renumbered?: Record<string, string> } {
  const previous = siblings[targetIndex - 1]
  const target = siblings[targetIndex]
  if (previous.placement.rank !== target.placement.rank) return { rank: calculateRankBetween(previous.placement.rank, target.placement.rank) }
  const renumbered = Object.fromEntries(renumberSiblings(siblings).map(entity => [entity.id, entity.placement.rank]))
  return { rank: calculateRankBetween(`${targetIndex - 1}/1`, `${targetIndex}/1`), renumbered }
}

export function applyRenumbering(draft: WorkspaceDocumentV2, renumbered?: Record<string, string>) {
  for (const [id, rank] of Object.entries(renumbered ?? {})) {
    const entity = draft.entities[id]
    if (entity) entity.placement = { ...entity.placement, rank }
  }
}

export function applyBoardSchemaSettings(draft: WorkspaceDocumentV2, boardId: string, schema: BoardSchemaDraft, nowIso: string, changedIds: string[]) {
  const board = draft.entities[boardId] as Board
  board.title = schema.boardTitle.trim()
  board.entityName = schema.entityName.trim()
  if (schema.cardStageButtons) board.cardStageButtons = schema.cardStageButtons.map(button => ({ columnId: button.columnId, ...(button.label ? { label: button.label.trim() } : {}) }))
  if (schema.employee_profile) board.employee_profile = { ...schema.employee_profile }
  if (schema.priorityPolicy) board.priorityPolicy = JSON.parse(JSON.stringify(schema.priorityPolicy))
  else delete board.priorityPolicy
  board.cardAgingPolicy = JSON.parse(JSON.stringify(schema.cardAgingPolicy ?? { version: 1, thresholds: { watch: 7, aged: 14, overdue: 30 } }))
  board.updatedAt = nowIso
  changedIds.push(boardId)
  applyColumns(draft, boardId, schema, nowIso, changedIds)
  applyFields(draft, boardId, schema, nowIso, changedIds)
}

function applyColumns(draft: WorkspaceDocumentV2, boardId: string, schema: BoardSchemaDraft, nowIso: string, changedIds: string[]) {
  const board = draft.entities[boardId] as Board
  const existing = Object.values(draft.entities).filter((entity): entity is Column => hasEntityKind(entity, "column") && entity.placement.parentId === boardId)
  const ids = new Set<string>()
  let archiveColumnId: string | null = null
  schema.columns.forEach((column, index) => {
    const id = column.id || `col-${crypto.randomUUID()}`
    ids.add(id)
    if (column.archive === true) archiveColumnId = id
    const collapsible = column.collapsible
    const target = draft.entities[id]
    if (hasEntityKind(target, "column")) updateColumn(target, column.title, collapsible, index, nowIso)
    else draft.entities[id] = createColumn(id, boardId, column.title, collapsible, index, nowIso)
    const updated = draft.entities[id] as Column
    if (column.color === undefined) delete updated.color
    else updated.color = column.color
    changedIds.push(id)
  })
  board.archiveColumnId = archiveColumnId
  markRemoved(existing, ids, nowIso, changedIds)
}

function updateColumn(column: Column, title: string, collapsible: boolean | undefined, index: number, nowIso: string) {
  column.title = title.trim()
  delete column.archive
  if (collapsible === undefined) delete column.collapsible
  else column.collapsible = collapsible
  column.placement = { parentId: column.placement.parentId, rank: `${index}/1` }
  column.archivedAt = null
  column.updatedAt = nowIso
}

function createColumn(id: string, boardId: string, title: string, collapsible: boolean | undefined, index: number, nowIso: string): Column {
  const column: Column = { id, kind: "column", title: title.trim(), placement: { parentId: boardId, rank: `${index}/1` }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso }
  if (collapsible !== undefined) column.collapsible = collapsible
  return column
}

function applyFields(draft: WorkspaceDocumentV2, boardId: string, schema: BoardSchemaDraft, nowIso: string, changedIds: string[]) {
  const existing = Object.values(draft.entities).filter((entity): entity is FieldDefinition => hasEntityKind(entity, "field") && entity.placement.parentId === boardId)
  const ids = new Set<string>()
  schema.fields.forEach((field, index) => {
    const id = field.id || `field-${crypto.randomUUID()}`
    ids.add(id)
    const target = fieldTarget(draft, id, boardId, field, index, nowIso)
    applyFieldConstraints(target, field, nowIso)
    changedIds.push(id)
  })
  markRemoved(existing, ids, nowIso, changedIds)
}

function fieldTarget(draft: WorkspaceDocumentV2, id: string, boardId: string, field: BoardSchemaDraft["fields"][number], index: number, nowIso: string): FieldDefinition {
  const existing = draft.entities[id]
  if (hasEntityKind(existing, "field")) {
    if (existing.valueType !== field.valueType) throw new Error("Field type cannot change")
    existing.title = field.title.trim()
    existing.required = field.required
    existing.placement = { parentId: boardId, rank: `${index}/1` }
    existing.archivedAt = null
    existing.updatedAt = nowIso
    return existing
  }
  const created = createFieldDefinition(id, boardId, field, index, nowIso)
  draft.entities[id] = created
  const saved = draft.entities[id]
  if (!saved || !hasEntityKind(saved, "field")) throw new Error("Failed to create field")
  return saved
}

function createFieldDefinition(
  id: string,
  boardId: string,
  field: BoardSchemaDraft["fields"][number],
  index: number,
  nowIso: string,
): FieldDefinition {
  const base = {
    id,
    kind: "field" as const,
    title: field.title.trim(),
    required: field.required,
    placement: { parentId: boardId, rank: `${index}/1` },
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  if (field.valueType === "number") {
    return { ...base, valueType: "number", min: field.min ?? null, max: field.max ?? null }
  }
  if (field.valueType === "select") return { ...base, valueType: "select", options: {} }
  return { ...base, valueType: field.valueType }
}

function applyFieldConstraints(target: FieldDefinition, field: BoardSchemaDraft["fields"][number], nowIso: string) {
  if (target.valueType === "number" && field.valueType === "number") {
    target.min = field.min ?? null
    target.max = field.max ?? null
    return
  }
  if (target.valueType === "select" && field.valueType === "select") {
    const optionIds = new Set<string>()
    ;(field.options ?? []).forEach((option, index) => {
      const id = option.id || `opt-${crypto.randomUUID()}`
      optionIds.add(id)
      target.options[id] = { id, title: option.title.trim(), rank: `${index}/1`, archivedAt: null }
    })
    Object.entries(target.options).forEach(([id, option]) => { if (!optionIds.has(id)) option.archivedAt = nowIso })
    return
  }
}

function markRemoved(entities: Array<Column | FieldDefinition | DocumentTemplate | LegacyWritingTemplate>, ids: Set<string>, nowIso: string, changedIds: string[]) {
  entities.forEach(entity => {
    if (!ids.has(entity.id) && !entity.archivedAt) {
      entity.archivedAt = nowIso
      entity.updatedAt = nowIso
      changedIds.push(entity.id)
    }
  })
}

export function applyDocumentTemplates(draft: WorkspaceDocumentV2, templates: Array<{ id?: string; title: string; markdown: string }>, nowIso: string, changedIds: string[]) {
  const existing = Object.values(draft.entities).filter((entity): entity is DocumentTemplate | LegacyWritingTemplate => hasEntityKind(entity, "document_template") || hasEntityKind(entity, "template"))
  const ids = new Set<string>()
  templates.forEach((template, index) => {
    const id = template.id || `template-${crypto.randomUUID()}`
    ids.add(id)
    const entity = draft.entities[id]
    if (entity && (hasEntityKind(entity, "document_template") || hasEntityKind(entity, "template"))) {
      entity.title = template.title.trim(); entity.markdown = template.markdown; entity.placement = { parentId: null, rank: `${index + 1}/1` }; entity.archivedAt = null; entity.updatedAt = nowIso
    } else draft.entities[id] = { id, kind: "document_template", title: template.title.trim(), markdown: template.markdown, placement: { parentId: null, rank: `${index + 1}/1` }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso }
    changedIds.push(id)
  })
  markRemoved(existing, ids, nowIso, changedIds)
}
