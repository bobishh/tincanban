<script setup lang="ts">
import { computed, ref } from "vue"
import { isArchiveColumn } from "../domain/archiveColumn"
import { isItemArchived } from "../domain/itemLifecycle"
import type { Column, Item } from "../domain/entitySchemas"
import type { CardStageButton } from "../domain/cardStageButtons"

const props = defineProps<{
  item: Item
  columns: Column[]
  buttons: CardStageButton[]
  readOnly?: boolean
  move: (item: Item, columnId: string) => Promise<void>
}>()

const pendingMoves = ref(0)
let selectionVersion = 0
const error = ref("")
const activeColumnId = computed(() => isItemArchived(props.item)
  ? props.columns.find(column => isArchiveColumn(column))?.id
  : props.item.placement.parentId)
const visibleButtons = computed(() => props.buttons.flatMap(button => {
  const column = props.columns.find(column => column.id === button.columnId)
  return column ? [{ ...button, title: button.label || column.title }] : []
}))

async function selectColumn(columnId: string) {
  if (props.readOnly || activeColumnId.value === columnId) return
  const version = ++selectionVersion
  pendingMoves.value += 1
  error.value = ""
  try { await props.move(props.item, columnId) }
  catch (cause) { if (version === selectionVersion) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { pendingMoves.value -= 1 }
}
</script>

<template>
  <div v-if="visibleButtons.length" class="status-strip-shell">
  <div class="status-strip" role="group" aria-label="Move card to column">
    <button v-for="button in visibleButtons" :key="button.columnId" type="button"
      :class="{ active: activeColumnId === button.columnId }"
      :aria-pressed="activeColumnId === button.columnId"
      :disabled="readOnly"
      @click="selectColumn(button.columnId)">{{ button.title }}</button>
  </div>
  </div>
  <p v-if="pendingMoves" role="status" class="dialog-copy">Saving…</p>
  <p v-if="error" role="alert" class="form-error">Move failed: {{ error }}</p>
</template>
