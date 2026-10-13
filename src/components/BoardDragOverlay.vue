<script setup lang="ts">
import { computed } from "vue"
import type { DragPreview } from "../app/useBoardDrag"
type Controller = { dragPreview: { value: DragPreview | null }; setDragPreviewElement(element: HTMLElement | null): void }

const props = defineProps<{ controller: Controller }>()
const preview = computed(() => props.controller.dragPreview.value)
function setPreview(element: unknown) { props.controller.setDragPreviewElement(element instanceof HTMLElement ? element : null) }
function setCard(element: unknown) {
  const card = preview.value?.card
  if (element instanceof HTMLElement && card && element.firstChild !== card) element.replaceChildren(card)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="preview" :ref="setPreview" class="board-drag-preview" :style="{ width: `${preview.width}px`, height: preview.height === undefined ? undefined : `${preview.height}px` }" aria-hidden="true" inert>
      <div v-if="preview.card" :ref="setCard" class="board-drag-card"></div>
      <div v-else class="lead-card" :data-ink-id="preview.id"><strong>{{ preview.title }}</strong></div>
    </div>
  </Teleport>
</template>
