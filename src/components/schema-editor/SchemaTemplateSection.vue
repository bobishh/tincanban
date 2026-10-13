<script setup lang="ts">
import { MarkdownContent } from "../../ui/markdownContent"
import { computed, watch } from "vue"
import type { Template } from "../../types"

const props = defineProps<{
  readOnly?: boolean
  templates: Template[]
  saveTemplate: (input: { id?: string; newId?: string; name: string; markdown: string }) => Promise<string>
}>()
const editor = defineModel<{ id: string | null; newId: string | null; name: string; markdown: string; saving: boolean; error: string; notice: string }>("editor", { required: true })
const templateDraft = computed(() => editor.value)
const editingTemplateId = computed(() => editor.value.id)
const saving = computed(() => editor.value.saving)
const error = computed(() => editor.value.error)
const saveNotice = computed(() => editor.value.notice)
watch(() => [editor.value.name, editor.value.markdown], () => { editor.value.notice = "" })

function startTemplate() {
  editor.value = { id: null, newId: null, name: "", markdown: "", saving: false, error: "", notice: "" }
}
function editTemplate(template: Template) {
  editor.value = { id: template.id, newId: null, name: template.name, markdown: template.markdown, saving: false, error: "", notice: "" }
}
async function persistTemplate() {
  const draft = editor.value
  const name = draft.name.trim()
  const markdown = draft.markdown.trim()
  if (!name || !markdown || draft.saving || props.readOnly) return
  draft.saving = true
  draft.error = ""
  if (!draft.id) draft.newId ??= crypto.randomUUID()
  try {
    const id = await props.saveTemplate({ ...(draft.id ? { id: draft.id } : { newId: draft.newId! }), name, markdown })
    draft.id = id
    draft.newId = null
    draft.notice = "Saved"
  } catch (cause) { draft.error = cause instanceof Error ? cause.message : "Could not save template" }
  finally { draft.saving = false }
}
</script>

<template>
  <div class="schema-tab-content">
    <div class="templates-layout">
      <aside class="template-list" aria-label="Saved templates">
        <button
          class="button button-small"
          type="button"
          :disabled="readOnly || saving"
          @click="startTemplate"
        >
          + Template
        </button>
        <button
          v-for="template in templates"
          :key="template.id"
          class="template-item"
          :class="{ active: editingTemplateId === template.id }"
          type="button"
          :disabled="saving"
          @click="editTemplate(template)"
        >
          <strong>{{ template.name }}</strong>
        </button>
        <p v-if="!templates.length" class="empty-template-list">
          No templates yet.
        </p>
      </aside>

      <form class="template-editor" novalidate @submit.prevent="persistTemplate">
        <fieldset :disabled="readOnly || saving" class="template-form-fields">
        <label>
          <span>Name</span>
          <input
            v-model="templateDraft.name"
            required
            placeholder="General software CV"
          />
        </label>
        <label>
          <span>Markdown</span>
          <textarea
            v-model="templateDraft.markdown"
            rows="8"
            required
            placeholder="# Your name"
          ></textarea>
        </label>
        <div class="dialog-actions">
          <button class="button button-primary" type="submit" :disabled="!templateDraft.name.trim() || !templateDraft.markdown.trim()">
            {{ saving ? 'Saving…' : error ? 'Retry save' : 'Save template' }}
          </button>
        </div>
        <section v-if="templateDraft.markdown" aria-label="Template preview">
          <h3>Preview</h3>
          <MarkdownContent :source="templateDraft.markdown" :editable-tasks="!readOnly && !saving" @task-toggle="templateDraft.markdown = $event" />
        </section>
        </fieldset>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p v-if="saving || saveNotice" role="status" aria-label="Template save status">{{ saving ? 'Saving…' : saveNotice }}</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.templates-layout { display: grid; gap: 20px; min-width: 0; }
.template-list { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.template-list .button, .template-item { max-width: 100%; overflow-wrap: anywhere; }
.empty-template-list { margin: 0; }
.template-editor { display: grid; gap: 12px; min-width: 0; }
.template-form-fields { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 0; border: 0; }
.template-editor label { color: var(--ink); font: inherit; letter-spacing: 0; text-transform: none; }
.template-editor input { min-height: 42px; color: var(--ink); font: inherit; letter-spacing: 0; text-transform: none; }
.template-editor textarea { height: 240px; min-height: 160px; }
.template-editor .dialog-actions { margin-top: 0; }
.template-editor h3 { margin: 8px 0; }
</style>
