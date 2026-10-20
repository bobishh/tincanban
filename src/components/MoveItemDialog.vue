<script setup lang="ts">
import DialogWindow from "./DialogWindow.vue"
import { ref } from "vue"
import type { Item } from "../domain/model"

const props = defineProps<{
  item: Item
  workspaceId?: string
  candidateParents: { id: string; title: string }[]
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "confirm", newParentId: string): void
}>()

const selectedParentId = ref(props.candidateParents[0]?.id ?? "")

function handleConfirm() {
  if (!selectedParentId.value) return
  emit("confirm", selectedParentId.value)
}
</script>

<template>
  <DialogWindow :window-id="`item-move:${item.id}`" :workspace-id="workspaceId ?? 'local'" title="Move item" @close="emit('close')">
    <section class="dialog dialog-window-content">
      <div class="dialog-body">
        <p>Moving <strong>{{ item.title }}</strong> to a new parent.</p>
        <label>
          <span>New parent</span>
          <select v-model="selectedParentId">
            <option v-for="p in candidateParents" :key="p.id" :value="p.id">
              {{ p.title }}
            </option>
          </select>
        </label>
      </div>

      <div class="dialog-actions">
        <button class="button button-quiet" type="button" @click="emit('close')">Cancel</button>
        <button class="button button-primary" type="button" @click="handleConfirm">Confirm move</button>
      </div>
    </section>
  </DialogWindow>
</template>
