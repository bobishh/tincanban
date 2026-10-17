import type { Preset } from "../domain/seeds"
import { cardTitle, narrativeFieldId } from "../domain/cardPresentation"
import { recordUsageAction } from "../usageActions"
import { hasEntityKind } from "../domain/model"
import { computed, ref } from "vue"
import * as Automerge from "@automerge/automerge/slim"
import type { useAppCore } from "./useAppCore"
import type { useAppBoard } from "./useAppBoard"
import type { BoardSchemaDraft } from "../domain/schema"
import type { WorkspaceCreationDraft } from "../domain/seeds"
import { projectWorkspaceSettings, type WorkspaceSettingsDraft } from "../domain/workspaceSettings"
import { isArchiveColumn, isItemArchived } from "../domain/archive"
import { isInlineNarrativeNote, type NarrativeNoteSource } from "../domain/narrative"
import type { NarrativeFoldSources } from "../domain/commandTypes"
import { isItem, type AttachedDocument, type Column, type FieldValue, type Heads, type Item } from "../domain/model"
import type { DocumentInput } from "../types"

export function useAppActions(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  const content = useContentActions(core, board)
  const boardActions = useBoardActions(core, board)
  const workspace = useWorkspaceActions(core)
  return { ...content, ...boardActions, ...workspace }
}

function useContentActions(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  const restoreSelectedItemVersion = async (changeHash: string) => {
    if (!board.selectedHistoryItemId.value || core.historyRestoreSaving.value) return
    core.historyRestoreSaving.value = true
    core.historyRestoreError.value = ""
    core.historyRestoreNotice.value = ""
    try {
      const entityId = board.selectedHistoryItemId.value, workspaceId = core.tincanban.activeWorkspace.id
      const archived = await board.readArchivedItemVersion(changeHash)
      if (board.selectedHistoryItemId.value !== entityId || core.tincanban.activeWorkspace.id !== workspaceId) throw new Error("History selection changed")
      await core.tincanban.executeCommandAsync({ kind: "restoreItemVersion", entityId, changeHash,
        ...(archived ? { archived: { baselineId: archived.baselineId, historyEpoch: archived.historyEpoch,
          observation: archived.observation, item: archived.item } } : {}) })
      core.historyRestoreNotice.value = "Version restored"
    } catch (error) {
      core.historyRestoreError.value = `Restore failed: ${messageFrom(error)}`
    } finally { core.historyRestoreSaving.value = false }
  }
  const saveQuickNote = async (item: Item) => {
    const note = core.quickNoteDraft.value.trim()
    if (!note || core.quickNoteSaving.value) return
    core.quickNoteSaving.value = true
    core.quickNoteError.value = ""
    const notesFieldId = narrativeFieldId(core.tincanban.activeBoard.value, core.tincanban.boardFields.value)
    try {
      const fieldId = notesFieldId && isPresetTextNotesField(core, notesFieldId) ? notesFieldId : undefined
      const narrative = appendQuickNote(board.cardNotes(item), note)
      await core.tincanban.executeCommandAsync({ kind: "patchItem", entityId: item.id, body: narrative, ...(fieldId ? { values: { [fieldId]: "" } } : {}), foldNarrativeSources: foldSources(core, item, fieldId) })
      core.quickNoteDraft.value = ""
      core.notice.value = "Note added"
    } catch (error) { core.quickNoteError.value = `Note not saved: ${messageFrom(error)}` }
    finally { core.quickNoteSaving.value = false }
  }
  const submitDocument = async (itemId: string, draft: Omit<DocumentInput, "itemId">) => {
    await core.tincanban.createDocumentAsync({ itemId: itemId, ...draft, title: draft.title.trim() })
    core.notice.value = "Document attached"
  }
  const updateDocumentMarkdown = (documentId: string, markdown: string) => core.tincanban.updateDocumentAsync(documentId, markdown)
  const updateItemMarkdown = async (item: Item, markdown: string) => {
    const notesFieldId = narrativeFieldId(core.tincanban.activeBoard.value, core.tincanban.boardFields.value)
    const fieldId = notesFieldId && isPresetTextNotesField(core, notesFieldId) ? notesFieldId : undefined
    try {
      await core.tincanban.executeCommandAsync({ kind: "patchItem", entityId: item.id, body: markdown, ...(fieldId ? { values: { [fieldId]: "" } } : {}), foldNarrativeSources: foldSources(core, item, fieldId) })
      core.notice.value = "Checklist updated"
    } catch (error) {
      core.notice.value = `Checklist not saved: ${messageFrom(error)}`
    }
  }
  const handleSaveTemplate = async (payload: { id?: string; newId?: string; name: string; markdown: string }) =>
    (await import("./workspaceFiles")).saveWorkspaceTemplate(core, payload)
  const moveCardToColumn = (item: Item, columnId: string) => moveItemToColumn(core, item, columnId)

  return { restoreSelectedItemVersion, saveQuickNote, submitDocument, updateDocumentMarkdown, updateItemMarkdown, handleSaveTemplate, moveCardToColumn }
}

function appendQuickNote(existing: unknown, note: string) {
  const current = typeof existing === "string" ? existing : ""
  return current.length ? `${current}\n\n${note}` : note
}

function isPresetTextNotesField(core: ReturnType<typeof useAppCore>, fieldId: string): boolean {
  return core.tincanban.boardFields.value.some(field => field.id === fieldId && field.valueType === "text")
}

function foldSources(core: ReturnType<typeof useAppCore>, item: Item, notesFieldId?: string) {
  const entities = core.tincanban.getActiveDoc()?.entities ?? {}
  const notes = Object.values(entities).filter((entity): entity is AttachedDocument =>
    entity.kind === "document" && entity.placement.parentId === item.id && !entity.archivedAt && isInlineNarrativeNote(entity as NarrativeNoteSource))
  return {
    expectedBody: item.body,
    ...(notesFieldId ? { notesFieldId, expectedNotes: item.values[notesFieldId] } : {}),
    notes: notes.map(({ id, title, content, format }) => ({ id, title, content, format })),
  }
}

async function moveItemToColumn(core: ReturnType<typeof useAppCore>, item: Item, columnId: string) {
  const target = core.tincanban.genericColumns.value.find(column => column.id === columnId)
  if (!target) throw new Error("Column no longer exists")
  if (isArchiveColumn(target)) {
    if (isItemArchived(item)) return
    await core.tincanban.executeCommandAsync({ kind: "setEntityArchived", entityId: item.id, archived: true })
    core.archiveUndo.value = { workspaceId: core.tincanban.activeWorkspace.id, itemId: item.id, title: item.title }
    recordUsageAction("item_move")
    core.notice.value = "Item archived"
    return
  }
  if (target.id === item.placement.parentId && !isItemArchived(item)) return
  await core.tincanban.executeCommandAsync({ kind: "restoreAndMove", entityId: item.id, parentId: target.id, beforeId: null })
  recordUsageAction("item_move")
  core.notice.value = "Item moved"
}

function useBoardActions(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  const settingsSaveError = ref("")
  const settingsSaving = ref(false)
  const itemInsertion = ref<{ columnId: string; beforeId: string } | null>(null)
  const newBoardColumnArchive = ref(false)
  const newBoardColumnCollapsible = ref(false)
  const addingBoardColumn = ref(false)
  const addBoardColumnError = ref("")
  const openBoardItem = (item: Item) => handleOpenItem(item)
  const closeDetail = () => {
    core.selectedItemId.value = null
  }
  const openAddItem = (columnId?: string, beforeId?: string) => {
    itemInsertion.value = columnId && beforeId ? { columnId, beforeId } : null
    core.storageError.value = ""
    core.itemFormError.value = ""
    core.itemFormParentId.value = columnId ?? initialItemParent(core)
    core.showItemForm.value = true
  }
  const handleSaveItem = (payload: ItemSavePayload) => saveItem(core, board, payload, itemInsertion.value)
  const currentDocHeads = computed(() => { void core.tincanban.docVersion.value; const doc = core.tincanban.getActiveDoc(); return doc ? Automerge.getHeads(doc) : [] })
  const handleApplySchema = (payload: { schema: BoardSchemaDraft; expectedHeads?: Heads }) => applySchema(core, payload)
  const handleApplyWorkspaceSettings = async (payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads }) => {
    if (settingsSaving.value) return false
    settingsSaveError.value = ""
    settingsSaving.value = true
    try {
      const saved = await applyWorkspaceSettings(core, payload)
      if (!saved) settingsSaveError.value = core.notice.value
      return saved
    } finally { settingsSaving.value = false }
  }
  const handleArchiveItem = (itemId: string) => archiveItem(core, board.selectedItem.value, itemId)
  const handleRestoreItem = (itemId: string) => restoreItem(core, itemId)
  const undoArchive = () => restoreArchivedItem(core, board.highlightMoved)
  const handleOpenItem = (item: Item) => { core.selectedItemId.value = item.id }
  const handleOpenItemEdit = (item: Item) => openItemEdit(core, item)
  const handleAddSubitem = (parentItemId: string) => { core.itemFormParentId.value = parentItemId; core.itemFormError.value = ""; core.showItemForm.value = true }
  const handleStartMove = (item: Item) => { core.itemToMove.value = item; core.showMoveDialog.value = true }
  const handleConfirmMove = (newParentId: string) => confirmMove(core, newParentId)
  const handleRenameColumn = (newTitle: string, collapsible: boolean, archive: boolean) => renameColumn(core, newTitle, collapsible, archive)
  const handleArchiveColumn = () => archiveColumn(core)
  const addBoardColumn = async () => {
    if (addingBoardColumn.value || !core.newBoardColumnTitle.value.trim()) return
    addingBoardColumn.value = true
    addBoardColumnError.value = ""
    try {
      await addColumn(core, core.newBoardColumnTitle.value, newBoardColumnArchive.value, newBoardColumnCollapsible.value)
      core.newBoardColumnTitle.value = ""
      newBoardColumnArchive.value = false
      newBoardColumnCollapsible.value = false
    } catch (error) { addBoardColumnError.value = messageFrom(error) }
    finally { addingBoardColumn.value = false }
  }
  const selectArchiveColumn = (checked: boolean) => {
    newBoardColumnArchive.value = checked
    if (checked && !core.newBoardColumnTitle.value.trim()) core.newBoardColumnTitle.value = "Archive"
  }
  return { openBoardItem, closeDetail, openAddItem, handleSaveItem, currentDocHeads, handleApplySchema, handleApplyWorkspaceSettings, settingsSaveError, settingsSaving, handleArchiveItem, handleRestoreItem, undoArchive, handleOpenItem, handleOpenItemEdit, handleAddSubitem, handleStartMove, handleConfirmMove, handleRenameColumn, handleArchiveColumn, addBoardColumn, newBoardColumnArchive, newBoardColumnCollapsible, addingBoardColumn, addBoardColumnError, selectArchiveColumn }
}

type ItemSavePayload = { title: string; body: string; parentId?: string; values: Record<string, FieldValue>; foldSnapshot?: NarrativeFoldSources }

function initialItemParent(core: ReturnType<typeof useAppCore>) {
  const columns = core.tincanban.genericColumns.value
  if (columns[0]) return columns[0].id
  const doc = core.tincanban.getActiveDoc()
  return doc ? Object.values(doc.entities).find((entity): entity is Column => hasEntityKind(entity, "column") && !entity.archivedAt)?.id ?? core.tincanban.activeBoard.value?.id ?? "" : core.tincanban.activeBoard.value?.id ?? ""
}

async function saveItem(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, payload: ItemSavePayload, insertion: { columnId: string; beforeId: string } | null = null) {
  if (core.savingItem.value) return
  core.savingItem.value = true
  try {
    core.storageError.value = ""
    core.itemFormError.value = ""
    const narrativePayload = { ...payload, values: { ...payload.values } }
    const notesFieldId = narrativeFieldId(core.tincanban.activeBoard.value, core.tincanban.boardFields.value)
    const fieldId = notesFieldId && isPresetTextNotesField(core, notesFieldId) ? notesFieldId : undefined
    if (fieldId) narrativePayload.values[fieldId] = ""
    const details = itemSaveDetails(core, board, narrativePayload)
    if (details.item) await saveExistingItem(core, details.item, details, payload.body, fieldId, payload.foldSnapshot)
    else await saveNewItem(core, details, payload.body, insertion?.columnId === details.parentId ? insertion.beforeId : undefined)
    core.showItemForm.value = false
    core.notice.value = "Item saved"
  } catch (error) {
    core.storageError.value = "Storage failure: Save failed"
    core.itemFormError.value = messageFrom(error)
  } finally { core.savingItem.value = false }
}

function itemSaveDetails(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, payload: ItemSavePayload) {
  const values = { ...payload.values }
  const requestedParent = payload.parentId || core.itemFormParentId.value
  const parentId = core.tincanban.genericColumns.value.find(column => column.id === requestedParent || board.columnStatus(column.id) === requestedParent)?.id ?? requestedParent
  const item = board.editingItem.value
  return { item, parentId, values, title: cardTitle(core.tincanban.activeBoard.value, values, payload.title || item?.title || "Untitled item") }
}

async function saveExistingItem(core: ReturnType<typeof useAppCore>, item: Item, details: ReturnType<typeof itemSaveDetails>, body: string, notesFieldId?: string, snapshot?: NarrativeFoldSources) {
  await core.tincanban.executeCommandAsync({ kind: "patchItem", entityId: item.id, title: details.title, body, values: details.values, foldNarrativeSources: snapshot ?? foldSources(core, item, notesFieldId) })
  if (details.parentId && details.parentId !== item.placement.parentId) await core.tincanban.executeCommandAsync({ kind: "moveEntity", entityId: item.id, parentId: details.parentId, beforeId: null })
  core.editingItemId.value = null
  if (core.tincanban.activeBoard.value?.cardPresentation?.openAfterSave) core.selectedItemId.value = item.id
}

async function saveNewItem(core: ReturnType<typeof useAppCore>, details: ReturnType<typeof itemSaveDetails>, body: string, beforeId?: string) {
  const before = new Set(Object.keys(core.tincanban.getActiveDoc()?.entities ?? {}))
  await core.tincanban.executeCommandAsync({ kind: "createItem", parentId: details.parentId, title: details.title, body, values: details.values, beforeId })
  recordUsageAction("item_create")
  if (!core.tincanban.activeBoard.value?.cardPresentation?.openAfterSave) return
  const created = Object.values(core.tincanban.getActiveDoc()?.entities ?? {}).find(entity => isItem(entity) && !before.has(entity.id))
  if (created) core.selectedItemId.value = created.id
}

async function applySchema(core: ReturnType<typeof useAppCore>, payload: { schema: BoardSchemaDraft; expectedHeads?: Heads }) {
  if (!core.tincanban.activeBoard.value) return
  try {
    await core.tincanban.executeCommandAsync({ kind: "updateBoardSchema", boardId: core.tincanban.activeBoard.value.id, schema: payload.schema, expectedHeads: payload.expectedHeads })
    core.showEntitySettings.value = false
    core.notice.value = "Schema updated"
  } catch (error) { core.notice.value = `Schema update failed: ${messageFrom(error)}` }
}

async function applyWorkspaceSettings(core: ReturnType<typeof useAppCore>, payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads }) {
  try {
    await core.tincanban.executeCommandAsync({ kind: "updateWorkspaceSettings", settings: payload.settings, expectedHeads: payload.expectedHeads })
    core.notice.value = "Workspace settings updated"
    return true
  } catch (error) {
    core.notice.value = `Workspace settings failed: ${messageFrom(error)}`
    return false
  }
}

async function archiveItem(core: ReturnType<typeof useAppCore>, item: Item | null, itemId: string) {
  try {
    core.archiveError.value = ""
    await core.tincanban.executeCommandAsync({ kind: "setEntityArchived", entityId: itemId, archived: true })
    core.archiveUndo.value = item ? { workspaceId: core.tincanban.activeWorkspace.id, itemId, title: item.title } : null
    core.selectedItemId.value = null
    recordUsageAction("item_move")
    core.notice.value = "Item archived"
  } catch (error) { reportArchiveFailure(core, error) }
}

async function restoreItem(core: ReturnType<typeof useAppCore>, itemId: string) {
  const item = core.tincanban.getActiveDoc()?.entities[itemId]
  if (!isItem(item)) return
  const source = core.tincanban.genericColumns.value.find(column => column.id === item.placement.parentId)
  try {
    if (source && isArchiveColumn(source)) {
      const target = core.tincanban.genericColumns.value.find(column => !isArchiveColumn(column))
      if (!target) throw new Error("No active column to restore into")
      await core.tincanban.executeCommandAsync({ kind: "restoreAndMove", entityId: itemId, parentId: target.id, beforeId: null })
    } else await core.tincanban.executeCommandAsync({ kind: "setEntityArchived", entityId: itemId, archived: false })
    core.selectedItemId.value = null
    core.archiveUndo.value = null
    core.notice.value = `Restored ${item.title}`
  } catch (error) { core.archiveError.value = `Restore failed: ${messageFrom(error)}` }
}

async function restoreArchivedItem(core: ReturnType<typeof useAppCore>, highlightMoved: ReturnType<typeof useAppBoard>["highlightMoved"]) {
  const archived = core.archiveUndo.value
  if (!archived || archived.workspaceId !== core.tincanban.activeWorkspace.id || core.undoSaving.value) return
  core.undoSaving.value = true
  try {
    await core.tincanban.executeCommandAsync({ kind: "setEntityArchived", entityId: archived.itemId, archived: false })
    core.archiveUndo.value = null
    core.archiveError.value = ""
    core.notice.value = `Restored ${archived.title}`
    highlightMoved(archived.itemId, "item")
  } catch (error) { core.archiveError.value = `Restore failed: ${messageFrom(error)}`; core.notice.value = core.archiveError.value }
  finally { core.undoSaving.value = false }
}

function openItemEdit(core: ReturnType<typeof useAppCore>, item: Item) {
  core.editingItemId.value = item.id
  core.itemFormParentId.value = item.placement.parentId ?? ""
  core.showItemForm.value = true
  core.selectedItemId.value = null
  core.historyRestoreError.value = ""
  core.historyRestoreNotice.value = ""
}

async function confirmMove(core: ReturnType<typeof useAppCore>, newParentId: string) {
  if (!core.itemToMove.value) return
  await core.tincanban.executeCommandAsync({ kind: "moveEntity", entityId: core.itemToMove.value.id, parentId: newParentId, beforeId: null })
  core.showMoveDialog.value = false
  core.itemToMove.value = null
  recordUsageAction("item_move")
  core.notice.value = "Item moved"
}

async function renameColumn(core: ReturnType<typeof useAppCore>, title: string, collapsible: boolean, archive: boolean) {
  if (!core.editingColumn.value) return
  const doc = core.tincanban.getActiveDoc()
  const board = core.tincanban.activeBoard.value
  if (!doc || !board) return
  const settings = projectWorkspaceSettings(doc, board.id)
  const target = settings.board.columns.find(column => column.id === core.editingColumn.value?.id)
  if (!target) return
  target.title = title
  target.collapsible = collapsible
  if (archive) {
    settings.board.columns.forEach(column => { if (column.id !== target.id) delete column.archive })
    target.archive = true
  } else delete target.archive
  if (!await applyWorkspaceSettings(core, { settings, expectedHeads: Automerge.getHeads(doc) })) return
  core.editingColumn.value = null
  core.notice.value = "Column settings updated"
}

async function archiveColumn(core: ReturnType<typeof useAppCore>) {
  if (!core.editingColumn.value) return
  await core.tincanban.executeCommandAsync({ kind: "setEntityArchived", entityId: core.editingColumn.value.id, archived: true })
  core.editingColumn.value = null
  core.notice.value = "Column removed"
}

async function addColumn(core: ReturnType<typeof useAppCore>, title: string, archive: boolean, collapsible: boolean) {
  if (!title.trim() || !core.tincanban.activeBoard.value) return
  await core.tincanban.executeCommandAsync({ kind: "createColumn", boardId: core.tincanban.activeBoard.value.id, title: title.trim(), ...(archive ? { archive: true as const } : {}), collapsible })
  core.notice.value = `Column "${title.trim()}" created`
}

function useWorkspaceActions(core: ReturnType<typeof useAppCore>) {
  const exportWorkspace = async () => (await import("./workspaceFiles")).exportActiveWorkspace(core)
  const privateRecoveryUnavailableReason = computed(() => {
    void core.tincanban.docVersion.value
    return core.tincanban.getCurrentProfile()?.privateKeys.identityPrivateKey
      ? ""
      : "Create a full backup on your original device. You can inspect and restore backups here."
  })
  const createPrivateRecovery = async () => (await import("./workspaceHistoryRecovery")).createPrivateWorkspaceRecovery(core)
  const inspectPrivateRecovery = async (file: Blob, words: string) =>
    (await import("./workspaceHistoryRecovery")).inspectPrivateWorkspaceRecovery(file, words)
  const restorePrivateRecovery = async (inspection: { workspaceId: string; personId: string; coverage: "complete" | "incomplete"; missingCount: number }, replace: boolean) =>
    (await import("./workspaceHistoryRecovery")).restorePrivateWorkspaceRecovery(core, inspection, replace)
  const hasWorkspaceCopy = (workspaceId: string) => core.tincanban.availableWorkspaces.value.some(workspace => workspace.id === workspaceId)
  const workspaceTitle = (workspaceId: string) => core.tincanban.availableWorkspaces.value.find(workspace => workspace.id === workspaceId)?.title ?? "Recovered workspace"
  const workspaceImportState = ref({ busy: false, error: "" })
  const openImport = () => { workspaceImportState.value.error = ""; core.importInput.value?.click() }
  const importWorkspace = async (event: Event) => {
    try { await (await import("./workspaceFiles")).importWorkspaceFile(core, event, workspaceImportState.value) }
    catch (error) { workspaceImportState.value.error = messageFrom(error) }
  }
  const createAndSyncWorkspace = (title: string, preset: Preset) =>
    createWorkspaceWithOwnerCredential(core, title, preset)
  const handleCreateWorkspace = async (payload: { title: string; preset: Preset; config?: WorkspaceCreationDraft }) => {
    const doc = await core.tincanban.createWorkspaceAsync(payload.title, payload.preset, undefined, payload.config)
    recordUsageAction("workspace_create")
    core.notice.value = `Workspace "${payload.title}" created`
    core.showWorkspaces.value = false
    try { await core.sync.addOwnerWorkspace(doc.id) }
    catch (error) { core.notice.value = `Workspace created; sync setup failed: ${messageFrom(error)}` }
  }
  const handleSwitchWorkspace = async (id: string) => { await core.tincanban.switchWorkspace(id); core.notice.value = "Switched workspace" }
  const handleRenameWorkspace = async (payload: { id: string; title: string }) => { await core.tincanban.renameWorkspaceAsync(payload.id, payload.title); core.notice.value = `Workspace renamed to "${payload.title}"` }
  const handleArchiveWorkspace = async (id: string) => {
    const fallback = await core.tincanban.archiveWorkspaceAsync(id)
    if (fallback) await core.sync.addOwnerWorkspace(fallback.id)
    core.notice.value = "Workspace archived"
  }
  const handleRestoreWorkspace = async (id: string) => {
    await core.tincanban.restoreWorkspaceAsync(id)
    core.notice.value = "Workspace restored"
  }
  return { exportWorkspace, createPrivateRecovery, privateRecoveryUnavailableReason, inspectPrivateRecovery, restorePrivateRecovery, hasWorkspaceCopy, workspaceTitle,
    openImport, importWorkspace, workspaceImportState, createAndSyncWorkspace, handleCreateWorkspace, handleSwitchWorkspace,
    handleRenameWorkspace, handleArchiveWorkspace, handleRestoreWorkspace }
}

async function createWorkspaceWithOwnerCredential(core: ReturnType<typeof useAppCore>, title: string,
  preset: Preset) {
  const doc = await core.tincanban.createWorkspaceAsync(title, preset)
  await core.sync.addOwnerWorkspace(doc.id)
  return doc
}


function reportArchiveFailure(core: ReturnType<typeof useAppCore>, error: unknown) {
  core.archiveError.value = `Archive failed: ${messageFrom(error)}`
  core.notice.value = core.archiveError.value
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "try again"
}
