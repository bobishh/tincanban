<script setup lang="ts">
import { computed, defineAsyncComponent, ref, type Component } from "vue"
import templateData from "../board-templates.json"
import type { Preset, WorkspaceCreationDraft } from "../domain/seeds"

const BoardCreationEditor = defineAsyncComponent(() => import("./BoardCreationEditor.vue") as Promise<{ default: Component }>)
const props = defineProps<{
  createWorkspace: (payload: { title: string; preset: Preset; config?: WorkspaceCreationDraft }) => Promise<void>
}>()
const emit = defineEmits<{ (event: "close"): void; (event: "busy", value: boolean): void }>()
const title = ref("")
const preset = ref<keyof typeof templateData>("blank")
const error = ref("")
const creating = ref(false)
const customizeBoard = ref(false)
const editorMounted = ref(false)
const configDraft = ref<WorkspaceCreationDraft | null>(null)
const configErrors = ref<string[]>([])
const configSummary = computed(() => {
  const draft = configDraft.value
  if (draft) return `${draft.entityName}, ${draft.columns.length} columns, ${draft.fields.length} fields`
  const template = templateData[preset.value]
  return `${template.entityName}, ${template.columns.length} columns, ${template.fields.length} fields`
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
  emit("busy", true)
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
    emit("busy", false)
  }
}
</script>

<template>
  <section class="dialog dialog-window-content workspace-create-dialog">
    <form novalidate :aria-busy="creating" @submit.prevent="handleCreate">
      <div class="workspace-create-content">
        <div class="workspace-create-form ui-stack">
          <label><span>Title</span><input v-model="title" autofocus required placeholder="e.g. Reading List" :disabled="creating" /></label>
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
.workspace-create-content { padding: var(--focus-room); flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.workspace-create-actions { flex: 0 0 auto; margin-top: 0; padding-top: var(--space-4); border-top: 2px solid var(--line); }
.workspace-customize { display: grid; gap: var(--space-3); }
.workspace-customize-toggle { display: flex; width: 100%; min-width: 0; min-height: 54px; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-3); border: 2px solid var(--line); text-align: left; }
.workspace-customize-toggle > span:first-child { display: grid; gap: var(--space-1); min-width: 0; }
.workspace-customize-toggle small { color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.workspace-create-content :deep(.creation-config) { padding-bottom: var(--space-1); }
@media (max-width: 520px) { .workspace-create-form { margin: var(--space-3) 0; } }
</style>
