<script setup lang="ts">
import { computed, ref, watch } from "vue"

type RecoveryBackup = { workspaceId?: string; workspaceTitle?: string; file: Blob; words: string; coverage: "complete" | "incomplete"; missingCount: number }
type RecoveryInspection = { workspaceId: string; personId: string; coverage: "complete" | "incomplete"; missingCount: number }
const props = defineProps<{
  selectedWorkspaceTitle?: string
  createBackup?: () => Promise<RecoveryBackup>
  createUnavailableReason?: string
  inspectFile?: (file: Blob, words: string) => Promise<RecoveryInspection>
  restore?: (inspection: RecoveryInspection, replace: boolean) => Promise<void>
  hasWorkspaceCopy?: (workspaceId: string) => boolean
  workspaceTitle?: (workspaceId: string) => string
  currentPersonId?: string
}>()
const creating = ref(false), inspecting = ref(false), restoring = ref(false)
const createError = ref(""), inspectError = ref(""), restoreError = ref(""), status = ref("")
const backupWords = ref("")
const backupWorkspaceTitle = ref("")
const selectedFile = ref<File | null>(null)
const recoveryWords = ref("")
const inspection = ref<RecoveryInspection | null>(null)
const replaceExisting = ref(false)
const sameIdentity = computed(() => !!inspection.value && !!props.currentPersonId && inspection.value.personId === props.currentPersonId)
const hasWorkspaceCopy = computed(() => !!inspection.value && (props.hasWorkspaceCopy?.(inspection.value.workspaceId) ?? false))
const previewTitle = computed(() => inspection.value ? props.workspaceTitle?.(inspection.value.workspaceId) || "Recovered workspace" : "")
const coverageLabel = computed(() => inspection.value?.coverage === "complete"
  ? "Complete backup" : `Incomplete backup · ${inspection.value?.missingCount ?? 0} items unavailable`)
const canRestore = computed(() => !!inspection.value && sameIdentity.value && (!hasWorkspaceCopy.value || replaceExisting.value) &&
  !creating.value && !inspecting.value && !restoring.value && !!props.restore)

function selectAll(event: FocusEvent) { (event.target as HTMLTextAreaElement).select() }

watch([selectedFile, recoveryWords], () => { inspection.value = null; replaceExisting.value = false; inspectError.value = ""; restoreError.value = ""; status.value = "" })

async function createPrivateBackup() {
  if (creating.value || !props.createBackup) return
  const selectedTitle = props.selectedWorkspaceTitle || "Current workspace"
  backupWorkspaceTitle.value = selectedTitle
  creating.value = true; createError.value = ""; status.value = ""; backupWords.value = ""
  try {
    const backup = await props.createBackup()
    const url = URL.createObjectURL(backup.file), anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `private-workspace-recovery-${new Date().toISOString().slice(0, 10)}.jsonl`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    backupWorkspaceTitle.value = backup.workspaceTitle || selectedTitle
    backupWords.value = backup.words
    status.value = backup.coverage === "complete" ? "Private recovery backup created" :
      `Private recovery backup created with ${backup.missingCount} unavailable item${backup.missingCount === 1 ? "" : "s"}. Connect the source device or Rusty and create another backup to include them.`
  } catch (error) { createError.value = error instanceof Error ? error.message : "Could not create private recovery backup" }
  finally { creating.value = false }
}

function chooseFile(event: Event) {
  selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function inspect() {
  if (inspecting.value || !props.inspectFile || !selectedFile.value || !recoveryWords.value.trim()) return
  inspecting.value = true; inspectError.value = ""; restoreError.value = ""; status.value = ""; inspection.value = null
  try { inspection.value = await props.inspectFile(selectedFile.value, recoveryWords.value.trim()) }
  catch (error) { inspectError.value = error instanceof Error ? error.message : "Could not inspect this private recovery file" }
  finally { inspecting.value = false }
}

async function restorePrivateBackup() {
  if (!canRestore.value || !inspection.value || !props.restore) return
  restoring.value = true; restoreError.value = ""; status.value = ""
  try {
    await props.restore(inspection.value, replaceExisting.value)
    status.value = "Workspace recovery restored"
  } catch (error) { restoreError.value = error instanceof Error ? error.message : "Could not restore this workspace" }
  finally { restoring.value = false }
}
</script>

<template>
  <section class="sync-section private-recovery" role="region" aria-label="Private workspace recovery">
    <p class="sync-section-copy">Private recovery backup</p>
    <p class="copy">Workspace: <strong>{{ selectedWorkspaceTitle || 'Current workspace' }}</strong>. This package contains this workspace, not all boards.</p>
    <p class="copy">Includes encrypted identity and workspace history. Each export creates fresh words for that specific file. Keep its words separate from the file.</p>
    <div class="dialog-actions sync-data-actions">
      <button class="button button-quiet" type="button" :disabled="creating || !props.createBackup || !!props.createUnavailableReason" @click="createPrivateBackup">
        {{ creating ? "Creating private backup…" : createError ? "Retry private backup" : "Create private recovery backup" }}
      </button>
      <p v-if="props.createUnavailableReason" class="copy">{{ props.createUnavailableReason }}</p>
    </div>
    <p v-if="creating" role="status">Preparing encrypted private recovery for {{ backupWorkspaceTitle }}…</p>
    <p v-if="createError" class="form-error" role="alert">{{ createError }}</p>
    <label v-if="backupWords" class="words-field">
      <span>Recovery words</span>
      <small>Downloaded backup workspace: {{ backupWorkspaceTitle }}</small>
      <textarea aria-label="Recovery words" readonly rows="3" :value="backupWords" @focus="selectAll" />
      <small>Store these separately. These words open this downloaded backup only. A later export has different words.</small>
    </label>

    <div class="recovery-import">
      <label class="file-picker button button-quiet">
        Choose private recovery file
        <input type="file" accept=".jsonl,application/x-tincanban-history-recovery+jsonl,application/json" @change="chooseFile" />
      </label>
      <span v-if="selectedFile" class="file-name">{{ selectedFile.name }}</span>
      <label class="words-field">
        <span>Recovery words to inspect</span>
        <textarea v-model="recoveryWords" aria-label="Recovery words to inspect" rows="2" autocomplete="off" spellcheck="false" />
      </label>
      <button class="button button-quiet" type="button" :disabled="inspecting || !selectedFile || !recoveryWords.trim() || !inspectFile" @click="inspect">
        {{ inspecting ? "Inspecting recovery file…" : inspectError ? "Retry inspection" : "Inspect recovery file" }}
      </button>
    </div>
    <p v-if="inspecting" role="status">Checking recovery file. Your identity and workspace stay unchanged.</p>
    <p v-if="inspectError" class="form-error" role="alert">{{ inspectError }}</p>
    <section v-if="inspection" class="recovery-preview" aria-label="Recovery preview">
      <h3>Recovery preview</h3>
      <p class="copy">Inspection only. Your identity and workspace have not changed.</p>
      <p><strong>Workspace:</strong> {{ previewTitle }}</p>
      <p><strong>Workspace ID:</strong> <code>{{ inspection.workspaceId }}</code></p>
      <p><strong>Identity:</strong> {{ sameIdentity ? "Matches this device" : `Different identity · ${inspection.personId.slice(0, 12)}…` }}</p>
      <p><strong>Coverage:</strong> {{ coverageLabel }}</p>
      <p v-if="inspection.coverage === 'incomplete'" class="copy">Some older versions or files are missing. Connect the source device or Rusty and create another backup to include them.</p>
      <p v-if="!sameIdentity" class="form-error" role="alert">This backup belongs to another identity. Workspace restore requires the same identity. Inspection does not replace your identity.</p>
      <label v-if="hasWorkspaceCopy" class="replace-choice">
        <input v-model="replaceExisting" type="checkbox" aria-label="Replace an existing local copy of this workspace" />
        <span>Replace an existing local copy of this workspace</span>
      </label>
      <button class="button button-primary" type="button" :disabled="!canRestore" @click="restorePrivateBackup">
        {{ restoring ? "Restoring workspace…" : restoreError ? "Retry restore" : "Restore recovered workspace" }}
      </button>
    </section>
    <p v-if="restoring" role="status">Restoring verified workspace history…</p>
    <p v-if="restoreError" class="form-error" role="alert">{{ restoreError }}</p>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
.private-recovery { display: grid; gap: var(--space-2); }
.copy, .file-name { margin: 0; color: var(--muted); font: 500 .9rem/1.45 var(--site-font-sans); }
.recovery-import, .recovery-preview, .words-field { display: grid; gap: var(--space-2); }
.recovery-import { border-top: 1px solid var(--line); padding-top: var(--space-3); }
.file-picker { position: relative; width: fit-content; overflow: hidden; cursor: pointer; }
.file-picker input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.words-field span { font: 700 .9rem/1.3 var(--site-font-sans); }
.words-field textarea { width: 100%; min-height: 3.5rem; resize: vertical; font: 500 .9rem/1.4 var(--site-font-sans); }
.words-field small { color: var(--muted); }
.recovery-preview { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: var(--space-3); }
.recovery-preview h3, .recovery-preview p { margin: 0; }
.recovery-preview code { overflow-wrap: anywhere; }
.replace-choice { display: flex; gap: var(--space-2); align-items: flex-start; }
.replace-choice input { margin-top: var(--space-1); }
</style>
