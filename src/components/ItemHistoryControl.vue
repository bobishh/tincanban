<script setup lang="ts">
import { ref, watch } from "vue"
import SpatialWindow from "./SpatialWindow.vue"
import ItemHistoryPanel from "./ItemHistoryPanel.vue"
import type { ItemHistoryProps } from "./itemHistoryProps"
import { focusSpatialWindow } from "../ui/windowManager"

const props = defineProps<ItemHistoryProps & { itemId: string; itemTitle: string; workspaceId: string }>()
const emit = defineEmits<{ restoreVersion: [hash: string]; loadEarlierHistory: [] }>()
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
watch(() => [props.itemId, props.workspaceId], () => { open.value = false })
function showHistory() {
  if (open.value) focusSpatialWindow(props.workspaceId, `item-history:${props.itemId}`)
  else {
    trigger.value?.focus({ preventScroll: true })
    open.value = true
  }
}
</script>

<template>
  <button ref="trigger" class="button button-small button-quiet" type="button" :aria-expanded="open" @click="showHistory">History</button>
  <SpatialWindow v-if="open" framed :window-id="`item-history:${itemId}`" :workspace-id="workspaceId"
    :title="`History · ${itemTitle}`" aria-label="Item history" close-label="Close history" :busy="restoreSaving" @close="open = false">
    <ItemHistoryPanel :history="history" :verified-people="verifiedPeople" :read-only="readOnly"
      :history-loading="historyLoading" :history-error="historyError" :history-notice="historyNotice" :history-has-more="historyHasMore"
      :restore-saving="restoreSaving" :restore-error="restoreError" :restore-notice="restoreNotice"
      @restore-version="emit('restoreVersion', $event)" @load-earlier-history="emit('loadEarlierHistory')" />
  </SpatialWindow>
</template>
