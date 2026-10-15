<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"
import { compareRanks } from "../domain/rank"
import { activeFilterCount, type BoardFilters, type FilterRange } from "../filters"

type FilterColumn = { id: string; title: string }
type FilterField = { id: string; title: string; valueType: string; archivedAt?: string | null; min?: number | null; max?: number | null;
  options?: Record<string, { id: string; title: string; rank: string; archivedAt?: string | null }> }
const props = defineProps<{
  modelValue: BoardFilters
  columns: FilterColumn[]
  fields: FilterField[]
}>()
const emit = defineEmits<{ "update:modelValue": [value: BoardFilters] }>()

const isOpen = ref(false)
const mobileQuery = window.matchMedia("(max-width: 768px)")
const mobile = ref(mobileQuery.matches)
const updateMobile = () => { mobile.value = mobileQuery.matches }
mobileQuery.addEventListener("change", updateMobile)
onBeforeUnmount(() => mobileQuery.removeEventListener("change", updateMobile))
const activeCount = computed(() => activeFilterCount(props.modelValue))
const filterableFields = computed(() => props.fields.filter((field) =>
  !field.archivedAt && ["select", "number", "boolean", "date", "datetime"].includes(field.valueType)
))

function updateColumn(columnId: string) {
  emit("update:modelValue", { ...props.modelValue, columnId })
}

function updateField(fieldId: string, value: string) {
  emit("update:modelValue", {
    ...props.modelValue,
    fieldValues: { ...props.modelValue.fieldValues, [fieldId]: value },
  })
}

function updateRange(kind: "numberRanges" | "dateRanges", fieldId: string, edge: keyof FilterRange, value: string) {
  const current = props.modelValue[kind][fieldId] ?? { min: "", max: "" }
  emit("update:modelValue", {
    ...props.modelValue,
    [kind]: { ...props.modelValue[kind], [fieldId]: { ...current, [edge]: value } },
  })
}

function optionsFor(field: FilterField) {
  if (field.valueType !== "select") return []
  return Object.values(field.options ?? {}).filter((option) => !option.archivedAt).sort((a, b) => compareRanks(a.rank, b.rank))
}
</script>

<template>
  <div class="filters-panel" :class="{ 'filters-panel-open': isOpen }">
    <button class="filters-toggle" type="button" :aria-expanded="isOpen" aria-controls="board-filters" @click="isOpen = !isOpen"><span>Filters{{ activeCount ? ` · ${activeCount}` : '' }}</span><span class="filters-toggle-mark" aria-hidden="true">{{ isOpen ? "−" : "+" }}</span></button>
    <div class="filters-collapse" :class="{ 'filters-collapse-open': isOpen }" :inert="mobile && !isOpen || undefined">
    <div class="filters-collapse-inner">
    <fieldset id="board-filters" class="lead-filters">
      <legend>Filters</legend>
      <label class="filter-label">
        <span>Status</span>
        <select :value="modelValue.columnId" @change="updateColumn(($event.target as HTMLSelectElement).value)">
          <option value="">All cards</option>
          <option v-for="column in columns" :key="column.id" :value="column.id">{{ column.title }}</option>
        </select>
      </label>

      <template v-for="field in filterableFields" :key="field.id">
        <label v-if="field.valueType === 'select'" class="filter-label">
          <span>{{ field.title }}</span>
          <select :value="modelValue.fieldValues[field.id] ?? ''" @change="updateField(field.id, ($event.target as HTMLSelectElement).value)">
            <option value="">Any</option>
            <option v-for="option in optionsFor(field)" :key="option.id" :value="option.id">{{ option.title }}</option>
          </select>
        </label>
        <label v-else-if="field.valueType === 'boolean'" class="filter-label">
          <span>{{ field.title }}</span>
          <select :value="modelValue.fieldValues[field.id] ?? ''" @change="updateField(field.id, ($event.target as HTMLSelectElement).value)">
            <option value="">Any</option>
            <option value="__true">Yes</option>
            <option value="__false">No</option>
          </select>
        </label>
        <div v-else-if="field.valueType === 'number'" class="filter-range">
          <span>{{ field.title }}</span>
          <label><span class="sr-only">{{ field.title }} minimum</span><input :value="modelValue.numberRanges[field.id]?.min ?? ''" type="number" :min="field.min ?? undefined" :max="field.max ?? undefined" placeholder="Min" @input="updateRange('numberRanges', field.id, 'min', ($event.target as HTMLInputElement).value)" /></label>
          <label><span class="sr-only">{{ field.title }} maximum</span><input :value="modelValue.numberRanges[field.id]?.max ?? ''" type="number" :min="field.min ?? undefined" :max="field.max ?? undefined" placeholder="Max" @input="updateRange('numberRanges', field.id, 'max', ($event.target as HTMLInputElement).value)" /></label>
        </div>
        <div v-else-if="field.valueType === 'date' || field.valueType === 'datetime'" class="filter-range filter-range-date">
          <span>{{ field.title }}</span>
          <label><span class="sr-only">{{ field.title }} from</span><input :value="modelValue.dateRanges[field.id]?.min ?? ''" :type="field.valueType === 'datetime' ? 'datetime-local' : 'date'" @input="updateRange('dateRanges', field.id, 'min', ($event.target as HTMLInputElement).value)" /></label>
          <label><span class="sr-only">{{ field.title }} to</span><input :value="modelValue.dateRanges[field.id]?.max ?? ''" :type="field.valueType === 'datetime' ? 'datetime-local' : 'date'" @input="updateRange('dateRanges', field.id, 'max', ($event.target as HTMLInputElement).value)" /></label>
        </div>
      </template>
    </fieldset>
    </div>
    </div>
  </div>
</template>
