import { emptyEmployeeProfile } from "./jobPriority"
import type { Board, CardAgingPolicy, Column, FieldDefinition, PriorityPolicy, WorkspaceDocumentV2 } from "./model"
import { getAncestryPath, getChildren, compareRanks } from "./ancestry"
import { isArchiveColumn } from "./archive"
import { isItemArchived } from "./archive"
import { cardAgingPolicySchema, employeeProfileSchema, priorityPolicySchema } from "./entitySchemas"
import { validatePriorityPolicy } from "./priority"
import { entityKind, hasEntityKind, isItem } from "./model"
import { cardStageButtons, type CardStageButton } from "./cardStageButtons"

type BoardSchemaColumn = { id?: string; title: string; color?: string; archive?: true; collapsible?: boolean }
type BoardSchemaSelectOption = { id?: string; title: string }
type BoardSchemaField = { id?: string; title: string; valueType: "text" | "number" | "boolean" | "select" | "url" | "date" | "datetime"; required: boolean; min?: number | null; max?: number | null; options?: BoardSchemaSelectOption[] }
export type BoardSchemaDraft = { boardId: string; boardTitle: string; entityName: string; columns: BoardSchemaColumn[]; fields: BoardSchemaField[]; cardStageButtons?: CardStageButton[]; priorityPolicy?: PriorityPolicy | null; employee_profile?: Board["employee_profile"]; cardAgingPolicy?: CardAgingPolicy }
export type SchemaValidationError = { path: string; message: string }
export type SchemaValidationResult = { valid: boolean; errors: SchemaValidationError[] }
export type SchemaDiff = {
  cardAgingChange?: { before: string; after: string }
  columnsRenamed: Array<{ id: string; oldTitle: string; newTitle: string }>; columnsReordered: boolean; columnsAdded: Array<{ title: string }>; columnsArchived: Array<{ id: string; title: string; retainedItemCount: number }>
  fieldsAdded: Array<{ title: string; valueType: string }>; fieldsModified: Array<{ id: string; title: string; changes: string[] }>; fieldsArchived: Array<{ id: string; title: string }>
  optionsAdded: Array<{ fieldId: string; title: string }>; optionsModified: Array<{ fieldId: string; optionId: string; oldTitle: string; newTitle: string }>; optionsArchived: Array<{ fieldId: string; optionId: string; title: string }>
}

export function projectBoardSchema(doc: WorkspaceDocumentV2, boardId: string): BoardSchemaDraft {
  const board = doc.entities[boardId] as Board | undefined
  const columns = childEntities<Column>(doc, boardId, "column").map(column => ({ id: column.id, title: column.title, ...(column.color ? { color: column.color } : {}), ...(isArchiveColumn(column, board) ? { archive: true as const } : {}), ...(column.collapsible !== undefined ? { collapsible: column.collapsible } : {}) }))
  const fields = childEntities<FieldDefinition>(doc, boardId, "field").map(projectField)
  return {
    boardId,
    boardTitle: board?.title || "Board",
    entityName: board?.entityName || (board?.preset?.key === "job-search" ? "lead" : "item"),
    columns,
    cardStageButtons: cardStageButtons(board, childEntities<Column>(doc, boardId, "column")),
    fields,
    employee_profile: { ...(board?.employee_profile ?? emptyEmployeeProfile()) },
    priorityPolicy: board?.priorityPolicy
      ? { ...JSON.parse(JSON.stringify(board.priorityPolicy)), sort: board.priorityPolicy.sort ?? "fit_desc" }
      : null,
    cardAgingPolicy: board?.cardAgingPolicy ?? { version: 1, thresholds: { watch: 7, aged: 14, overdue: 30 } },
  }
}

function childEntities<T extends Column | FieldDefinition>(doc: WorkspaceDocumentV2, parentId: string, kind: T["kind"]): T[] {
  return getChildren(doc.entities, parentId).filter(entity => entityKind(entity) === kind && !entity.archivedAt).sort((a, b) => compareRanks(a.placement.rank, b.placement.rank)) as T[]
}
function projectField(field: FieldDefinition): BoardSchemaField {
  const result: BoardSchemaField = { id: field.id, title: field.title, valueType: field.valueType, required: field.required }
  if (field.valueType === "number") Object.assign(result, { min: field.min, max: field.max })
  if (field.valueType === "select") result.options = Object.values(field.options).filter(option => !option.archivedAt).sort((a, b) => compareRanks(a.rank, b.rank)).map(option => ({ id: option.id, title: option.title }))
  return result
}

const valueTypes = new Set(["text", "number", "boolean", "select", "url", "date", "datetime"])
export function validateBoardSchemaDraft(draft: unknown, doc?: WorkspaceDocumentV2): SchemaValidationResult {
  if (!record(draft)) return { valid: false, errors: [{ path: "", message: "Schema draft must be a valid JSON object" }] }
  const errors: SchemaValidationError[] = []
  requiredText(draft.boardTitle, "/boardTitle", "Board title is required", errors)
  requiredText(draft.entityName, "/entityName", "Entity name is required", errors)
  if (draft.employee_profile !== undefined) {
    const parsed = employeeProfileSchema.safeParse(draft.employee_profile)
    if (!parsed.success) errors.push(...parsed.error.issues.map(issue => ({ path: `/employee_profile/${issue.path.join("/")}`, message: issue.message })))
  }
  validateColumns(draft.columns, errors)
  validateArchiveRoleRemoval(draft, doc, errors)
  validateArchiveColumnContents(draft.columns, doc, errors)
  validateCardStageButtons(draft.cardStageButtons, draft.columns, errors); validateFields(draft.fields, errors); validatePolicy(draft, doc, errors); validateAgingPolicy(draft, errors)
  return { valid: errors.length === 0, errors }
}

function validateArchiveRoleRemoval(draft: Record<string, unknown>, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  if (!doc || !Array.isArray(draft.columns) || draft.columns.some(entry => record(entry) && entry.archive === true)) return
  const boardId = draft.boardId
  if (typeof boardId !== "string") return
  const hasArchivedItems = Object.values(doc.entities).some(entity => isItem(entity) && isItemArchived(entity) && getAncestryPath(doc.entities, entity.id).path.includes(boardId))
  if (hasArchivedItems) errors.push({ path: "/columns", message: "Archive role cannot be removed while archived items exist" })
}

function validateArchiveColumnContents(columns: unknown, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  if (!doc || !Array.isArray(columns)) return
  const index = columns.findIndex(entry => record(entry) && entry.archive === true)
  const entry: unknown = columns[index]
  if (index < 0 || !record(entry) || typeof entry.id !== "string") return
  const column = doc.entities[entry.id]
  if (!hasEntityKind(column, "column")) return
  const boardId = column.placement.parentId
  if (!boardId) return
  const board = doc.entities[boardId]
  if (hasEntityKind(board, "board") && isArchiveColumn(column, board)) return
  const hasActiveItems = Object.values(doc.entities).some(entity => isItem(entity) && !isItemArchived(entity) && getAncestryPath(doc.entities, entity.id).path.includes(column.id))
  if (hasActiveItems) errors.push({ path: `/columns/${index}/archive`, message: "Archive role cannot hide active items" })
}
function validateAgingPolicy(draft: Record<string, unknown>, errors: SchemaValidationError[]): void {
  if (draft.cardAgingPolicy === undefined) return
  const parsed = cardAgingPolicySchema.safeParse(draft.cardAgingPolicy)
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(issue => ({ path: `/cardAgingPolicy/${issue.path.join("/")}`.replace(/\/$/, ""), message: issue.message })))
    return
  }
}
function validateColumns(value: unknown, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "/columns", message: "Columns must be an array" })
    return
  }
  let archive = false
  value.forEach((entry, index) => { archive = validateColumn(entry, index, archive, errors) })
}
function validateColumn(value: unknown, index: number, archive: boolean, errors: SchemaValidationError[]): boolean {
  const path = `/columns/${index}`
  if (!record(value)) { errors.push({ path, message: "Column definition must be an object" }); return archive }
  Object.keys(value).filter(key => !["id", "title", "archive", "collapsible", "color"].includes(key)).forEach(key => errors.push({ path: `${path}/${key}`, message: "Unknown column setting" }))
  requiredText(value.title, `${path}/title`, "Column title is required", errors)
  if (value.color !== undefined && (typeof value.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.color))) errors.push({ path: `${path}/color`, message: "Color must be a six-digit hex value" })
  if (value.archive !== undefined && value.archive !== true) errors.push({ path: `${path}/archive`, message: "archive must be true when present" })
  if (value.collapsible !== undefined && typeof value.collapsible !== "boolean") errors.push({ path: `${path}/collapsible`, message: "collapsible must be boolean" })
  if (archive && value.archive === true) errors.push({ path: `${path}/archive`, message: "Only one archive column is allowed" })
  return archive || value.archive === true
}
function validateCardStageButtons(value: unknown, columns: unknown, errors: SchemaValidationError[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) { errors.push({ path: "/cardStageButtons", message: "Card stage buttons must be an array" }); return }
  const columnIds = new Set(Array.isArray(columns) ? columns.flatMap(column => record(column) && typeof column.id === "string" ? [column.id] : []) : [])
  const used = new Set<string>()
  value.forEach((button, index) => {
    const path = `/cardStageButtons/${index}`
    if (!record(button)) { errors.push({ path, message: "Card stage button must be an object" }); return }
    Object.keys(button).filter(key => !["columnId", "label"].includes(key)).forEach(key => errors.push({ path: `${path}/${key}`, message: "Unknown button setting" }))
    if (typeof button.columnId !== "string" || !columnIds.has(button.columnId)) errors.push({ path: `${path}/columnId`, message: "Button target must be an active column on this board" })
    else if (used.has(button.columnId)) errors.push({ path: `${path}/columnId`, message: "Button target is duplicated" })
    if (typeof button.columnId === "string") used.add(button.columnId)
    if (button.label !== undefined && (typeof button.label !== "string" || !button.label.trim())) errors.push({ path: `${path}/label`, message: "Button label must contain text" })
  })
}
function validateFields(value: unknown, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "/fields", message: "Fields must be an array" })
    return
  }
  value.forEach((entry, index) => validateField(entry, index, errors))
}
function validateField(value: unknown, index: number, errors: SchemaValidationError[]): void {
  const path = `/fields/${index}`
  if (!record(value)) {
    errors.push({ path, message: "Field definition must be an object" })
    return
  }
  requiredText(value.title, `${path}/title`, "Field title is required", errors)
  if (typeof value.valueType !== "string" || !valueTypes.has(value.valueType)) errors.push({ path: `${path}/valueType`, message: "valueType must be one of: text, number, boolean, select, url, date, datetime" })
  if (typeof value.required !== "boolean") errors.push({ path: `${path}/required`, message: "required must be a boolean" })
  if (value.valueType === "select") validateOptions(value.options, path, errors)
}
function validateOptions(value: unknown, path: string, errors: SchemaValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path: `${path}/options`, message: "Select field options must be an array" })
    return
  }
  value.forEach((entry, index) => {
    if (!record(entry)) {
      errors.push({ path: `${path}/options/${index}`, message: "Option must be an object" })
      return
    }
    requiredText(entry.title, `${path}/options/${index}/title`, "Option title is required", errors)
  })
}
function validatePolicy(draft: Record<string, unknown>, doc: WorkspaceDocumentV2 | undefined, errors: SchemaValidationError[]): void {
  if (draft.priorityPolicy == null) return
  const parsed = priorityPolicySchema.safeParse(draft.priorityPolicy)
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(issue => ({ path: `/priorityPolicy/${issue.path.join("/")}`.replace(/\/$/, ""), message: issue.message })))
    return
  }
  errors.push(...validatePriorityPolicy(parsed.data, doc, typeof draft.boardId === "string" ? draft.boardId : ""))
  if (!Array.isArray(draft.fields)) return
  const ids = new Set(draft.fields.map(value => record(value) && typeof value.id === "string" ? value.id : ""))
  parsed.data.rules.forEach((rule, index) => { if (!ids.has(rule.fieldId)) errors.push({ path: `/priorityPolicy/rules/${index}/fieldId`, message: "Rule field must remain on this board" }) })
  if (parsed.data.assessmentFieldId && !ids.has(parsed.data.assessmentFieldId)) errors.push({ path: "/priorityPolicy/assessmentFieldId", message: "Assessment field must remain on this board" })
  if (!ids.has(parsed.data.priorityFieldId)) errors.push({ path: "/priorityPolicy/priorityFieldId", message: "Priority output field must remain on this board" })
  if (parsed.data.fitFieldId && !ids.has(parsed.data.fitFieldId)) errors.push({ path: "/priorityPolicy/fitFieldId", message: "Fit output field must remain on this board" })
}

export function diffBoardSchema(doc: WorkspaceDocumentV2, boardId: string, draft: BoardSchemaDraft): SchemaDiff {
  const current = projectBoardSchema(doc, boardId)
  const columns = diffColumns(current.columns, draft.columns, doc)
  const fields = diffFields(current.fields, draft.fields)
  const format = (policy: CardAgingPolicy | undefined) => policy ? `${policy.thresholds.watch} / ${policy.thresholds.aged} / ${policy.thresholds.overdue}` : "default"
  const before = format(current.cardAgingPolicy); const after = format(draft.cardAgingPolicy)
  return { ...columns, ...fields, ...(before !== after ? { cardAgingChange: { before, after } } : {}) }
}
function diffColumns(current: BoardSchemaColumn[], draft: BoardSchemaColumn[], doc: WorkspaceDocumentV2): Pick<SchemaDiff, "columnsRenamed" | "columnsReordered" | "columnsAdded" | "columnsArchived"> {
  const known = byId(current); const incoming = byId(draft)
  const columnsRenamed = draft.flatMap(column => column.id && known.get(column.id)?.title !== column.title ? [{ id: column.id, oldTitle: known.get(column.id)!.title, newTitle: column.title }] : [])
  const columnsAdded = draft.filter(column => !column.id || !known.has(column.id)).map(column => ({ title: column.title }))
  const columnsArchived = current.flatMap(column => {
    if (!column.id || incoming.has(column.id)) return []
    const retainedItemCount = getChildren(doc.entities, column.id)
      .filter(entity => isItem(entity) && isItemArchived(entity)).length
    return [{ id: column.id, title: column.title, retainedItemCount }]
  })
  return { columnsRenamed, columnsAdded, columnsArchived, columnsReordered: JSON.stringify(current.map(column => column.id).filter(Boolean)) !== JSON.stringify(draft.map(column => column.id).filter(Boolean)) }
}
function diffFields(current: BoardSchemaField[], draft: BoardSchemaField[]): Pick<SchemaDiff, "fieldsAdded" | "fieldsModified" | "fieldsArchived" | "optionsAdded" | "optionsModified" | "optionsArchived"> {
  const known = byId(current); const incoming = byId(draft); const result = emptyFieldDiff()
  draft.forEach(field => { const previous = field.id ? known.get(field.id) : undefined; if (!previous) result.fieldsAdded.push({ title: field.title, valueType: field.valueType }); else addFieldChanges(previous, field, result) })
  current.forEach(field => { if (field.id && !incoming.has(field.id)) result.fieldsArchived.push({ id: field.id, title: field.title }) })
  return result
}
function addFieldChanges(previous: BoardSchemaField, next: BoardSchemaField, result: ReturnType<typeof emptyFieldDiff>): void {
  const changes = [
    ["title", previous.title, next.title],
    ["required", previous.required, next.required],
    ["type", previous.valueType, next.valueType],
  ].flatMap(([label, before, after]) => (
    before === after ? [] : [`${label}: "${before}" → "${after}"`]
  ))
  if (changes.length && next.id) result.fieldsModified.push({ id: next.id, title: next.title, changes })
  if (previous.valueType === "select" && next.valueType === "select" && next.id) addOptionChanges(previous.options ?? [], next.options ?? [], next.id, result)
}
function addOptionChanges(previous: BoardSchemaSelectOption[], next: BoardSchemaSelectOption[], fieldId: string, result: ReturnType<typeof emptyFieldDiff>): void {
  const known = byId(previous); const incoming = byId(next)
  next.forEach(option => {
    const old = option.id ? known.get(option.id) : undefined
    if (!old) {
      result.optionsAdded.push({ fieldId, title: option.title })
    } else if (old.title !== option.title && option.id) {
      result.optionsModified.push({
        fieldId,
        optionId: option.id,
        oldTitle: old.title,
        newTitle: option.title,
      })
    }
  })
  previous.forEach(option => { if (option.id && !incoming.has(option.id)) result.optionsArchived.push({ fieldId, optionId: option.id, title: option.title }) })
}
function emptyFieldDiff(): Pick<SchemaDiff, "fieldsAdded" | "fieldsModified" | "fieldsArchived" | "optionsAdded" | "optionsModified" | "optionsArchived"> {
  return {
    fieldsAdded: [],
    fieldsModified: [],
    fieldsArchived: [],
    optionsAdded: [],
    optionsModified: [],
    optionsArchived: [],
  }
}
function byId<T extends { id?: string }>(values: T[]): Map<string, T> { return new Map(values.flatMap(value => value.id ? [[value.id, value] as [string, T]] : [])) }
function requiredText(value: unknown, path: string, message: string, errors: SchemaValidationError[]): void { if (typeof value !== "string" || !value.trim()) errors.push({ path, message }) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
