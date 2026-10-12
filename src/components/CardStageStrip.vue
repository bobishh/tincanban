<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { isArchiveColumn, isItemArchived } from "../domain/archive"
import type { Column, Item } from "../domain/model"
import type { CardStageButton } from "../domain/cardStageButtons"

const props = defineProps<{
  item: Item
  columns: Column[]
  buttons: CardStageButton[]
  readOnly?: boolean
  move: (item: Item, columnId: string) => Promise<void>
}>()

const pendingColumnId = ref<string | null>(null)
const error = ref("")
const strip = ref<HTMLElement | null>(null)
const earlier = ref(false)
const later = ref(false)
let observer: ResizeObserver | undefined
function measureOverflow() {
  const element = strip.value
  earlier.value = Boolean(element && element.scrollLeft > 1)
  later.value = Boolean(element && element.scrollWidth - element.clientWidth - element.scrollLeft > 1)
}
function scrollStages(direction: number) {
  const element = strip.value
  element?.scrollBy({ left: direction * element.clientWidth * .8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
}
onMounted(() => {
  observer = new ResizeObserver(measureOverflow)
  if (strip.value) observer.observe(strip.value)
  measureOverflow()
})
watch(strip, (element, previous) => {
  if (previous) observer?.unobserve(previous)
  if (element) observer?.observe(element)
  measureOverflow()
}, { flush: "post" })
onBeforeUnmount(() => observer?.disconnect())
const activeColumnId = computed(() => isItemArchived(props.item)
  ? props.columns.find(column => isArchiveColumn(column))?.id
  : props.item.placement.parentId)
const visibleButtons = computed(() => props.buttons.flatMap(button => {
  const column = props.columns.find(column => column.id === button.columnId)
  return column ? [{ ...button, title: button.label || column.title }] : []
}))
watch(visibleButtons, measureOverflow, { flush: "post" })

async function selectColumn(columnId: string) {
  if (props.readOnly || pendingColumnId.value || activeColumnId.value === columnId) return
  pendingColumnId.value = columnId
  error.value = ""
  try { await props.move(props.item, columnId) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { pendingColumnId.value = null }
}
</script>

<template>
  <div v-if="visibleButtons.length" class="status-strip-shell">
  <div ref="strip" class="status-strip" aria-label="Move card to column" @scroll.passive="measureOverflow">
    <button v-for="button in visibleButtons" :key="button.columnId" type="button"
      :class="{ active: activeColumnId === button.columnId }"
      :aria-pressed="activeColumnId === button.columnId"
      :disabled="readOnly || pendingColumnId !== null"
      @click="selectColumn(button.columnId)">{{ button.title }}</button>
  </div>
    <button v-if="earlier" class="stage-scroll stage-scroll-earlier" type="button" aria-label="Show earlier stages" @click="scrollStages(-1)"><span aria-hidden="true">‹</span></button>
    <button v-if="later" class="stage-scroll stage-scroll-later" type="button" aria-label="Show later stages" @click="scrollStages(1)"><span aria-hidden="true">›</span></button>
  </div>
  <p v-if="pendingColumnId" role="status" class="dialog-copy">Moving card…</p>
  <p v-if="error" role="alert" class="form-error">Move failed: {{ error }}</p>
</template>
