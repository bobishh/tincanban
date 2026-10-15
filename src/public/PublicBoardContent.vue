<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch, type Component } from "vue"
import { columnColors } from "../domain/columnColors"
import { defaultBoardFilters, activeFilterCount } from "../filters"
import { publicBoardView, type PublicColumn, type PublicItem } from "./publicBoardView"
import type { PublicBoardProjection } from "./publicSchema"
import { usePublicCardAges } from "./publicCardAges"
import TincanbanPageLayout from "../components/TincanbanPageLayout.vue"
import TincanbanHeading from "../components/TincanbanHeading.vue"
import BoardToolbar from "../components/BoardToolbar.vue"
import BoardItemCard from "../components/BoardItemCard.vue"
import { MarkdownContent } from "../ui/markdownContent"
import PublicBoardColumns from "./PublicBoardColumns.vue"
import PublicFiles from "./PublicFiles.vue"
import ModalLayer from "../components/ModalLayer.vue"

const PublicBoardChat = defineAsyncComponent<Component>(() => import("./PublicBoardChat.vue"))

const props = defineProps<{ projection: PublicBoardProjection; fileUrl: (hash: string) => string }>()
const view = computed(() => publicBoardView(props.projection))
const search = ref("")
const filters = ref(defaultBoardFilters())
const selectedId = ref<string | null>(null)
const conversation = ref<string | null>(null)
const selected = computed(() => view.value.items.find(item => item.id === selectedId.value) ?? null)
const selectedLead = computed(() => selected.value ? view.value.leads.get(selected.value.id) : undefined)
const hasFilters = computed(() => Boolean(search.value.trim()) || activeFilterCount(filters.value) > 0)
const colors = computed(() => columnColors(view.value.columns))
const collapsed = ref<Record<string, boolean>>({})
watch(() => props.projection.board.id, id => {
  try { collapsed.value = JSON.parse(localStorage.getItem(`tincanban:collapsed-columns:public:${id}`) || "{}") as Record<string, boolean> }
  catch { collapsed.value = {} }
}, { immediate: true })
const isCollapsed = (column: PublicColumn) => Boolean(column.collapsible && !hasFilters.value && collapsed.value[column.id])
function toggle(column: PublicColumn) {
  if (!column.collapsible) return
  collapsed.value = { ...collapsed.value, [column.id]: !isCollapsed(column) }
  try { localStorage.setItem(`tincanban:collapsed-columns:public:${props.projection.board.id}`, JSON.stringify(collapsed.value)) }
  catch { /* Local collapse state is a convenience. */ }
}
const cardAgeFor = usePublicCardAges(() => view.value.board.cardAgingPolicy)
const entityName = computed(() => view.value.board.entityName || (view.value.board.preset?.key === "job-search" ? "lead" : "item"))
const workspaceLabel = computed(() => view.value.board.title.toLowerCase() === "job search" ? "jobs" : view.value.board.title)
const itemsByColumn = computed(() => {
  const query = search.value.trim().toLowerCase()
  return new Map(view.value.columns.map(column => [column.id, column.items.filter(item => {
    const values = view.value.fields.map(field => field.valueType === "select" ? field.options[String(item.values[field.id])]?.title ?? "" : item.values[field.id]).join(" ")
    return (!query || `${item.title}\n${item.body}\n${values}`.toLowerCase().includes(query)) && matchesPublicFilters(item, column.id)
  })]))
})
const itemsForColumn = (column: { id: string }) => itemsByColumn.value.get(column.id) ?? []
const visibleColumns = computed(() => !hasFilters.value ? view.value.columns : view.value.columns.filter(column => filters.value.columnId ? column.id === filters.value.columnId : itemsForColumn(column).length > 0))
const totalItems = computed(() => view.value.columns.reduce((total, column) => total + column.items.length, 0))
const visibleItems = computed(() => [...itemsByColumn.value.values()].reduce((total, items) => total + items.length, 0))
const columnStatus = (id: string) => Object.entries(view.value.board.preset?.bindings ?? {}).find(([key, value]) => key.startsWith("status.") && value === id)?.[0].slice(7) ?? null
function matchesPublicFilters(item: PublicItem, columnId: string): boolean {
  if (filters.value.columnId && filters.value.columnId !== columnId) return false
  return matchesPublicFieldSelections(item) && matchesPublicRanges(item, filters.value.numberRanges, "number") &&
    matchesPublicRanges(item, filters.value.dateRanges, "date")
}
function matchesPublicFieldSelections(item: PublicItem): boolean {
  return Object.entries(filters.value.fieldValues).every(([fieldId, expected]) => {
    if (!expected) return true
    const actual = item.values[fieldId]
    return expected === "__true" ? actual === true : expected === "__false" ? actual === false : actual === expected
  })
}
function matchesPublicRanges(item: PublicItem, ranges: Record<string, { min: string; max: string }>, kind: "number" | "date"): boolean {
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
function fieldsFor(item: PublicItem) {
  const summary = view.value.leads.has(item.id) ? ["company", "role", "priority", "location", "fitScore"].map(name => view.value.board.preset?.bindings[`field.${name}`]) : []
  return view.value.fields.flatMap(field => {
    const value = item.values[field.id]
    if (summary.includes(field.id) || value === null || value === undefined || value === "") return []
    const label = field.valueType === "select" ? field.options[String(value)]?.title : typeof value === "boolean" ? value ? "Yes" : "No" : String(value)
    return label ? [{ id: field.id, title: field.title, value: label }] : []
  })
}
function discussionFor(item: PublicItem) {
  const messages = props.projection.discussions.filter(message => message.targets.some(target => target.type === "card" && target.id === item.id || target.cardId === item.id))
  return messages.length ? { count: messages.length, messageId: messages.at(-1)?.id } : undefined
}
</script>
<template>
  <TincanbanPageLayout>
    <template #header>
      <div class="brand"><span class="brand-presence"><span class="brand-mark is-empty" title="Read-only board"><svg viewBox="0 0 64 80" role="img" aria-label="Read-only board"><use href="/logo.svg?v=4#can-logo" /></svg></span></span><div><TincanbanHeading :label="workspaceLabel" /></div></div>
      <div class="top-actions"><button class="button button-quiet" type="button" aria-label="Workspace chat" @click="conversation = view.board.id">Chat</button></div>
    </template>
    <BoardToolbar v-model:search="search" v-model:filters="filters" :columns="view.columns" :fields="view.fields" :placeholder="view.board.preset?.key === 'job-search' ? 'Search company, role, notes' : 'Search cards'">
      <span class="save-state">{{ hasFilters ? `${visibleItems} of ${totalItems}` : totalItems }} cards</span>
    </BoardToolbar>
    <div v-if="hasFilters" class="filter-summary" aria-live="polite"><span>{{ visibleItems ? 'Showing matching cards' : 'No matching cards' }}</span><button class="button button-small button-quiet" type="button" @click="clearFilters">Clear search and filters</button></div>
    <section class="board" :class="{ 'board-filtered': hasFilters, 'board-single-column': visibleColumns.length === 1 }" role="region" :aria-label="view.board.title">
      <PublicBoardColumns :columns="visibleColumns" :items-for-column="itemsForColumn" :column-color="id => colors.get(id)" :column-status="columnStatus" :is-collapsed="isCollapsed" :has-filters="hasFilters" :entity-name="entityName" @toggle="toggle">
        <template #card="{ item, column }">
          <BoardItemCard :item="item" :lead="view.leads.get(item.id)" :notes="item.body" :fields="fieldsFor(item)" :has-filters="hasFilters" :show-fields="hasFilters" :can-edit-items="false" :moved="false" :discussion="discussionFor(item)" @discuss="conversation = $event" :age-level="cardAgeFor(item, column)?.level" :age-label="cardAgeFor(item, column)?.label" @open="open" @select="open" />
        </template>
      </PublicBoardColumns>
      <div v-if="hasFilters && !visibleColumns.length" class="board-empty">Try another search or clear filters to see all cards.</div>
    </section>
    <PublicFiles :files="projection.files.filter(file => file.parentId === view.board.id)" :file-url="fileUrl" />
    <ModalLayer v-if="selected" @close="selectedId = null">
    <section class="public-item-detail" role="dialog" aria-modal="true" :aria-label="`${selected.title} details`">
      <header><div><span class="eyebrow">Read-only card</span><h2>{{ selected.title }}</h2></div><button class="button button-small" type="button" aria-label="Close card details" @click="selectedId = null">Close</button></header>
      <MarkdownContent class="public-item-narrative" :source="selected.body" />
      <dl v-if="selectedLead" class="detail-grid"><div><dt>Role</dt><dd>{{ selectedLead.role || '—' }}</dd></div><div><dt>Priority</dt><dd>{{ selectedLead.priority || '—' }}</dd></div><div><dt>Fit</dt><dd>{{ selectedLead.fitScore ?? '—' }}</dd></div><div><dt>Location</dt><dd>{{ selectedLead.location || '—' }}</dd></div><div><dt>Work mode</dt><dd>{{ selectedLead.workMode || '—' }}</dd></div></dl>
      <dl v-if="fieldsFor(selected).length" class="card-fields"><div v-for="field in fieldsFor(selected)" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ field.value }}</dd></div></dl>
      <a v-if="selectedLead?.url && /^https?:\/\//i.test(selectedLead.url)" class="source-link" :href="selectedLead.url" target="_blank" rel="noreferrer">Open job source ↗</a>
      <PublicFiles :files="projection.files.filter(file => file.parentId === selectedId)" :file-url="fileUrl" />
      <button v-if="discussionFor(selected)" class="button button-small" type="button" @click="conversation = selected.id">Open discussion</button>
    </section>
    </ModalLayer>
    <ModalLayer v-if="conversation" @close="conversation = null">
      <PublicBoardChat :projection="projection" :target-id="conversation" @close="conversation = null" @open-card="selectedId = $event" />
    </ModalLayer>
  </TincanbanPageLayout>
</template>
<style scoped>
.public-item-detail { position: fixed; z-index: 20; inset: 8vh max(1rem, calc((100vw - 760px) / 2)); max-height: 84vh; overflow: auto; padding: var(--space-5); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: 0 24px 80px #0005; }
.public-item-detail > header { display: flex; align-items: start; justify-content: space-between; gap: var(--space-4); }
.public-item-detail h2 { margin: var(--space-1) 0 0; }
@media (max-width: 700px) { .public-item-detail { inset: 1rem; max-height: calc(100dvh - 2rem); } }
</style>
