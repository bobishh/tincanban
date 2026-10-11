import type { Board, Column, FieldDefinition, WorkspaceDocumentV2, WorkspaceEntity } from "./model"
import type { WorkspaceCreationDraft } from "./seeds"

export function createWorkspaceDocFromDraft(id: string, title: string, ownerPersonId: string, presetKey: "job-search" | "blank", draft: WorkspaceCreationDraft, nowIso = new Date().toISOString()): WorkspaceDocumentV2 {
  const boardId = draft.boardId
  const entities: Record<string, WorkspaceEntity> = {}
  const columns = draft.columns.map((definition, index): Column => ({
    id: definition.id ?? crypto.randomUUID(), kind: "column", title: definition.title.trim(),
    placement: { parentId: boardId, rank: `${index}/1` }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso,
    ...(definition.collapsible !== undefined ? { collapsible: definition.collapsible } : {}),
  }))
  columns.forEach(column => { entities[column.id] = column })
  const fields = draft.fields.map((definition, index): FieldDefinition => {
    const common = {
      id: definition.id ?? crypto.randomUUID(), kind: "field" as const, title: definition.title.trim(),
      placement: { parentId: boardId, rank: `${index}/1` }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso,
      required: definition.required,
    }
    if (definition.valueType === "number") return { ...common, valueType: "number", min: definition.min ?? null, max: definition.max ?? null }
    if (definition.valueType === "select") return {
      ...common, valueType: "select",
      options: Object.fromEntries((definition.options ?? []).map((option, optionIndex) => {
        const optionId = option.id ?? crypto.randomUUID()
        return [optionId, { id: optionId, title: option.title.trim(), rank: `${optionIndex}/1`, archivedAt: null }]
      })),
    }
    return { ...common, valueType: definition.valueType }
  })
  fields.forEach(field => { entities[field.id] = field })
  const retainedIds = new Set([...columns.map(column => column.id), ...fields.flatMap(field => [field.id, ...(field.valueType === "select" ? Object.keys(field.options) : [])])])
  const bindings = Object.fromEntries(Object.entries(draft.presetBindings).filter(([, value]) => retainedIds.has(value)))
  const board: Board = {
    id: boardId, kind: "board", title: title.trim(), entityName: draft.entityName.trim(),
    placement: { parentId: null, rank: "0/1" }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso,
    preset: { key: presetKey, version: 1, bindings },
    cardStageButtons: columns.filter((_, index) => !draft.columns[index]?.archive).map(column => ({ columnId: column.id })),
    archiveColumnId: columns.find((_, index) => draft.columns[index]?.archive)?.id ?? null,
    priorityPolicy: null,
    cardAgingPolicy: draft.cardAgingPolicy ?? { version: 1, thresholds: { watch: 7, aged: 14, overdue: 30 } },
  }
  if (draft.employee_profile) board.employee_profile = { ...draft.employee_profile }
  if (draft.priorityPolicy) board.priorityPolicy = draft.priorityPolicy
  entities[boardId] = board
  return { kind: "workspace", formatVersion: 3, id, title: title.trim(), archivedAt: null, ownerPersonId, entities, migration: null }
}
