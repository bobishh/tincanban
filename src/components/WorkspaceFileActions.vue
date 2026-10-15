<script setup lang="ts">
import { ref } from "vue"
import WorkspacePrivateRecoveryPanel from "./WorkspacePrivateRecoveryPanel.vue"
type RecoveryBackup = { file: Blob; words: string; coverage: "complete" | "incomplete"; missingCount: number }
type RecoveryInspection = { workspaceId: string; personId: string; coverage: "complete" | "incomplete"; missingCount: number }
const props = defineProps<{
  exportWorkspace?: () => Promise<void>
  createPrivateRecovery?: () => Promise<RecoveryBackup>
  privateRecoveryUnavailableReason?: string
  inspectPrivateRecovery?: (file: Blob, words: string) => Promise<RecoveryInspection>
  restorePrivateRecovery?: (inspection: RecoveryInspection, replace: boolean) => Promise<void>
  hasWorkspaceCopy?: (workspaceId: string) => boolean
  workspaceTitle?: (workspaceId: string) => string
  currentPersonId?: string
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
  <section class="sync-section">
    <p class="sync-section-copy">Back up this workspace:</p>
    <div class="dialog-actions sync-data-actions">
      <button class="button button-quiet" type="button" :disabled="busy || !exportWorkspace" @click="createBackup">{{ busy ? 'Exporting…' : error ? 'Retry export' : 'Export .tincanban' }}</button>
    </div>
    <p v-if="busy" role="status">Creating workspace backup…</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
  <WorkspacePrivateRecoveryPanel
    :create-backup="props.createPrivateRecovery"
    :create-unavailable-reason="props.privateRecoveryUnavailableReason"
    :inspect-file="props.inspectPrivateRecovery"
    :restore="props.restorePrivateRecovery"
    :has-workspace-copy="props.hasWorkspaceCopy"
    :workspace-title="props.workspaceTitle"
    :current-person-id="props.currentPersonId"
  />
</template>

<style scoped>
.sync-section { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 2px solid var(--line); }
.sync-section-copy { margin: 0; color: var(--muted); font: 700 .8rem/1.45 var(--site-font-sans); letter-spacing: .06em; text-transform: uppercase; }
.sync-data-actions { justify-content: flex-start; margin: 0; }
</style>
