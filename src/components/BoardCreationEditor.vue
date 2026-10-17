<script setup lang="ts">
import type { Preset } from "../domain/seeds"

import { onMounted, ref, watch } from "vue"
import { createWorkspaceDoc } from "../domain/seeds"
import { projectBoardSchema, type BoardSchemaDraft } from "../domain/schema"

type CreationDraft = BoardSchemaDraft & { presetBindings: Record<string, string> }

const props = defineProps<{ preset: Preset; modelValue: CreationDraft | null; disabled?: boolean }>()
const emit = defineEmits<{ (event: "update:modelValue", value: CreationDraft): void }>()
const draft = ref<CreationDraft>(props.modelValue ?? fromPreset(props.preset))
const dirty = ref(false)
const optionsExpanded = ref<string[]>([])
const expandedFields = ref<string[]>([])

function fromPreset(preset: Preset): CreationDraft {
  const doc = createWorkspaceDoc("creation-draft", "Board", "creation-owner", preset)
  const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
  return { ...projectBoardSchema(doc, board.id), presetBindings: { ...board.preset?.bindings } }
}

function resetToPreset() {
  draft.value = fromPreset(props.preset)
  dirty.value = false
  emit("update:modelValue", draft.value)
}

function markDirty() { dirty.value = true }
function syncStageButtons() {
  draft.value.cardStageButtons = draft.value.columns.filter(column => !column.archive).flatMap(column => column.id ? [{ columnId: column.id }] : [])
}
function addColumn() {
  markDirty()
  draft.value.columns.push({ id: crypto.randomUUID(), title: "" })
  syncStageButtons()
}
function moveColumn(index: number, offset: number) {
  markDirty()
  const [column] = draft.value.columns.splice(index, 1)
  draft.value.columns.splice(index + offset, 0, column!)
  syncStageButtons()
}
function removeColumn(index: number) { markDirty(); draft.value.columns.splice(index, 1); syncStageButtons() }
function addField() {
  markDirty()
  const field = { id: crypto.randomUUID(), title: "", valueType: "text" as const, required: false }
  draft.value.fields.push(field)
  expandedFields.value.push(field.id)
}
function removeField(index: number) { markDirty(); draft.value.fields.splice(index, 1) }
function addOption(field: CreationDraft["fields"][number]) {
  markDirty()
  field.options ??= []
  field.options.push({ id: crypto.randomUUID(), title: "" })
}
function removeOption(field: CreationDraft["fields"][number], index: number) { markDirty(); field.options?.splice(index, 1) }
function setFieldType(field: CreationDraft["fields"][number], value: string) {
  markDirty()
  field.valueType = value as CreationDraft["fields"][number]["valueType"]
  if (field.valueType !== "text") delete field.format
  if (field.valueType !== "select") delete field.options
  if (field.valueType !== "number") { delete field.min; delete field.max }
  if (field.valueType === "select") field.options ??= []
  if (field.valueType === "number") { field.min ??= null; field.max ??= null }
}
function toggleField(id: string) {
  expandedFields.value = expandedFields.value.includes(id)
    ? expandedFields.value.filter(value => value !== id)
    : [...expandedFields.value, id]
}
function toggleOptions(id: string) {
  optionsExpanded.value = optionsExpanded.value.includes(id)
    ? optionsExpanded.value.filter(value => value !== id)
    : [...optionsExpanded.value, id]
}

watch(() => props.preset, () => {
  if (!dirty.value) resetToPreset()
})
watch(draft, value => emit("update:modelValue", value), { deep: true })
onMounted(() => emit("update:modelValue", draft.value))
</script>

<template>
  <fieldset class="creation-config-disabled" :disabled="disabled">
  <section class="creation-config ui-stack" aria-label="Board configuration" @input="markDirty" @change="markDirty">
    <label class="creation-config-item-name">
      <span>Item name</span>
      <input v-model="draft.entityName" aria-label="Item name" />
    </label>

    <fieldset class="creation-config-list">
      <legend>Columns</legend>
      <div v-for="(column, index) in draft.columns" :key="column.id ?? index" class="creation-config-row creation-config-column-row">
        <label>
          <span class="sr-only">Column {{ index + 1 }}</span>
          <input v-model="column.title" :aria-label="`Column ${index + 1}`" />
        </label>
        <div class="creation-config-order">
          <button class="button button-quiet button-small" type="button" :aria-label="`Move column ${index + 1} up`" :disabled="index === 0" @click="moveColumn(index, -1)">↑</button>
          <button class="button button-quiet button-small" type="button" :aria-label="`Move column ${index + 1} down`" :disabled="index === draft.columns.length - 1" @click="moveColumn(index, 1)">↓</button>
        </div>
        <button class="button button-quiet button-small creation-config-column-remove" type="button" :aria-label="`Remove column ${index + 1}`" @click="removeColumn(index)">Remove</button>
      </div>
      <button class="button button-quiet button-small" type="button" @click="addColumn">Add column</button>
    </fieldset>

    <fieldset class="creation-config-list">
      <legend>Fields</legend>
      <section v-for="(field, index) in draft.fields" :key="field.id ?? index" class="creation-config-field" role="group" :aria-label="`Field ${index + 1}`">
        <label class="creation-config-field-name">
          <span class="sr-only">Field name</span>
          <input v-model="field.title" aria-label="Field name" />
        </label>
        <button class="button button-quiet button-small" type="button" :aria-expanded="expandedFields.includes(field.id ?? '')" @click="toggleField(field.id ?? String(index))">{{ expandedFields.includes(field.id ?? '') ? 'Hide field details' : 'Edit field details' }}</button>
        <template v-if="expandedFields.includes(field.id ?? '')">
          <label>
            <span>Field type</span>
            <select :value="field.valueType" aria-label="Field type" @change="setFieldType(field, ($event.target as HTMLSelectElement).value)">
              <option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes or no</option>
              <option value="select">Select</option><option value="url">URL</option><option value="date">Date</option><option value="datetime">Date and time</option>
            </select>
          </label>
          <label v-if="field.valueType === 'text'"><span>Text format</span><select v-model="field.format" aria-label="Text format" @change="markDirty"><option :value="undefined">Plain text</option><option value="markdown">Markdown</option><option value="json">JSON</option><option value="code">Code</option></select></label>
          <label class="creation-config-required"><input v-model="field.required" type="checkbox" aria-label="Required" /> Required</label>
          <div v-if="field.valueType === 'select'" class="creation-config-options">
            <button class="button button-quiet button-small" type="button" :aria-expanded="optionsExpanded.includes(field.id ?? '')" @click="toggleOptions(field.id ?? String(index))">{{ optionsExpanded.includes(field.id ?? '') ? 'Hide options' : 'Edit options' }}</button>
            <div v-if="optionsExpanded.includes(field.id ?? '')" class="creation-config-options-list">
              <div v-for="(option, optionIndex) in field.options ?? []" :key="option.id ?? optionIndex" class="creation-config-row">
                <label><span class="sr-only">Option {{ optionIndex + 1 }}</span><input v-model="option.title" :aria-label="`Option ${optionIndex + 1}`" /></label>
                <button class="button button-quiet button-small" type="button" :aria-label="`Remove option ${optionIndex + 1}`" @click="removeOption(field, optionIndex)">Remove</button>
              </div>
              <button class="button button-quiet button-small" type="button" @click="addOption(field)">Add option</button>
            </div>
          </div>
          <button class="button button-quiet button-small" type="button" :aria-label="`Remove field ${index + 1}`" @click="removeField(index)">Remove field</button>
        </template>
      </section>
      <button class="button button-quiet button-small" type="button" @click="addField">Add field</button>
    </fieldset>

    <button v-if="dirty" class="button button-quiet button-small" type="button" @click="resetToPreset">Reset board defaults</button>
  </section>
  </fieldset>
</template>

<style scoped>
.creation-config-disabled { min-width: 0; margin: 0; padding: 0; border: 0; }
.creation-config { display: grid; gap: var(--space-4); min-width: 0; }
.creation-config-item-name, .creation-config-field > label:not(.creation-config-required) { display: grid; gap: var(--space-1); min-width: 0; color: var(--muted); font: 700 .8rem/1.3 var(--site-font-sans); letter-spacing: .06em; text-transform: uppercase; }
.creation-config-list { display: grid; gap: var(--space-2); min-width: 0; margin: 0; padding: var(--space-3); border: 2px solid var(--line); }
.creation-config-list legend { padding: 0 var(--space-1); color: var(--muted); font: 700 .8rem/1 var(--site-font-sans); letter-spacing: .08em; text-transform: uppercase; }
.creation-config-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); min-width: 0; }
.creation-config-column-row { grid-template-columns: minmax(0, 1fr) auto auto; }
.creation-config-order { display: flex; gap: var(--space-1); }
.creation-config-row input, .creation-config-item-name input, .creation-config-field input, .creation-config-field select { width: 100%; min-width: 0; padding: var(--space-2) var(--space-2); }
.creation-config-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); min-width: 0; padding: var(--space-2); border: 1px solid var(--line); }
.creation-config-field-name { min-width: 0; }
.creation-config-field > label:not(.creation-config-required) { grid-column: 1 / -1; }
.creation-config-required { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-size-compact); font-size: .8rem; }
.creation-config-required input { width: 18px; height: 18px; accent-color: var(--ink); }
.creation-config-options { grid-column: 1 / -1; display: grid; gap: var(--space-2); }
.creation-config-options-list { display: grid; gap: var(--space-2); min-width: 0; }
@media (max-width: 520px) { .creation-config-field { grid-template-columns: minmax(0, 1fr); } .creation-config-field > label:not(.creation-config-required) { grid-column: auto; } .creation-config-options { grid-column: auto; } .creation-config-column-row { grid-template-columns: minmax(0, 1fr) auto; } .creation-config-column-row > label { grid-column: 1 / -1; } .creation-config-order { grid-column: 1; } .creation-config-column-remove { grid-column: 2; } }
</style>
