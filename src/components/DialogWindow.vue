<script setup lang="ts">
import { useSlots } from "vue"
import SpatialWindow from "./SpatialWindow.vue"

withDefaults(defineProps<{
  windowId: string
  workspaceId: string
  title: string
  ariaLabel?: string
  busy?: boolean
  closeLabel?: string
  modal?: boolean
  initialWidth?: number
  initialHeight?: number
}>(), {
  closeLabel: "Close",
  initialWidth: 720,
  initialHeight: 680,
  modal: false,
})

const emit = defineEmits<{ close: [] }>()
const slots = useSlots()
</script>

<template>
  <SpatialWindow
    :window-id="windowId"
    :workspace-id="workspaceId"
    :title="title"
    :aria-label="ariaLabel ?? title"
    :busy="busy"
    :close-label="closeLabel"
    :modal="modal"
    :initial-width="initialWidth"
    :initial-height="initialHeight"
    @close="emit('close')"
  >
    <template v-if="slots.header" #header><slot name="header" /></template>
    <slot />
  </SpatialWindow>
</template>

<style>
.spatial-window .spatial-body > .dialog-window-content {
  width: 100%;
  max-height: none;
  overflow: visible;
  padding: var(--surface-padding);
  border: 0;
  background: transparent;
}
</style>
