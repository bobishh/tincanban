import { hasEntityKind } from "./model"
import type { Board, DocumentTemplate, LegacyWritingTemplate, WorkspaceDocumentV2 } from "./model"
import { compareRanks } from "./ancestry"
import { projectBoardSchema, validateBoardSchemaDraft, type BoardSchemaDraft, type SchemaValidationError } from "./schema"

type WorkspaceDocumentTemplateDraft = { id?: string; title: string; markdown: string }
export type WorkspaceSettingsDraft = { formatVersion: 1; workspace: { title: string }; board: BoardSchemaDraft; documentTemplates: WorkspaceDocumentTemplateDraft[] }
export type WorkspaceSettingsValidationResult = { valid: boolean; errors: SchemaValidationError[] }

export function projectWorkspaceSettings(doc: WorkspaceDocumentV2, boardId?: string): WorkspaceSettingsDraft {
  const board = boardId ? doc.entities[boardId] as Board | undefined : Object.values(doc.entities).find((entity): entity is Board => hasEntityKind(entity, "board") && !entity.archivedAt)
  if (!board || !hasEntityKind(board, "board")) throw new Error("Active board not found")
  const documentTemplates = Object.values(doc.entities)
    .filter((entity): entity is DocumentTemplate | LegacyWritingTemplate => (hasEntityKind(entity, "document_template") || hasEntityKind(entity, "template")) && !entity.archivedAt)
    .sort((a, b) => compareRanks(a.placement.rank, b.placement.rank))
    .map(template => ({ id: template.id, title: template.title, markdown: template.markdown }))
  return { formatVersion: 1, workspace: { title: doc.title }, board: projectBoardSchema(doc, board.id), documentTemplates }
}

export function validateWorkspaceSettingsDraft(draft: unknown, doc?: WorkspaceDocumentV2): WorkspaceSettingsValidationResult {
  if (!isRecord(draft)) return { valid: false, errors: [{ path: "", message: "Workspace settings must be a JSON object" }] }
  const errors: SchemaValidationError[] = []
  validateRoot(draft, errors)
  validateWorkspace(draft.workspace, errors)
  validateBoard(draft.board, doc, errors)
  validateTemplates(draft.documentTemplates, doc, errors)
  return { valid: errors.length === 0, errors }
}

function validateRoot(value: Record<string, unknown>, errors: SchemaValidationError[]): void {
  rejectUnknown(value, ["formatVersion", "workspace", "board", "documentTemplates"], "", errors)
  if (value.formatVersion !== 1) errors.push({ path: "/formatVersion", message: "formatVersion must be 1" })
}

function validateWorkspace(value: unknown, errors: SchemaValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: "/workspace", message: "workspace must be an object" })
    return
  }
  rejectUnknown(value, ["title"], "/workspace", errors)
  if (typeof value.title !== "string" || !value.title.trim()) errors.push({ path: "/workspace/title", message: "Workspace title is required" })
}

function validateBoard(value: unknown, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  const result = validateBoardSchemaDraft(value, doc)
  errors.push(...result.errors.map(error => ({ path: `/board${error.path}`, message: error.message })))
  if (!isRecord(value)) return
  rejectUnknown(value, ["boardId", "boardTitle", "entityName", "columns", "cardStageButtons", "fields", "automation", "cardPresentation", "priorityPolicy", "settings", "cardAgingPolicy"], "/board", errors)
  const boardId = value.boardId
  if (typeof boardId !== "string" || !boardId) {
    errors.push({ path: "/board/boardId", message: "boardId is required" })
    return
  }
  if (doc && !hasEntityKind(doc.entities[boardId], "board")) errors.push({ path: "/board/boardId", message: "boardId must identify this workspace board" })
  if (doc) validateBoardReferences(value, boardId, doc, errors)
}

function validateBoardReferences(value: Record<string, unknown>, boardId: string, doc: WorkspaceDocumentV2, errors: SchemaValidationError[]): void {
  validateEntityReferences(value.columns, "column", boardId, doc, errors, "columns")
  validateEntityReferences(value.fields, "field", boardId, doc, errors, "fields")
  if (!Array.isArray(value.fields)) return
  value.fields.forEach((field, index) => {
    if (!isRecord(field) || typeof field.id !== "string") return
    const entity = doc.entities[field.id]
    if (hasEntityKind(entity, "field") && field.valueType !== entity.valueType) errors.push({ path: `/board/fields/${index}/valueType`, message: "Field type cannot change" })
  })
}

function validateEntityReferences(values: unknown, kind: "column" | "field", boardId: string, doc: WorkspaceDocumentV2, errors: SchemaValidationError[], name: string): void {
  if (!Array.isArray(values)) return
  const ids = new Set<string>()
  values.forEach((value, index) => {
    if (!isRecord(value)) return
    rejectUnknown(value, kind === "column" ? ["id", "title", "archive", "collapsible", "color"] : ["id", "title", "valueType", "format", "required", "min", "max", "options"], `/board/${name}/${index}`, errors)
    if (typeof value.id !== "string") return
    if (ids.has(value.id)) errors.push({ path: `/board/${name}/${index}/id`, message: `${kind === "column" ? "Column" : "Field"} id is duplicated` })
    ids.add(value.id)
    const entity = doc.entities[value.id]
    const kindMatches = kind === "column" ? hasEntityKind(entity, "column") : hasEntityKind(entity, "field")
    if (!entity || !kindMatches || entity.placement.parentId !== boardId) errors.push({ path: `/board/${name}/${index}/id`, message: `id must identify a ${kind} on this board` })
  })
}

function validateTemplates(value: unknown, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "/documentTemplates", message: "documentTemplates must be an array" })
    return
  }
  const ids = new Set<string>()
  value.forEach((template, index) => validateTemplate(template, index, ids, doc, errors))
}

function validateTemplate(value: unknown, index: number, ids: Set<string>, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  const path = `/documentTemplates/${index}`
  if (!isRecord(value)) {
    errors.push({ path, message: "Document template must be an object" })
    return
  }
  rejectUnknown(value, ["id", "title", "markdown"], path, errors)
  if (value.id !== undefined && typeof value.id !== "string") errors.push({ path: `${path}/id`, message: "id must be a string" })
  if (typeof value.id === "string") validateTemplateId(value.id, path, ids, doc, errors)
  if (typeof value.title !== "string" || !value.title.trim()) errors.push({ path: `${path}/title`, message: "Template title is required" })
  if (typeof value.markdown !== "string") errors.push({ path: `${path}/markdown`, message: "Template markdown must be a string" })
}

function validateTemplateId(id: string, path: string, ids: Set<string>, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  if (ids.has(id)) errors.push({ path: `${path}/id`, message: "Template id is duplicated" })
  ids.add(id)
  const entity = doc?.entities[id]
  if (doc && (!entity || (!hasEntityKind(entity, "document_template") && !hasEntityKind(entity, "template")))) errors.push({ path: `${path}/id`, message: "id must identify a document template" })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  errors: SchemaValidationError[],
): void {
  Object.keys(value)
    .filter(key => !allowed.includes(key))
    .forEach(key => errors.push({ path: `${path}/${key}`, message: "Unknown setting" }))
}
