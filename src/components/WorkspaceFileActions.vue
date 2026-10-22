<script setup lang="ts">
import { ref } from "vue"
const props = defineProps<{
  exportWorkspace?: () => Promise<void>
  exportAllWorkspaces?: (onProgress: (progress: { completed: number; total: number }) => void) => Promise<void>
  importWorkspace?: () => void
  importBusy?: boolean
  importError?: string
}>()
const busy = ref(false)
const error = ref("")
const allBusy = ref(false)
const allError = ref("")
const allProgress = ref({ completed: 0, total: 0 })
async function createBackup() {
  if (busy.value || allBusy.value || !props.exportWorkspace) return
  busy.value = true
  error.value = ""
  try { await props.exportWorkspace() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not create backup" }
  finally { busy.value = false }
}
async function createAllBackups() {
  if (busy.value || allBusy.value || !props.exportAllWorkspaces) return
  allBusy.value = true
  allError.value = ""
  allProgress.value = { completed: 0, total: 0 }
  try {
    await props.exportAllWorkspaces(progress => { allProgress.value = progress })
  } catch (cause) {
    allError.value = cause instanceof Error ? cause.message : "Could not export all local boards"
  } finally { allBusy.value = false }
}
</script>

<template>
  <section class="sync-section" aria-label="Workspace files">
    <p class="sync-section-copy">Workspace files</p>
    <div class="dialog-actions sync-data-actions">
      <button class="button button-quiet" type="button" :disabled="busy || allBusy || !exportWorkspace" @click="createBackup">{{ busy ? 'Exporting…' : error ? 'Retry export' : 'Export .tincanban' }}</button>
      <button class="button button-quiet" type="button" :disabled="busy || allBusy || !exportAllWorkspaces" @click="createAllBackups">{{ allBusy ? 'Exporting boards…' : allError ? 'Retry all-board export' : 'Export all boards' }}</button>
      <button class="button button-quiet" type="button" :disabled="importBusy || !importWorkspace" @click="importWorkspace?.()">{{ importBusy ? 'Importing…' : 'Import as new board' }}</button>
    </div>
    <p class="dialog-copy">Export this board as .tincanban. Import creates a new board and keeps existing boards.</p>
    <p class="dialog-copy">Export every locally available board, including archived boards, as individual .tincanban files in one ZIP.</p>
    <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
    <p v-if="busy" role="status">Creating workspace backup…</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="allBusy" role="status">{{ allProgress.total ? `Exporting board ${allProgress.completed} of ${allProgress.total}…` : 'Preparing all local boards…' }}</p>
    <p v-if="allError" class="form-error" role="alert">{{ allError }}</p>
  </section>

</template>

<style scoped>
.sync-section { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 2px solid var(--line); }
.sync-section-copy { margin: 0; color: var(--muted); font: 700 .8rem/1.45 var(--site-font-sans); letter-spacing: .06em; text-transform: uppercase; }
.sync-data-actions { justify-content: flex-start; margin: 0; }
</style>
