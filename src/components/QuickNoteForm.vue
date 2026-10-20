<script setup lang="ts">
import { ref, watch } from "vue"
const props = defineProps<{
  modelValue: string
  saving?: boolean
  error?: string
  readOnly?: boolean
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
  (e: "save"): void
}>()

const open = ref(false)

watch(() => props.error, error => { if (error) open.value = true })

function syncOpen(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
}

function updateDraft(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <details class="quick-note-disclosure" :open="open" @toggle="syncOpen">
    <summary class="button button-small button-quiet">Quick note</summary>
    <form class="quick-note-form" aria-label="Quick note" @submit.prevent="emit('save')">
      <label>
        <span class="detail-label">New note</span>
        <textarea
          class="reading-input"
          :value="modelValue"
          :disabled="readOnly || saving"
          rows="3"
          aria-label="Quick note"
          placeholder="Write a note without creating a document…"
          @input="updateDraft"
        />
      </label>
      <p v-if="error" class="form-error reading-explanation" role="alert">{{ error }}</p>
      <button class="button button-small" type="submit" :disabled="readOnly || saving || !modelValue.trim()">
        {{ saving ? "Saving…" : error ? "Retry note" : "Add note" }}
      </button>
    </form>
  </details>
</template>

<style scoped>
.quick-note-disclosure { display: grid; justify-items: start; gap: var(--space-2); min-width: 0; }
.quick-note-disclosure > summary { list-style: none; cursor: pointer; }
.quick-note-disclosure > summary::-webkit-details-marker { display: none; }
.quick-note-form { display: grid; gap: var(--space-2); margin: 0; padding: 0; border: 0; }
.quick-note-form label { display: grid; gap: var(--space-2); }
.quick-note-form textarea.reading-input { font-family: var(--site-font-reading); font-size: var(--site-font-body-size, 16px); line-height: 1.5; }
</style>
