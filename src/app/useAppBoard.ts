import { columnColors } from "../domain/columnColors"
import { computed, nextTick, watch } from "vue"
import type { useAppCore } from "./useAppCore"
import { useBoardDragController } from "./useBoardDrag"
import { activeFilterCount, defaultBoardFilters, matchesItemFilters } from "../filters"
import { isArchiveColumn, isItemArchived } from "../domain/archive"
import { projectEntityHistory } from "../domain/history"
import { isItem, type AttachedDocument, type Item } from "../domain/model"
import { configuredCardFields, narrativeFieldId } from "../domain/cardPresentation"
import type { WorkspaceDocumentV2 } from "../domain/entitySchemas"
import { orderItemsByPriority, projectItemPriority } from "../domain/priority"
import { itemNarrative } from "../domain/narrative"
import type { PeerHistoryRemoteRead } from "../sync/workspacePeerHistoryRecoverySources"
import type { PeerHistoryBaselineDescriptor } from "../sync/workspaceSetHistory"
import { useArchivedItemHistory } from "./useArchivedItemHistory"

export type AppBoardContext = Pick<ReturnType<typeof useAppCore>,
  | "tincanban"
  | "search" | "filters" | "isEditingBoard" | "itemFormParentId"
  | "boardRef" | "movedItemId" | "movedColumnId" | "onlineWorkspaceDevices"
  | "canEditItems" | "canEditBoard" | "notice" | "archiveUndo" | "boardRenderKey"
  | "selectedItemId" | "editingItemId" | "itemToMove" | "detailDialog"
  | "quickNoteDraft" | "quickNoteError"
> & { sync?: { fetchHistoryObject: PeerHistoryRemoteRead
  fetchHistoryBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  fetchHistoryDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined> } }

export function useAppBoard(core: AppBoardContext) {
  const presentation = useBoardPresentation(core)
  const drag = useBoardDragController(core, presentation)
  const selection = useBoardSelection(core)
  return { ...presentation, ...drag, ...selection }
}

function useBoardPresentation(core: AppBoardContext) {
  const { tincanban, search, filters, isEditingBoard, itemFormParentId, boardRef, movedItemId, movedColumnId } = core
  const workspaceLabel = computed(() => tincanban.activeWorkspace.title)
  const entityName = computed(() => tincanban.activeBoard.value?.entityName || "item")
  const addItemLabel = computed(() => `+ Add ${entityName.value}`)
  const columnStatus = (columnId: string): string | null => isArchiveColumn(tincanban.genericColumns.value.find(column => column.id === columnId) ?? { id: columnId }, tincanban.activeBoard.value ?? undefined) ? "archived" : null
  const colors = computed(() => columnColors(tincanban.genericColumns.value))
  const columnColor = (id: string) => colors.value.get(id)
  const itemFormColumns = computed(() => tincanban.genericColumns.value.filter(column => !isArchiveColumn(column)))
  const itemFormParentValue = computed(() => itemFormParentId.value)
  const computedItemFieldIds = computed(() => {
    const policy = tincanban.activeBoard.value?.priorityPolicy
    return policy?.evaluator === "weighted-rules-v1" ? [policy.priorityFieldId, policy.fitFieldId].filter((id): id is string => Boolean(id)) : []
  })
  const notesByItem = computed(() => {
    void tincanban.docVersion.value
    const notes = new Map<string, AttachedDocument[]>()
    for (const entity of Object.values(tincanban.getActiveDoc()?.entities ?? {})) {
      if (entity.kind !== "document" || entity.documentKind !== "note" || entity.archivedAt || !entity.placement.parentId) continue
      const attached = notes.get(entity.placement.parentId) ?? []
      attached.push(entity)
      notes.set(entity.placement.parentId, attached)
    }
    return notes
  })
  const searchableTextByItem = computed(() => {
    void tincanban.docVersion.value
    return searchableItemTextById(
      tincanban.getActiveDoc() ?? undefined,
      notesByItem.value,
      textNotesFieldId(),
    )
  })
  const normalizedSearch = computed(() => search.value.trim().toLowerCase())
  const textNotesFieldId = () => narrativeFieldId(tincanban.activeBoard.value, tincanban.boardFields.value)
  const narrativeForCard = computed(() => {
    void tincanban.docVersion.value
    const notes = notesByItem.value
    const notesFieldId = textNotesFieldId()
    return cachedItemProjection(item => itemNarrative(item, notesFieldId, notes.get(item.id) ?? []))
  })
  const cardSummaryFields = (item: Item) => configuredCardFields(item, tincanban.boardFields.value, tincanban.activeBoard.value?.cardPresentation?.summaryFieldIds ?? [])
  const fieldsForCard = computed(() => {
    void tincanban.docVersion.value
    const fields = tincanban.boardFields.value
    return cachedItemProjection(item => configuredCardFields(item, fields))
  })
  const cardNotes = (item: Item) => narrativeForCard.value(item)
  const cardFields = (item: Item) => fieldsForCard.value(item)
  // Priority depends on workspace data, never on the current search query.
  // Filtering an already ordered column preserves its stable priority order.
  const orderedItemsByColumn = computed(() => {
    const board = tincanban.activeBoard.value
    const notesFieldId = textNotesFieldId()
    return new Map(tincanban.genericColumns.value.map(column => [column.id, orderItemsByPriority(board, column.items, notesFieldId)]))
  })
  const itemsByColumn = computed(() => {
    const query = normalizedSearch.value
    const activeFilters = filters.value
    const searchable = query ? searchableTextByItem.value : null
    return new Map([...orderedItemsByColumn.value].map(([columnId, items]) => [columnId, items.filter(item => {
      const matchesSearch = !query || searchable?.get(item.id)?.text.includes(query) === true
      return matchesSearch && matchesItemFilters(item, columnId, activeFilters)
    })]))
  })
  const itemsForColumn = (column: { id: string; items: Item[] }) => itemsByColumn.value.get(column.id) ?? []
  const totalItems = computed(() => tincanban.genericColumns.value.reduce((total, column) => total + column.items.length, 0))
  const visibleItems = computed(() => tincanban.genericColumns.value.reduce((total, column) => total + itemsForColumn(column).length, 0))
  const hasFilters = computed(() => Boolean(search.value.trim()) || activeFilterCount(filters.value) > 0)
  const filteredResultsChanged = computed(() => filteredBoardResultsChanged(
    tincanban.genericColumns.value, orderedItemsByColumn.value, itemsByColumn.value,
  ))
  const expandFilteredCards = computed(() => hasFilters.value && (filteredResultsChanged.value || Boolean(filters.value.columnId)))
  const cardNoteSearchMatch = (item: Item) => cardNoteSearchMatchFor(item, normalizedSearch.value, searchableTextByItem.value)
  const workspacePresenceSummary = computed(() => summarizeWorkspace(totalItems.value, visibleItems.value, tincanban.workspace.documents.length + tincanban.workspace.artifacts.length, core.onlineWorkspaceDevices.value, hasFilters.value))
  const visibleColumns = computed(() => visibleBoardColumns(tincanban.genericColumns.value, hasFilters.value, isEditingBoard.value, filters.value.columnId, itemsForColumn))
  const clearFilters = () => { search.value = ""; filters.value = defaultBoardFilters() }
  let scrolledBoard: HTMLElement | null = null
  let boardScrollLeft = 0
  watch(() => visibleColumns.value.map(column => column.id).join("|"), () => {
    // Capture before Vue patches columns; the scroll event may still be queued.
    scrolledBoard = boardRef.value
    boardScrollLeft = scrolledBoard?.scrollLeft ?? 0
  }, { flush: "pre" })
  const trackBoardScroll = () => {
    scrolledBoard = boardRef.value
    boardScrollLeft = scrolledBoard?.scrollLeft ?? 0
  }
  const resetBoardScroll = () => {
    // Reading geometry or calling scrollTo after a filter patch forces layout.
    // Scroll events already tell us whether this board needs resetting.
    if (scrolledBoard === boardRef.value && boardScrollLeft !== 0) {
      boardRef.value?.scrollTo({ left: 0, behavior: "instant" })
      boardScrollLeft = 0
    }
  }
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  const highlightMoved = (entityId: string, kind: "item" | "column") => {
    if (highlightTimer) clearTimeout(highlightTimer)
    if (kind === "item") movedItemId.value = entityId
    else movedColumnId.value = entityId
    highlightTimer = setTimeout(() => { movedItemId.value = null; movedColumnId.value = null }, 700)
  }
  const clearHighlightTimer = () => { if (highlightTimer) clearTimeout(highlightTimer) }
  return { workspaceLabel, entityName, addItemLabel, itemFormColumns, itemFormParentValue, computedItemFieldIds, cardNotes, cardFields, cardSummaryFields, cardNoteSearchMatch, columnColor, columnStatus, itemsForColumn, totalItems, visibleItems, hasFilters, expandFilteredCards, workspacePresenceSummary, visibleColumns, clearFilters, trackBoardScroll, resetBoardScroll, highlightMoved, clearHighlightTimer }
}

function searchableItemTextById(
  doc: WorkspaceDocumentV2 | undefined,
  notes: Map<string, AttachedDocument[]>,
  notesFieldId: string | undefined,
) {
  const searchable = new Map<string, { text: string; narrative: string; narrativeOffset: number }>()
  if (!doc) return searchable
  for (const entity of Object.values(doc.entities)) {
    if (!isItem(entity)) continue
    const narrative = itemNarrative(entity, notesFieldId, notes.get(entity.id) ?? [])
    const fieldText = Object.values(entity.values).filter(value => value !== null).join(" ")
    const searchableNarrative = narrative.toLowerCase()
    const prefix = `${entity.title} `
    const searchablePrefix = prefix.toLowerCase()
    searchable.set(entity.id, {
      narrative: searchableNarrative,
      narrativeOffset: searchablePrefix.length,
      text: `${searchablePrefix}${searchableNarrative} ${fieldText.toLowerCase()}`,
    })
  }
  return searchable
}

function cachedItemProjection<T>(project: (item: Item) => T) {
  // Detail and board can hold different immutable revisions of the same ID.
  const cache = new WeakMap<Item, T>()
  return (item: Item): T => {
    if (!cache.has(item)) cache.set(item, project(item))
    return cache.get(item)!
  }
}

function filteredBoardResultsChanged(columns: Array<{ id: string }>, ordered: ReadonlyMap<string, Item[]>, visible: ReadonlyMap<string, Item[]>) {
  return columns.some(column => {
    const allItems = ordered.get(column.id) ?? []
    const visibleItems = visible.get(column.id) ?? []
    return allItems.length !== visibleItems.length || allItems.some((item, index) => visibleItems[index]?.id !== item.id)
  })
}

function cardNoteSearchMatchFor(
  item: Item,
  query: string,
  searchable: ReadonlyMap<string, { text: string; narrative: string; narrativeOffset: number }>,
) {
  if (query.length < 3) return null
  const indexed = searchable.get(item.id)
  if (!indexed) return null
  const match = indexed.text.indexOf(query, indexed.narrativeOffset)
  const narrativeEnd = indexed.narrativeOffset + indexed.narrative.length
  return match >= indexed.narrativeOffset && match + query.length <= narrativeEnd ? { query, index: match - indexed.narrativeOffset } : null
}

function summarizeWorkspace(totalItems: number, visibleItems: number, totalDocuments: number, devices: number, hasFilters: boolean) {
  const cards = hasFilters ? `${visibleItems} of ${totalItems} cards` : `${totalItems} ${totalItems === 1 ? "card" : "cards"}`
  const docs = `${totalDocuments} ${totalDocuments === 1 ? "doc" : "docs"}`
  return `${cards} · ${docs} · ${devices} ${devices === 1 ? "device" : "devices"}`
}

function visibleBoardColumns(columns: ReturnType<typeof useAppCore>["tincanban"]["genericColumns"]["value"], hasFilters: boolean, isEditing: boolean, selectedColumnId: string | undefined, itemsForColumn: (column: { id: string; items: Item[] }) => Item[]) {
  if (!hasFilters || isEditing) return columns
  if (selectedColumnId) return columns.filter(column => column.id === selectedColumnId)
  return columns.filter(column => itemsForColumn(column).length > 0)
}

function useBoardSelection(core: AppBoardContext) {
  const archiveHistory = useArchivedItemHistory(core)
  const selectedItem = computed(() => readSelectedItem(core))
  const subitemsForSelectedItem = computed(() => selectedItem.value ? readSubitems(core, selectedItem.value.id) : [])
  const selectedItemHistory = computed(() => {
    void core.tincanban.docVersion.value
    const doc = core.tincanban.getActiveDoc()
    const active = doc && archiveHistory.selectedHistoryItemId.value ? projectEntityHistory(doc, archiveHistory.selectedHistoryItemId.value) : []
    const activeHashes = new Set(active.map(entry => entry.hash))
    return [...archiveHistory.archivedItemHistory.value.filter(entry => !activeHashes.has(entry.hash))
      .sort((left, right) => left.time - right.time || left.hash.localeCompare(right.hash)), ...active]
  })
  const editingItem = computed(() => core.editingItemId.value ? readItem(core, core.editingItemId.value) : null)
  const candidateParentsForMove = computed(() => itemParents(core))
  watch(core.selectedItemId, async itemId => { if (itemId) { await nextTick(); core.detailDialog.value?.focus() } })
  watch(core.selectedItemId, () => { core.quickNoteDraft.value = ""; core.quickNoteError.value = "" })
  return { selectedItem, subitemsForSelectedItem, selectedItemHistory, editingItem, candidateParentsForMove, ...archiveHistory }
}

function readSelectedItem(core: AppBoardContext) {
  void core.tincanban.docVersion.value
  return core.selectedItemId.value ? readItem(core, core.selectedItemId.value) : null
}

function readItem(core: AppBoardContext, id: string) {
  const entity = core.tincanban.getPresentedWorkspaceDoc()?.entities[id]
  return isItem(entity) ? projectItemPriority(core.tincanban.activeBoard.value, entity,
    narrativeFieldId(core.tincanban.activeBoard.value, core.tincanban.boardFields.value)) : null
}

function readSubitems(core: AppBoardContext, parentId: string) {
  const doc = core.tincanban.getActiveDoc()
  return doc ? Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && entity.placement.parentId === parentId && !isItemArchived(entity)) : []
}

function itemParents(core: AppBoardContext) {
  const current = core.itemToMove.value
  const doc = core.tincanban.getActiveDoc()
  return current && doc ? Object.values(doc.entities).filter((entity): entity is Item => isItem(entity) && entity.id !== current.id && !isItemArchived(entity)).map(item => ({ id: item.id, title: item.title })) : []
}
