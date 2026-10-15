<script setup lang="ts">
import type { PublicColumn } from "./publicBoardView"
import ColumnFoldCover from "../components/ColumnFoldCover.vue"
defineProps<{ columns: PublicColumn[]; itemsForColumn: (column: PublicColumn) => PublicColumn["items"]; columnColor: (id: string) => string | undefined;
  columnStatus: (id: string) => string | null; isCollapsed: (column: PublicColumn) => boolean; hasFilters: boolean; entityName: string }>()
const emit = defineEmits<{ toggle: [column: PublicColumn] }>()
</script>
<template>
  <article v-for="column in columns" :key="column.id" class="column" :data-column-id="column.id"
    :style="{ '--column-hatch-color': columnColor(column.id) }" role="region" :aria-label="column.title"
    :class="[columnStatus(column.id) ? `column-${columnStatus(column.id)}` : '', { 'column-foldable': column.collapsible, 'column-collapsed': isCollapsed(column) }]">
    <span v-if="column.collapsible" class="column-paper" aria-hidden="true"></span>
    <ColumnFoldCover v-if="column.collapsible" :collapsed="isCollapsed(column)" :title="column.title" :count="itemsForColumn(column).length" />
    <Transition name="column-fold">
      <button v-if="isCollapsed(column)" class="column-closed" type="button" :aria-label="`Open ${column.title} with ${itemsForColumn(column).length} cards`" @click="emit('toggle', column)"><span class="count">{{ itemsForColumn(column).length }}</span><strong>{{ column.title }}</strong></button>
      <div v-else class="card-stack" :data-column-id="column.id">
        <header class="column-header">
          <div class="column-title"><span class="column-dot"></span><h2>{{ column.title }}</h2></div>
          <div class="column-actions"><span class="count">{{ itemsForColumn(column).length }}</span><button v-if="column.collapsible && !hasFilters" class="bin-close" type="button" :aria-label="`Collapse ${column.title}`" @click="emit('toggle', column)">×</button></div>
        </header>
        <slot v-for="item in itemsForColumn(column)" :key="item.id" name="card" :item="item" :column="column" />
        <div v-if="!itemsForColumn(column).length" class="empty-column">No {{ entityName }}s</div>
      </div>
    </Transition>
  </article>
</template>
