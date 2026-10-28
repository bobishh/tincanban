import * as Automerge from "@automerge/automerge/slim"
import { workspaceEntitiesAtHeads } from "../crdtHistory"
import type { CommandErrorCode, FieldDefinition, FieldValue, Item, WorkspaceDocumentV2, WorkspaceEntity } from "./model"
import { entityKind, hasEntityKind, isItem, validatePlacementParent } from "./model"
import { getAncestryPath } from "./ancestry"
import { isArchiveColumnInWorkspace, isItemArchived, itemWorkflow, setItemLifecycle, setItemWorkflow, workflowColumnId } from "./archive"
import { validateItemValues } from "./fields"
import { isInlineNarrativeNote } from "./narrative"
import { seedBoard } from "./seeds"
import { err } from "./commandTypes"
import { entitySchema } from "./entitySchemas"
import type { CommandByKind, CommandContext, CommandHandler, PreparedCommand } from "./commandHandlerTypes"
import { applyRenumbering, computeInsertionRank, findRootBoardId } from "./commandSupport"

export const createWorkspace: CommandHandler<"createWorkspace"> = () => err("invalid_input", "createWorkspace cannot be executed on an existing workspace document")

export const setWorkspaceArchived: CommandHandler<"setWorkspaceArchived"> = (_doc, command, context) => ({ ok: true, value: { changedEntityIds: [], apply: draft => { draft.archivedAt = command.archived ? context.nowIso : null } } })

export const renameWorkspace: CommandHandler<"renameWorkspace"> = (_doc, command) => {
  if (!command.title.trim()) return err("invalid_input", "Workspace name is required", "title")
  return { ok: true, value: { changedEntityIds: [], apply: draft => { draft.title = command.title.trim() } } }
}

export const createBoard: CommandHandler<"createBoard"> = (_doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Board title is required", "title")
  const entities: Record<string, WorkspaceEntity> = {}
  const board = seedBoard(entities, command.title.trim(), command.preset, context.nowIso)
  return { ok: true, value: { changedEntityIds: [board.id, ...Object.keys(entities).filter(id => id !== board.id)], apply: draft => { Object.assign(draft.entities, entities) } } }
}

export const createItem: CommandHandler<"createItem"> = (doc, command, context) => {
  if (!command.title.trim()) return err("invalid_input", "Item title is required", "title")
  const parent = doc.entities[command.parentId]
  if (!parent) return err("not_found", `Parent ${command.parentId} not found`)
  if (hasEntityKind(parent, "column") && isArchiveColumnInWorkspace(parent, doc.entities)) return err("invalid_parent", "Items cannot be created in Archive")
  const parentResult = validatePlacementParent("item", entityKind(parent))
  if (!parentResult.ok) return err("invalid_parent", parentResult.error.message)
  const values = itemValuesForCreate(doc, command)
  if (!values.ok) return values
  const itemId = command.id ?? crypto.randomUUID()
  const insertion = computeInsertionRank(doc.entities, command.parentId, command.beforeId)
  return { ok: true, value: { changedEntityIds: [itemId], apply: draft => createItemInDraft(draft, command, itemId, values.value, insertion, context.nowIso) } }
}

type CommandFailure = { ok: false; error: { code: CommandErrorCode; message: string; field?: string } }

function itemValuesForCreate(doc: Automerge.Doc<WorkspaceDocumentV2>, command: CommandByKind<"createItem">): { ok: true; value: Record<string, FieldValue> } | CommandFailure {
  const boardId = findRootBoardId(doc.entities, command.parentId)
  if (!boardId) return { ok: true, value: command.values ?? {} }
  const values = { ...command.values ?? {} }
  const board = doc.entities[boardId]
  const fields = hasEntityKind(board, "board") ? board.cardPresentation?.titleFieldIds ?? [] : []
  const parts = command.title.split(" — ")
  fields.forEach((fieldId, index) => {
    if (values[fieldId] !== undefined) return
    values[fieldId] = index === fields.length - 1 ? parts.slice(index).join(" — ") || command.title : parts[index] ?? command.title
  })
  const validation = validateValues(doc, boardId, values, command.body)
  if (!validation.ok) return validation
  return { ok: true, value: values }
}

function validateValues(doc: Automerge.Doc<WorkspaceDocumentV2>, boardId: string, values: Record<string, FieldValue>, body?: string,
  previousValues?: Readonly<Record<string, FieldValue>>): { ok: true } | CommandFailure {
  const fields = Object.values(doc.entities).filter((entity): entity is FieldDefinition => hasEntityKind(entity, "field") && entity.placement.parentId === boardId)
  const board = doc.entities[boardId]
  const notesFieldId = hasEntityKind(board, "board") ? board.cardPresentation?.narrativeFieldId : undefined
  const valuesForValidation = { ...values }
  if (notesFieldId && fields.find(field => field.id === notesFieldId)?.valueType === "text" && fields.find(field => field.id === notesFieldId)?.required) {
    const legacyNote = values[notesFieldId]
    valuesForValidation[notesFieldId] = typeof legacyNote === "string" && legacyNote.trim() ? legacyNote : body ?? ""
  }
  const validation = validateItemValues(fields, valuesForValidation, previousValues)
  if (validation.ok) return { ok: true }
  const field = Object.keys(validation.errors)[0]
  return err("invalid_input", validation.errors[field], field)
}

function createItemInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"createItem">, id: string, values: Record<string, FieldValue>, insertion: ReturnType<typeof computeInsertionRank>, nowIso: string) {
  applyRenumbering(draft, insertion.renumbered)
  const item: Item = { id, title: command.title.trim(), body: command.body ?? "", placement: { parentId: command.parentId, rank: insertion.rank }, createdAt: nowIso, updatedAt: nowIso, lastActivityAt: nowIso, values, lifecycle: JSON.stringify({ state: "active", changedAt: nowIso }) }
  const columnId = workflowColumnId(draft.entities, command.parentId)
  if (columnId) setItemWorkflow(item, columnId, nowIso)
  draft.entities[id] = item
}

export const patchItem: CommandHandler<"patchItem"> = (doc, command, context) => {
  const item = doc.entities[command.entityId]
  if (!isItem(item)) return err("not_found", `Item ${command.entityId} not found`)
  if (command.title !== undefined && !command.title.trim()) return err("invalid_input", "Item title cannot be empty", "title")
  const foldError = validateNarrativeFold(doc, item, command)
  if (!foldError.ok) return foldError
  const validation = validateItemPatch(doc, item, command)
  if (!validation.ok) return validation
  const changedEntityIds = [command.entityId, ...(command.foldNarrativeSources?.notes.map(note => note.id) ?? [])]
  return { ok: true, value: { changedEntityIds, apply: draft => patchItemInDraft(draft, command, context.nowIso) } }
}

function validateNarrativeFold(doc: Automerge.Doc<WorkspaceDocumentV2>, item: Item, command: CommandByKind<"patchItem">): PreparedCommand | { ok: true } {
  const fold = command.foldNarrativeSources
  if (!fold) return { ok: true }
  if (command.body === undefined) return err("invalid_input", "Narrative fold requires a replacement description")
  if (fold.notesFieldId && command.values?.[fold.notesFieldId] !== "") return err("invalid_input", "Narrative fold must clear preset Notes")
  if (item.body !== fold.expectedBody) return err("conflict", "Card description changed. Reopen card and retry.")
  if (fold.notesFieldId && item.values[fold.notesFieldId] !== fold.expectedNotes) return err("conflict", "Card notes changed. Reopen card and retry.")
  const currentNotes = Object.values(doc.entities).filter(entity => entity.kind === "document" && entity.placement.parentId === item.id && !entity.archivedAt && isInlineNarrativeNote(entity))
  if (JSON.stringify(currentNotes.map(note => note.id).sort()) !== JSON.stringify(fold.notes.map(note => note.id).sort())) return err("conflict", "Attached notes changed. Reopen card and retry.")
  const unchanged = fold.notes.every(source => {
    const note = doc.entities[source.id]
    return note?.kind === "document" && note.placement.parentId === item.id && !note.archivedAt && isInlineNarrativeNote(note) && note.title === source.title && note.content === source.content && note.format === source.format
  })
  return unchanged ? { ok: true } : err("conflict", "Attached note changed. Reopen card and retry.")
}

function validateItemPatch(doc: Automerge.Doc<WorkspaceDocumentV2>, item: Item, command: CommandByKind<"patchItem">): PreparedCommand | { ok: true } {
  if (!command.values && command.body === undefined) return { ok: true }
  const boardId = findRootBoardId(doc.entities, item.id)
  return boardId ? validateValues(doc, boardId, { ...item.values, ...command.values }, command.body ?? item.body, item.values) : { ok: true }
}

function patchItemInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"patchItem">, nowIso: string) {
  const item = draft.entities[command.entityId] as Item
  if (command.title !== undefined) item.title = command.title.trim()
  if (command.body !== undefined) item.body = command.body
  Object.assign(item.values, command.values ?? {})
  if (command.foldNarrativeSources) for (const note of command.foldNarrativeSources.notes) {
    const target = draft.entities[note.id]
    if (target?.kind === "document") { target.archivedAt = nowIso; target.updatedAt = nowIso }
  }
  item.updatedAt = nowIso
  item.lastActivityAt = nowIso
}

export const restoreItemVersion: CommandHandler<"restoreItemVersion"> = (doc, command, context) => {
  const item = doc.entities[command.entityId]
  if (!isItem(item)) return err("not_found", `Item ${command.entityId} not found`)
  let historical: WorkspaceEntity | undefined
  if (command.archived) {
    historical = archivedItemVersion(command)
    if (!historical) return err("invalid_input", "Archived item version or source binding is invalid")
  } else {
    const change = Automerge.getChangesMetaSince(doc, []).find(entry => entry.hash === command.changeHash)
    if (!change) return err("not_found", "Recorded item version is unavailable")
    historical = workspaceEntitiesAtHeads(doc, [change.hash])[command.entityId]
  }
  if (!isItem(historical)) return err("not_found", "Recorded item version is unavailable")
  const parent = historical.placement.parentId ? doc.entities[historical.placement.parentId] : undefined
  if (!parent || !validatePlacementParent("item", entityKind(parent)).ok) return err("invalid_parent", "Recorded item parent is unavailable")
  const restored = JSON.parse(JSON.stringify(historical)) as Item
  const changedEntityIds = [command.entityId, ...Object.values(doc.entities).filter(candidate => isItem(candidate) && candidate.id !== command.entityId && getAncestryPath(doc.entities, candidate.id).path.includes(command.entityId)).map(candidate => candidate.id)]
  return { ok: true, value: { changedEntityIds, apply: draft => restoreItemInDraft(draft, command.entityId, restored, context.nowIso) } }
}

function archivedItemVersion(command: CommandByKind<"restoreItemVersion">): Item | undefined {
  const source = command.archived
  if (!source) return
  const parsed = entitySchema.safeParse(source.item)
  if (!/^[A-Za-z0-9_-]{43}$/.test(source.baselineId) || !Number.isSafeInteger(source.historyEpoch) || source.historyEpoch < 1 ||
      !/^[a-f0-9]{64}$/.test(command.changeHash) || !["admitted", "pending", "quarantined"].includes(source.observation) ||
      !parsed.success || !isItem(parsed.data) || parsed.data.id !== command.entityId) return
  return parsed.data
}

function restoreItemInDraft(draft: WorkspaceDocumentV2, id: string, restored: Item, nowIso: string) {
  const item = draft.entities[id] as Item
  const descendants = Object.values(draft.entities).filter((candidate): candidate is Item => isItem(candidate) && getAncestryPath(draft.entities, candidate.id).path.includes(id))
  item.title = restored.title; item.body = restored.body; item.values = restored.values
  if (item.placement.parentId === restored.placement.parentId) item.placement.rank = restored.placement.rank
  else item.placement = restored.placement
  setItemLifecycle(item, isItemArchived(restored), nowIso)
  for (const descendant of descendants) {
    const columnId = workflowColumnId(draft.entities, descendant.id)
    if (columnId && (descendant === item || itemWorkflow(descendant)?.columnId !== columnId)) setItemWorkflow(descendant, columnId, nowIso)
  }
  item.updatedAt = nowIso; item.lastActivityAt = nowIso
}

export const moveEntity: CommandHandler<"moveEntity"> = (doc, command, context) => moveEntityResult(doc, command, context, false)
export const restoreAndMove: CommandHandler<"restoreAndMove"> = (doc, command, context) => moveEntityResult(doc, command, context, true)

function moveEntityResult(doc: Automerge.Doc<WorkspaceDocumentV2>, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">, context: CommandContext, restore: boolean): PreparedCommand {
  const entity = doc.entities[command.entityId]
  if (!entity) return err("not_found", `Entity ${command.entityId} not found`)
  const valid = validateMove(doc, entity, command)
  if (!valid.ok) return valid
  const insertion = computeInsertionRank(doc.entities, command.parentId, command.beforeId)
  const descendantItemIds = isItemShell(entity) ? itemDescendantIds(doc.entities, entity.id) : []
  return { ok: true, value: { changedEntityIds: [command.entityId, ...descendantItemIds.filter(id => id !== command.entityId)], apply: draft => moveEntityInDraft(draft, command, insertion, context.nowIso, restore, descendantItemIds) } }
}

function validateMove(doc: Automerge.Doc<WorkspaceDocumentV2>, entity: WorkspaceEntity, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">): PreparedCommand | { ok: true } {
  if (command.parentId === command.entityId) return err("cycle", "Cannot place an entity under itself")
  if (getAncestryPath(doc.entities, command.parentId).path.includes(command.entityId)) return err("cycle", "Cannot place an entity under its descendant")
  const parent = doc.entities[command.parentId]
  if (!parent) return err("not_found", `Target parent ${command.parentId} not found`)
  if (hasEntityKind(parent, "column") && isArchiveColumnInWorkspace(parent, doc.entities)) return err("invalid_parent", "Archive items with setEntityArchived")
  const result = validatePlacementParent(entityKind(entity), entityKind(parent))
  if (!result.ok) return err("invalid_parent", result.error.message)
  if (findRootBoardId(doc.entities, entity.id) !== findRootBoardId(doc.entities, command.parentId)) return err("cross_board_move", "Cross-board moves are not supported")
  return { ok: true }
}

function itemDescendantIds(entities: Record<string, WorkspaceEntity>, rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const entity of Object.values(entities)) {
    const parentId = entity.placement.parentId
    if (!parentId) continue
    const children = childrenByParent.get(parentId) ?? []
    children.push(entity.id)
    childrenByParent.set(parentId, children)
  }
  const itemIds = [rootId]
  const visited = new Set([rootId])
  const pending = [...(childrenByParent.get(rootId) ?? [])]
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const entity = entities[id]
    if (!entity) continue
    if (isItemShell(entity)) itemIds.push(id)
    pending.push(...(childrenByParent.get(id) ?? []))
  }
  return itemIds
}

function isItemShell(entity: WorkspaceEntity): entity is Item {
  // Valid workspace items are the only entities without a `kind` discriminator.
  // Avoid reading `body` here: on Automerge text fields that decodes the full
  // narrative, and descendant scans must stay cheap on cards with long notes.
  return !("kind" in entity) && typeof entity.id === "string" && typeof entity.title === "string" &&
    Boolean(entity.values && typeof entity.values === "object") && Boolean(entity.placement && typeof entity.placement === "object")
}

function moveEntityInDraft(draft: WorkspaceDocumentV2, command: CommandByKind<"moveEntity"> | CommandByKind<"restoreAndMove">, insertion: ReturnType<typeof computeInsertionRank>, nowIso: string, restore: boolean, descendantItemIds: string[]) {
  applyRenumbering(draft, insertion.renumbered)
  const entity = draft.entities[command.entityId]
  const movedToNewParent = entity.placement.parentId !== command.parentId
  if (restore && isItemShell(entity)) setItemLifecycle(entity, false, nowIso)
  else if (restore) entity.archivedAt = null
  if (entity.placement.parentId === command.parentId) entity.placement.rank = insertion.rank
  else entity.placement = { parentId: command.parentId, rank: insertion.rank }
  entity.updatedAt = nowIso
  if (isItemShell(entity)) {
    for (const descendantId of descendantItemIds) {
      const descendant = draft.entities[descendantId]
      if (!descendant || !isItemShell(descendant)) continue
      const columnId = workflowColumnId(draft.entities, descendant.id)
      if (columnId && itemWorkflow(descendant)?.columnId !== columnId) setItemWorkflow(descendant, columnId, nowIso)
    }
    if (movedToNewParent) entity.lastActivityAt = nowIso
  }
}

export const renameEntity: CommandHandler<"renameEntity"> = (doc, command, context) => {
  if (!doc.entities[command.entityId]) return err("not_found", `Entity ${command.entityId} not found`)
  if (!command.title.trim()) return err("invalid_input", "Title cannot be empty", "title")
  if (command.collapsible !== undefined && !hasEntityKind(doc.entities[command.entityId], "column")) return err("invalid_input", "Only columns can be collapsible", "collapsible")
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => {
    const entity = draft.entities[command.entityId]
    entity.title = command.title.trim()
    if (command.collapsible !== undefined && hasEntityKind(entity, "column")) entity.collapsible = command.collapsible
    entity.updatedAt = context.nowIso
  } } }
}

export const setEntityArchived: CommandHandler<"setEntityArchived"> = (doc, command, context) => {
  const source = doc.entities[command.entityId]
  if (!source) return err("not_found", `Entity ${command.entityId} not found`)
  if (command.archived && hasEntityKind(source, "column")) {
    const board = source.placement.parentId ? doc.entities[source.placement.parentId] : undefined
    if (hasEntityKind(board, "board") && board.archiveColumnId === source.id)
      return err("invalid_input", "Change or clear the board archive column before removing it", "archiveColumnId")
  }
  return { ok: true, value: { changedEntityIds: [command.entityId], apply: draft => {
    const entity = draft.entities[command.entityId]
    if (isItem(entity)) setItemLifecycle(entity, command.archived, context.nowIso)
    else entity.archivedAt = command.archived ? context.nowIso : null
    entity.updatedAt = context.nowIso
  } } }
}
