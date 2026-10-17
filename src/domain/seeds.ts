import { cloneJsonData } from "./jsonData"
import templateData from "../board-templates.json" with { type: "json" }
import type { Board, Column, FieldDefinition, WorkspaceDocumentV2, WorkspaceEntity } from "./model"
import type { BoardSchemaDraft } from "./schema"

export type Preset = string
export type BoardTemplate = { entityName: string; columns: ColumnSeed[]; fields: FieldSeed[]; automation?: Board["automation"]; cardPresentation?: Board["cardPresentation"] }
const templates = templateData as Record<Preset, BoardTemplate>
type SeedContext = { boardId: string; nowIso: string; entities: Record<string, WorkspaceEntity>; bindings: Record<string, string> }
type ColumnSeed = { key: string; title: string; archive?: true; collapsible?: boolean }
type FieldSeed = { key: string; title: string; valueType: FieldDefinition["valueType"]; required?: boolean; min?: number; max?: number; options?: Array<[string, string]> }

export type WorkspaceCreationDraft = BoardSchemaDraft & { presetBindings: Record<string, string> }

export function createWorkspaceDoc(id: string, title: string, ownerPersonId: string, presetKey: Preset, nowIso = new Date().toISOString(), configuration?: BoardTemplate): WorkspaceDocumentV2 {
  const boardId = crypto.randomUUID()
  const context: SeedContext = { boardId, nowIso, entities: {}, bindings: {} }
  const template = configuration ?? templates[presetKey]
  if (!template) throw new Error("Board configuration is required")
  seedColumns(context, template.columns)
  seedFields(context, template.fields)
  context.entities[boardId] = createBoard(boardId, title, presetKey, nowIso, context.bindings, template)
  return { kind: "workspace", formatVersion: 3, id, title, archivedAt: null, ownerPersonId, entities: context.entities, migration: null }
}

export function seedBoard(entities: Record<string, WorkspaceEntity>, title: string, presetKey: Preset, nowIso = new Date().toISOString(), configuration?: BoardTemplate): Board {
  const boardId = crypto.randomUUID()
  const context: SeedContext = { boardId, nowIso, entities, bindings: {} }
  const template = configuration ?? templates[presetKey]
  if (!template) throw new Error("Board configuration is required")
  seedColumns(context, template.columns)
  seedFields(context, template.fields)
  const board = createBoard(boardId, title, presetKey, nowIso, context.bindings, template)
  entities[boardId] = board
  return board
}

function createBoard(id: string, title: string, preset: Preset, nowIso: string, bindings: Record<string, string>, template: BoardTemplate): Board {
  const columns = template.columns
  const archiveColumnId = columns.find(column => column.archive)?.key
  const presentation = template.cardPresentation
  return { id, kind: "board", title, entityName: template.entityName,
    placement: { parentId: null, rank: "0/1" }, archivedAt: null, createdAt: nowIso, updatedAt: nowIso,
    preset: { key: preset, version: 1, bindings },
    ...(template.automation ? { automation: {
      types: cloneJsonData(template.automation.types),
      ...(template.automation.conditions ? { conditions: cloneJsonData(template.automation.conditions) } : {}),
      bindings: {
        columns: Object.fromEntries(Object.entries(template.automation.bindings.columns).map(([key, ref]) => [key, bindings[ref]])),
        fieldIds: Object.fromEntries(Object.entries(template.automation.bindings.fieldIds).map(([key, ref]) => [key, bindings[ref]])),
      },
    } } : {}),
    ...(presentation ? { cardPresentation: {
      ...(presentation.titleFieldIds ? { titleFieldIds: presentation.titleFieldIds.map(key => bindings[key]) } : {}),
      ...(presentation.summaryFieldIds ? { summaryFieldIds: presentation.summaryFieldIds.map(key => bindings[key]) } : {}),
      ...(presentation.narrativeFieldId ? { narrativeFieldId: bindings[presentation.narrativeFieldId] } : {}),
      ...(presentation.openAfterSave ? { openAfterSave: true } : {}),
    } } : {}),
    cardStageButtons: columns.map(column => ({ columnId: bindings[column.key] })),
    archiveColumnId: archiveColumnId ? bindings[archiveColumnId] : null }

}

function seedColumns(context: SeedContext, columns: ColumnSeed[]): void {
  columns.forEach((seed, index) => {
    const id = crypto.randomUUID()
    context.bindings[seed.key] = id
    const column: Column = { id, kind: "column", title: seed.title, placement: { parentId: context.boardId, rank: `${index}/1` }, archivedAt: null, createdAt: context.nowIso, updatedAt: context.nowIso }
    if (seed.collapsible !== undefined) column.collapsible = seed.collapsible
    context.entities[id] = column
  })
}

function seedFields(context: SeedContext, fields: FieldSeed[]): void {
  fields.forEach((seed, index) => {
    const id = crypto.randomUUID()
    context.bindings[seed.key] = id
    const base = { id, kind: "field" as const, title: seed.title, placement: { parentId: context.boardId, rank: `${index}/1` }, archivedAt: null, createdAt: context.nowIso, updatedAt: context.nowIso, required: seed.required ?? false }
    const field = seed.valueType === "number" ? { ...base, valueType: "number" as const, min: seed.min ?? null, max: seed.max ?? null }
      : seed.valueType === "select" ? { ...base, valueType: "select" as const, options: seedOptions(context, seed.options ?? []) }
        : { ...base, valueType: seed.valueType }
    context.entities[id] = field as FieldDefinition
  })
}

function seedOptions(context: SeedContext, options: Array<[string, string]>): Record<string, { id: string; title: string; rank: string; archivedAt: string | null }> {
  return Object.fromEntries(options.map(([key, title], index) => {
    const id = crypto.randomUUID()
    context.bindings[key] = id
    return [id, { id, title, rank: `${index}/1`, archivedAt: null }]
  }))
}

