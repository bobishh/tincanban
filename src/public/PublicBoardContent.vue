<script setup lang="ts">
import { computed, defineAsyncComponent, ref, type Component } from "vue"
import { defaultBoardFilters, activeFilterCount } from "../filters"
import { publicBoardView, type PublicColumn, type PublicItem } from "./publicBoardView"
import type { PublicBoardProjection } from "./publicSchema"
import { usePublicCardAges } from "./publicCardAges"
import { publicDiscussionView, publicItemDocuments, publicReferenceItem } from "./publicDiscussions"
import { itemNarrative } from "../domain/narrative"
import { cardStageButtons } from "../domain/cardStageButtons"
import { useColumnCollapse } from "../ui/useColumnCollapse"
import BoardSurface from "../components/BoardSurface.vue"
import TincanbanPageLayout from "../components/TincanbanPageLayout.vue"
import TincanbanHeading from "../components/TincanbanHeading.vue"
import BoardToolbar from "../components/BoardToolbar.vue"
const ItemDetailDialog = defineAsyncComponent<Component>(() => import("../components/ItemDetailDialog.vue"))
const LeadDetailWindow = defineAsyncComponent<Component>(() => import("../components/LeadDetailWindow.vue"))
const ItemDocuments = defineAsyncComponent<Component>(() => import("../components/ItemDocuments.vue"))
const WorkspaceChat = defineAsyncComponent<Component>(() => import("../components/WorkspaceChat.vue"))

const props = defineProps<{ projection: PublicBoardProjection; fileUrl: (hash: string) => string }>()
const view = computed(() => publicBoardView(props.projection))
const discussions = computed(() => publicDiscussionView(props.projection))
const scope = computed(() => discussions.value.scope)
const search = ref("")
const filters = ref(defaultBoardFilters())
const selectedId = ref<string | null>(null)
const conversation = ref<{ targetId: string; messageId?: string; rootId?: string } | null>(null)
const selected = computed(() => view.value.items.find(item => item.id === selectedId.value) ?? null)
const selectedLead = computed(() => selected.value ? view.value.leads.get(selected.value.id) : undefined)
const hasFilters = computed(() => Boolean(search.value.trim()) || activeFilterCount(filters.value) > 0)
const { isCollapsed, toggle } = useColumnCollapse(() => `public:${props.projection.board.id}`, () => hasFilters.value)
const cardAgeFor = usePublicCardAges(() => view.value.board.cardAgingPolicy)
const entityName = computed(() => view.value.board.entityName || (view.value.board.preset?.key === "job-search" ? "lead" : "item"))
const workspaceLabel = computed(() => view.value.board.title.toLowerCase() === "job search" ? "jobs" : view.value.board.title)
const filteredItems = computed(() => {
  const query = search.value.trim().toLowerCase()
  return new Map(view.value.columns.map(column => [column.id, column.items.filter(item => {
    const values = view.value.fields.map(field => field.valueType === "select" ? field.options[String(item.values[field.id])]?.title ?? "" : item.values[field.id]).join(" ")
    return (!query || `${item.title}\n${item.body}\n${values}`.toLowerCase().includes(query)) && matchesFilters(item, column.id)
  })]))
})
const itemsForColumn = (column: { id: string }) => filteredItems.value.get(column.id) ?? []
const visibleColumns = computed(() => !hasFilters.value ? view.value.columns : view.value.columns.filter(column => filters.value.columnId ? column.id === filters.value.columnId : itemsForColumn(column).length > 0))
const totalItems = computed(() => view.value.columns.reduce((total, column) => total + column.items.length, 0))
const visibleItems = computed(() => [...filteredItems.value.values()].reduce((total, items) => total + items.length, 0))
const columnStatus = (id: string) => Object.entries(view.value.board.preset?.bindings ?? {}).find(([key, value]) => key.startsWith("status.") && value === id)?.[0].slice(7) ?? null
function matchesFilters(item: PublicItem, columnId: string): boolean {
  if (filters.value.columnId && filters.value.columnId !== columnId) return false
  return matchesFieldSelections(item) && matchesRanges(item, filters.value.numberRanges, "number") && matchesRanges(item, filters.value.dateRanges, "date")
}
function matchesFieldSelections(item: PublicItem): boolean {
  return Object.entries(filters.value.fieldValues).every(([fieldId, expected]) => {
    if (!expected) return true
    const actual = item.values[fieldId]
    return expected === "__true" ? actual === true : expected === "__false" ? actual === false : actual === expected
  })
}
function matchesRanges(item: PublicItem, ranges: Record<string, { min: string; max: string }>, kind: "number" | "date"): boolean {
  return Object.entries(ranges).every(([fieldId, range]) => {
    if (!range.min && !range.max) return true
    const value = item.values[fieldId]
    if (kind === "number") return typeof value === "number" && (!range.min || value >= Number(range.min)) && (!range.max || value <= Number(range.max))
    return typeof value === "string" && (!range.min || value >= range.min) && (!range.max || value <= range.max)
  })
}
function clearFilters() { search.value = ""; filters.value = defaultBoardFilters() }
function open(item: PublicItem, event?: MouseEvent) {
  const target = event?.target
  if (target instanceof Element && target.closest("a, input, textarea")) return
  selectedId.value = item.id
}
function cardFields(item: PublicItem) {
  const summary = view.value.leads.has(item.id) ? ["company", "role", "priority", "location", "fitScore"].map(name => view.value.board.preset?.bindings[`field.${name}`]) : []
  return view.value.fields.flatMap(field => {
    const value = item.values[field.id]
    if (summary.includes(field.id) || value === null || value === undefined || value === "") return []
    const label = field.valueType === "select" ? field.options[String(value)]?.title : typeof value === "boolean" ? value ? "Yes" : "No" : String(value)
    return label ? [{ id: field.id, title: field.title, value: label }] : []
  })
}
function cardPresentation(item: PublicItem, column: PublicColumn) {
  const age = cardAgeFor(item, column)
  return { lead: view.value.leads.get(item.id), notes: item.body, fields: cardFields(item),
    showFields: hasFilters.value, discussion: discussions.value.cardDiscussions.get(item.id), moved: false,
    ageLevel: age?.level, ageLabel: age?.label }
}
function openDiscussion(itemId: string) { conversation.value = { targetId: itemId } }
function openMessageThread(messageId: string) {
  const thread = discussions.value.threadWindow(messageId)
  if (thread) conversation.value = { targetId: thread.targetId, messageId, rootId: thread.rootId ?? undefined }
}
const chatMessages = computed(() => {
  const active = conversation.value
  if (!active) return []
  if (active.rootId) return discussions.value.messages({ targetId: active.targetId, rootId: active.rootId })
  if (active.messageId) return discussions.value.allMessages.filter(message => message.id === active.messageId)
  return discussions.value.messages({ targetId: active.targetId, rootId: null })
})
const chatWindowId = computed(() => conversation.value?.rootId ? `conversation:${conversation.value.rootId}` : `public:${conversation.value?.targetId ?? "board"}`)
const boardDocuments = computed(() => publicItemDocuments(props.projection, view.value.board.id))
const selectedDocuments = computed(() => selected.value ? publicItemDocuments(props.projection, selected.value.id) : [])
const selectedSubitems = computed(() => selected.value ? view.value.items.filter(item => item.placement.parentId === selected.value?.id) : [])
const notesFieldId = computed(() => view.value.board.preset?.bindings["field.notes"])
const selectedNarrative = computed(() => selected.value ? itemNarrative(selected.value, notesFieldId.value) : "")
const noOpMove = async () => undefined
const noOpSaveDocument = async () => undefined
const noOpUpdateDocument = async () => undefined
function readPublicFile(file: { type: string; sha256?: string }) {
  if (file.type !== "blob" || !file.sha256) return Promise.resolve(undefined)
  return fetch(props.fileUrl(file.sha256), { cache: "no-store" }).then(async response => response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined)
}
function documentUrl(document: { file?: { sha256?: string } | null }) {
  return document.file?.sha256 ? props.fileUrl(document.file.sha256) : "#"
}
function openReference(anchor: Parameters<typeof discussions.value.referenceCard>[0]) {
  const id = publicReferenceItem(anchor, scope.value, props.projection.board.id, view.value.items, view.value.fields)
  if (id) { conversation.value = null; selectedId.value = id }
}
</script>

<template>
  <TincanbanPageLayout>
    <template #header>
      <div class="brand"><span class="brand-presence"><span class="brand-mark is-empty" title="Read-only board"><svg viewBox="0 0 64 80" role="img" aria-label="Read-only board"><use href="/logo.svg?v=4#can-logo" /></svg></span></span><div><TincanbanHeading :label="workspaceLabel" /></div></div>
      <div class="top-actions"><button class="button button-quiet" type="button" aria-label="Workspace chat" @click="conversation = { targetId: view.board.id }">Chat</button></div>
    </template>
    <BoardToolbar v-model:search="search" v-model:filters="filters" :columns="view.columns" :fields="view.fields" :placeholder="view.board.preset?.key === 'job-search' ? 'Search company, role, notes' : 'Search cards'">
      <span class="save-state">{{ hasFilters ? `${visibleItems} of ${totalItems}` : totalItems }} cards</span>
    </BoardToolbar>
    <div v-if="hasFilters" class="filter-summary" aria-live="polite"><span>{{ visibleItems ? 'Showing matching cards' : 'No matching cards' }}</span><button class="button button-small button-quiet" type="button" @click="clearFilters">Clear search and filters</button></div>
    <BoardSurface :columns="visibleColumns" :items-for-column="itemsForColumn" :column-color="id => view.columns.find(column => column.id === id)?.color" :column-status="columnStatus" :is-column-collapsed="isCollapsed" :has-filters="hasFilters" :entity-name="entityName" :board-title="view.board.title" :card-presentation="cardPresentation" @toggle-column="toggle" @open="open" @select="open" @discuss="openDiscussion">
      <template #empty><div v-if="hasFilters && !visibleColumns.length" class="board-empty">Try another search or clear filters to see all cards.</div></template>
    </BoardSurface>
    <ItemDocuments :documents="boardDocuments" :read-only="true" :read-file="readPublicFile" :download-url="documentUrl" :save="noOpSaveDocument" :update="noOpUpdateDocument" />

    <LeadDetailWindow v-if="selected && selectedLead" :lead="selectedLead" :item="selected" :board="view.board" :columns="view.columns" :workspace-id="scope" :read-only="true" :narrative="selectedNarrative" :move="noOpMove" @close="selectedId = null">
      <template #primary><ItemDocuments :documents="selectedDocuments" :workspace-id="scope" :read-only="true" :read-file="readPublicFile" :download-url="documentUrl" :save="noOpSaveDocument" :update="noOpUpdateDocument" /></template>
    </LeadDetailWindow>
    <ItemDetailDialog v-else-if="selected" :workspace-id="scope" :item="selected" :columns="view.columns" :card-stage-buttons="cardStageButtons(view.board, view.columns)" :read-only="true" :move-to-column="noOpMove" :narrative="selectedNarrative" :narrative-field-id="notesFieldId" :subitems="selectedSubitems" :fields="view.fields" :documents="selectedDocuments" :save-document="noOpSaveDocument" :update-document="noOpUpdateDocument" :quick-note="''" @close="selectedId = null">
      <template #documents><ItemDocuments :documents="selectedDocuments" :workspace-id="scope" :read-only="true" :read-file="readPublicFile" :download-url="documentUrl" :save="noOpSaveDocument" :update="noOpUpdateDocument" /></template>
    </ItemDetailDialog>
    <WorkspaceChat v-if="conversation" :key="chatWindowId" :read-only="true" :workspace-id="scope" :workspace-scope="scope" :window-id="chatWindowId" :title="conversation.rootId ? 'Discussion' : conversation.targetId === view.board.id ? 'Board discussion' : 'Discussion'" :field-titles="discussions.fieldTitles" :reference-choices="discussions.referenceChoices" :all-messages="discussions.allMessages" :messages="chatMessages" :target-id="conversation.messageId" :workspace-title="view.board.title" :current-person-id="''" :sending="false" :error="''" :loading="false" :connected="false" :typing-people="[]" @close="conversation = null" @reference="openReference" @thread="openMessageThread" />
  </TincanbanPageLayout>
</template>
