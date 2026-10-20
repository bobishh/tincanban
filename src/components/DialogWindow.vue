<script setup lang="ts">
import SpatialWindow from "./SpatialWindow.vue"

withDefaults(defineProps<{
  windowId: string
  workspaceId: string
  title: string
  ariaLabel?: string
  busy?: boolean
  closeLabel?: string
  initialWidth?: number
  initialHeight?: number
}>(), {
  closeLabel: "Close",
  initialWidth: 720,
  initialHeight: 680,
})

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <SpatialWindow
    :window-id="windowId"
    :workspace-id="workspaceId"
    :title="title"
    :aria-label="ariaLabel ?? title"
    :busy="busy"
    :close-label="closeLabel"
    :initial-width="initialWidth"
    :initial-height="initialHeight"
    @close="emit('close')"
  >
    <slot />
  </SpatialWindow>
</template>

<style>
.spatial-window .spatial-body > .dialog-window-content {
  width: 100%;
  max-height: none;
  overflow: visible;
  padding: 0;
  border: 0;
  background: transparent;
}
</style>
