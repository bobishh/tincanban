<script setup lang="ts">
import { ref } from "vue"
const props = defineProps<{
  exportWorkspace?: () => Promise<void>
  importWorkspace?: () => void
  importBusy?: boolean
  importError?: string
}>()
const busy = ref(false)
const error = ref("")
async function createBackup() {
  if (busy.value || !props.exportWorkspace) return
  busy.value = true
  error.value = ""
  try { await props.exportWorkspace() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not create backup" }
  finally { busy.value = false }
}
</script>

<template>
  <section class="sync-section" aria-label="Workspace files">
    <p class="sync-section-copy">Workspace files</p>
    <div class="dialog-actions sync-data-actions">
      <button class="button button-quiet" type="button" :disabled="busy || !exportWorkspace" @click="createBackup">{{ busy ? 'Exporting…' : error ? 'Retry export' : 'Export .tincanban' }}</button>
      <button class="button button-quiet" type="button" :disabled="importBusy || !importWorkspace" @click="importWorkspace?.()">{{ importBusy ? 'Importing…' : 'Import as new board' }}</button>
    </div>
    <p class="dialog-copy">Export this board as .tincanban. Import creates a new board and keeps existing boards.</p>
    <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
    <p v-if="busy" role="status">Creating workspace backup…</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>

</template>

<style scoped>
.sync-section { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 2px solid var(--line); }
.sync-section-copy { margin: 0; color: var(--muted); font: 700 .8rem/1.45 var(--site-font-sans); letter-spacing: .06em; text-transform: uppercase; }
.sync-data-actions { justify-content: flex-start; margin: 0; }
</style>
