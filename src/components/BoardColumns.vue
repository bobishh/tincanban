<script setup lang="ts">
import type { Column, Item } from "../domain/model"
import { isArchiveColumn } from "../domain/archive"
import ColumnFoldCover from "./ColumnFoldCover.vue"
withDefaults(defineProps<{
  visibleColumns: Array<Column & { items: Item[] }>
  itemsForColumn: (column: Column & { items: Item[] }) => Item[]
  columnColor: (id: string) => string | undefined
  columnStatus: (id: string) => string | null
  isColumnCollapsed: (column: Column) => boolean
  hasFilters: boolean
  entityName: string
  isEditingBoard?: boolean
  movedColumnId?: string | null
}>(), { isEditingBoard: false, movedColumnId: null })
const emit = defineEmits<{ toggleColumn: [column: Column]; editColumn: [column: Column] }>()
</script>

<template>
  <article
    v-for="column in visibleColumns"
    :key="column.id"
    class="column"
    :data-column-id="column.id"
    :style="{ '--column-hatch-color': columnColor(column.id) }"
    role="region"
    :aria-label="column.title"
    :class="[columnStatus(column.id) ? `column-${columnStatus(column.id)}` : '', { 'bin-column': isArchiveColumn(column), 'bin-column-open': isArchiveColumn(column) && !isColumnCollapsed(column), 'column-foldable': column.collapsible, 'column-collapsed': isColumnCollapsed(column), 'column-moved': movedColumnId === column.id }]"
  >
    <span v-if="column.collapsible" class="column-paper" aria-hidden="true"></span>
    <ColumnFoldCover v-if="column.collapsible" :collapsed="isColumnCollapsed(column)" :title="column.title" :count="itemsForColumn(column).length" />
    <Transition name="column-fold">
      <button v-if="isColumnCollapsed(column)" class="column-closed" type="button" :aria-label="`Open ${column.title} with ${itemsForColumn(column).length} cards`" @click="emit('toggleColumn', column)"><span class="count">{{ itemsForColumn(column).length }}</span><strong>{{ column.title }}</strong></button>
      <div v-else class="card-stack" :data-column-id="column.id">
        <header class="column-header" :class="{ 'column-drag-handle': isEditingBoard }">
          <div class="column-title"><span class="column-dot"></span><h2 :title="isEditingBoard ? 'Double-click to edit column' : undefined" @dblclick="isEditingBoard && emit('editColumn', column)">{{ column.title }}</h2></div>
          <div class="column-actions"><span class="count">{{ itemsForColumn(column).length }}</span><button v-if="column.collapsible && !hasFilters" class="bin-close" type="button" :aria-label="`Collapse ${column.title}`" @click="emit('toggleColumn', column)">×</button><button v-if="isEditingBoard" class="button button-small button-quiet" type="button" aria-label="Edit column" @click="emit('editColumn', column)">Edit</button></div>
        </header>
        <template v-for="(item, index) in itemsForColumn(column)" :key="item.id">
          <slot name="before-item" :column="column" :item="item" :index="index" />
          <slot name="card" :item="item" :column="column" />
        </template>
            <div v-if="!itemsForColumn(column).length" class="empty-column">{{ hasFilters ? 'No matches in this column' : `No ${entityName}s` }}</div>
            <slot name="add-item" :column="column" />
          </div>
        </Transition>
      </article>
</template>
