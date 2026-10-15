<script setup lang="ts">
import type { BoardFilters } from "../filters"
import LeadFilters from "./LeadFilters.vue"
type ToolbarColumn = { id: string; title: string }
type ToolbarField = { id: string; title: string; valueType: string; required?: boolean; rank?: string;
  min?: number | null; max?: number | null; options?: Record<string, { id: string; title: string; rank: string; archivedAt?: string | null }> }
defineProps<{ search: string; filters: BoardFilters; columns: ToolbarColumn[]; fields: ToolbarField[]; placeholder?: string }>()
const emit = defineEmits<{ 'update:search': [value: string]; 'update:filters': [value: BoardFilters] }>()
</script>
<template>
  <section class="toolbar" aria-label="tincanban controls">
    <label class="search-field"><span aria-hidden="true">⌕</span><input :value="search" type="search" aria-label="Search cards" :placeholder="placeholder || 'Search cards'" @input="emit('update:search', ($event.target as HTMLInputElement).value)" /></label>
    <div class="toolbar-spacer"></div>
    <LeadFilters :model-value="filters" :columns="columns" :fields="fields" @update:model-value="emit('update:filters', $event)" />
    <div class="toolbar-meta"><slot /></div>
  </section>
</template>
