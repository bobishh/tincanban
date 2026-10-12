<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue"
import type { WorkspaceCreationDraft } from "../domain/seeds"

const BoardCreationEditor = defineAsyncComponent(() => import("./BoardCreationEditor.vue"))
const props = defineProps<{
  createWorkspace: (payload: { title: string; preset: "blank" | "job-search"; config?: WorkspaceCreationDraft }) => Promise<void>
}>()
const emit = defineEmits<{ (event: "close"): void }>()
const title = ref("")
const preset = ref<"blank" | "job-search">("blank")
const error = ref("")
const creating = ref(false)
const customizeBoard = ref(false)
const editorMounted = ref(false)
const configDraft = ref<WorkspaceCreationDraft | null>(null)
const configErrors = ref<string[]>([])
const configSummary = computed(() => {
  const draft = configDraft.value
  if (draft) return `${draft.entityName}, ${draft.columns.length} columns, ${draft.fields.length} fields`
  return preset.value === "blank" ? "item, 3 columns, 0 fields" : "lead, 6 columns, 10 fields"
})

function toggleCustomizeBoard() {
  customizeBoard.value = !customizeBoard.value
  if (customizeBoard.value) editorMounted.value = true
}

async function handleCreate() {
  if (creating.value) return
  if (editorMounted.value && !configDraft.value) return
  if (!title.value.trim()) { error.value = "Workspace title is required"; return }
  error.value = ""
  configErrors.value = []
  creating.value = true
  try {
    if (configDraft.value) {
      const { validateBoardSchemaDraft } = await import("../domain/schema")
      const validation = validateBoardSchemaDraft(configDraft.value)
      if (!validation.valid) { configErrors.value = validation.errors.map(item => item.message); return }
    }
    await props.createWorkspace({ title: title.value.trim(), preset: preset.value, ...(configDraft.value ? { config: configDraft.value } : {}) })
    emit("close")
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Workspace could not be created"
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <section class="dialog workspace-create-dialog" role="dialog" aria-modal="true" aria-label="Create workspace">
    <form novalidate :aria-busy="creating" @submit.prevent="handleCreate">
      <div class="dialog-head">
        <h2>Create workspace</h2>
        <button class="icon-button" type="button" aria-label="Close" :disabled="creating" @click="emit('close')">×</button>
      </div>

      <div class="workspace-create-content">
        <div class="workspace-create-form">
          <label><span>Title</span><input v-model="title" autofocus required placeholder="e.g. Reading List" :disabled="creating" /></label>
          <fieldset class="workspace-preset" :disabled="creating">
            <legend>Preset</legend>
            <div class="workspace-preset-options">
              <label><input v-model="preset" type="radio" value="blank" /><span>Blank board</span></label>
              <label><input v-model="preset" type="radio" value="job-search" /><span>Job search</span></label>
            </div>
          </fieldset>
          <section class="workspace-customize">
            <button class="workspace-customize-toggle" type="button" :aria-expanded="customizeBoard" :disabled="creating" @click="toggleCustomizeBoard">
              <span><strong>Customize board</strong><small>{{ configSummary }}</small></span><span aria-hidden="true">{{ customizeBoard ? '−' : '+' }}</span>
            </button>
            <Suspense v-if="editorMounted"><div v-show="customizeBoard"><BoardCreationEditor v-model="configDraft" :preset="preset" :disabled="creating" /></div></Suspense>
          </section>
          <p v-if="error" role="alert" class="form-error">{{ error }}</p>
          <ul v-if="configErrors.length" class="form-error" role="alert"><li v-for="(message, index) in configErrors" :key="index">{{ message }}</li></ul>
        </div>
      </div>

      <div class="dialog-actions workspace-create-actions">
        <button class="button button-quiet" type="button" :disabled="creating" @click="emit('close')">Cancel</button>
        <button class="button button-primary" type="submit" :disabled="creating || (editorMounted && !configDraft)">{{ creating ? 'Creating…' : 'Create' }}</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.workspace-create-dialog { display: flex; flex-direction: column; overflow: hidden; }
.workspace-create-dialog form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.workspace-create-content { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.workspace-create-actions { flex: 0 0 auto; margin-top: 0; padding-top: 16px; border-top: 2px solid var(--line); }
.workspace-customize { display: grid; gap: 14px; }
.workspace-customize-toggle { display: flex; width: 100%; min-width: 0; min-height: 54px; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 2px solid var(--line); text-align: left; }
.workspace-customize-toggle > span:first-child { display: grid; gap: 4px; min-width: 0; }
.workspace-customize-toggle small { color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.workspace-create-content :deep(.creation-config) { padding-bottom: 4px; }
@media (max-width: 520px) { .workspace-create-dialog { padding: 18px; } .workspace-create-form { margin: 14px 0; } }
</style>
