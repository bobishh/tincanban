<script setup lang="ts" generic="ItemType extends import('../domain/entitySchemas').Item, ColumnType extends { id: string; title: string; collapsible?: boolean; archive?: true; items: ItemType[] }">
import { computed, ref } from "vue"
import BoardColumns from "./BoardColumns.vue"
import BoardItemCard from "./BoardItemCard.vue"
import type { Lead } from "../types"

type CardPresentation = {
  lead?: Lead
  notes: string
  searchQuery?: string
  searchMatchIndex?: number
  fields: Array<{ id: string; title: string; value: string }>
  hasFilters?: boolean
  showFields?: boolean
  discussion?: { count: number; messageId?: string }
  moved: boolean
  ageLevel?: string
  ageLabel?: string
}

const props = withDefaults(defineProps<{
  columns: ColumnType[]
  itemsForColumn: (column: ColumnType) => ItemType[]
  columnColor: (id: string) => string | undefined
  columnStatus: (id: string) => string | null
  isColumnCollapsed: (column: ColumnType) => boolean
  hasFilters: boolean
  entityName: string
  boardTitle?: string
  canEditItems?: boolean
  isEditingBoard?: boolean
  movedColumnId?: string | null
  cardPresentation: (item: ItemType, column: ColumnType) => CardPresentation
  onElement?: (element: HTMLElement | null) => void
}>(), { canEditItems: false, isEditingBoard: false, movedColumnId: null })

const emit = defineEmits<{
  toggleColumn: [column: ColumnType]
  editColumn: [column: ColumnType]
  open: [item: ItemType, event: MouseEvent]
  select: [item: ItemType]
  discuss: [itemId: string]
  taskToggle: [item: ItemType, markdown: string]
  scroll: [event: Event]
}>()
const boardElement = ref<HTMLElement | null>(null)
const boardClasses = computed(() => ({ "board-filtered": props.hasFilters, "board-single-column": props.columns.length === 1 }))
</script>

<template>
  <section :ref="element => { boardElement = element as HTMLElement | null; onElement?.(boardElement) }" class="board" :class="boardClasses" role="region" :aria-label="boardTitle ?? 'Board'" @scroll="emit('scroll', $event)">
    <BoardColumns :visible-columns="columns" :items-for-column="itemsForColumn" :column-color="columnColor" :column-status="columnStatus"
      :is-column-collapsed="isColumnCollapsed" :has-filters="hasFilters" :entity-name="entityName" :is-editing-board="isEditingBoard"
      :moved-column-id="movedColumnId" @toggle-column="emit('toggleColumn', $event)" @edit-column="emit('editColumn', $event)">
      <template #before-item="slotProps"><slot name="before-item" v-bind="slotProps" /></template>
      <template #card="{ item, column }">
        <BoardItemCard :item="item" :can-edit-items="canEditItems" :has-filters="hasFilters" v-bind="cardPresentation(item, column)"
          @open="(value, event) => emit('open', value as ItemType, event)" @select="emit('select', $event as ItemType)"
          @discuss="emit('discuss', $event)" @task-toggle="(value, markdown) => emit('taskToggle', value as ItemType, markdown)" />
      </template>
      <template #add-item="slotProps"><slot name="add-item" v-bind="slotProps" /></template>
    </BoardColumns>
    <slot name="empty" />
  </section>
</template>
