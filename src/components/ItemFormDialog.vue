<script setup lang="ts">
import DialogWindow from "./DialogWindow.vue"
import { computed, defineAsyncComponent, reactive, ref, type Component } from "vue"
import { useDelayedFlag } from "../ui/useDelayedFlag"
import type { Column, FieldDefinition, FieldValue, Item } from "../domain/model"
import { validateFieldValue } from "../domain/fields"
import type { NarrativeFoldSources } from "../domain/commandTypes"

const ItemEditWindow = defineAsyncComponent<Component>(() => import("./SpatialWindow.vue"))
const props = defineProps<{
  workspaceId?: string
  parentId: string
  entityName?: string
  fields: FieldDefinition[]
  columns?: Array<Column & { formValue?: string }>
  item?: Item | null
  showCoreFields?: boolean
  hiddenFieldIds?: string[]
  computedFieldsMessage?: string
  requiredNarrative?: boolean
  optionValues?: Record<string, string>
  initialTitle?: string
  initialBody?: string
  foldSnapshot?: NarrativeFoldSources
  initialValues?: Record<string, FieldValue>
  errorMessage?: string
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: "cancel"): void
  (e: "save", payload: { title: string; body: string; parentId?: string; values: Record<string, FieldValue>; foldSnapshot?: NarrativeFoldSources }): void
}>()

const selectedParentId = ref(props.parentId)
const title = ref(props.item?.title ?? props.initialTitle ?? "")
const body = ref(props.initialBody ?? props.item?.body ?? "")
const values = reactive<Record<string, FieldValue>>({ ...(props.initialValues ?? props.item?.values ?? {}) })
for (const field of props.fields) {
  const fieldValue = values[field.id]
  if (field.valueType === "select" && typeof fieldValue === "string") {
    values[field.id] = props.optionValues?.[fieldValue] ?? fieldValue
  }
}
const localError = ref("")
const showSaving = useDelayedFlag(() => Boolean(props.saving))
const surfaceProps = computed(() => props.item ? {
  windowId: `item-edit:${props.item.id}`, workspaceId: props.workspaceId ?? "local",
  title: `Edit ${props.entityName || 'item'}`, ariaLabel: "Edit item", closeLabel: "Dismiss",
  initialWidth: 720, initialHeight: 700, busy: props.saving, class: "item-editor-window",
} : {
  windowId: `item-create:${props.parentId}`,
  workspaceId: props.workspaceId ?? "local",
  title: props.showCoreFields !== false ? `${props.entityName || "Item"} details` : `Add ${props.entityName || "item"}`,
  ariaLabel: props.showCoreFields !== false ? "Item details" : "Add item",
  closeLabel: "Dismiss",
  busy: props.saving,
  initialWidth: 720,
  initialHeight: 680,
})

// Materialize schema metadata once per schema change. Draft keystrokes must not
// repeatedly traverse Automerge proxies or rebuild every select's options.
const formFields = computed(() => props.fields
  .filter(field => !field.archivedAt && !props.hiddenFieldIds?.includes(field.id))
  .map(field => ({
    id: field.id,
    title: field.title,
    required: field.required,
    valueType: field.valueType,
    format: field.valueType === "text" ? field.format : undefined,
    min: field.valueType === "number" ? field.min : undefined,
    max: field.valueType === "number" ? field.max : undefined,
    options: field.valueType === "select"
      ? Object.values(field.options || {}).filter(option => !option.archivedAt)
        .map(option => ({ id: option.id, title: option.title, value: props.optionValues?.[option.id] ?? option.id }))
      : [],
  })))
const formColumns = computed(() => props.columns?.map(column => ({
  id: column.id, title: column.title, value: column.formValue ?? column.id,
})) ?? [])

function invalidFieldMessage(): string | undefined {
  for (const field of props.fields) {
    if (field.archivedAt || props.hiddenFieldIds?.includes(field.id)) continue
    const value = values[field.id]
    const selected = field.valueType === "select" && typeof value === "string"
      ? Object.values(field.options).find(option => props.optionValues?.[option.id] === value)
      : undefined
    const res = validateFieldValue(field, selected?.id ?? values[field.id])
    if (!res.valid) return res.issue || `${field.title} is required`
  }
}

function savedFieldValues() {
  const savedValues: Record<string, FieldValue> = { ...(props.item?.values ?? {}), ...values }
  for (const field of props.fields) {
    if (field.valueType !== "select") continue
    const value = savedValues[field.id]
    const selected = typeof value === "string" ? Object.values(field.options).find(option => props.optionValues?.[option.id] === value) : undefined
    if (selected) savedValues[field.id] = selected.id
  }
  return savedValues
}

function handleSave() {
  if (props.saving) return
  localError.value = ""
  if (props.showCoreFields !== false && !title.value.trim()) { localError.value = "Title is required"; return }
  if (props.requiredNarrative && !body.value.trim()) { localError.value = "Description is required"; return }
  const invalidMessage = invalidFieldMessage()
  if (invalidMessage) { localError.value = invalidMessage; return }

  emit("save", {
    title: title.value.trim(),
    body: body.value,
    parentId: selectedParentId.value,
    values: savedFieldValues(),
    foldSnapshot: props.foldSnapshot,
  })
}
</script>

<template>
  <component :is="item ? ItemEditWindow : DialogWindow" v-bind="surfaceProps" @close="emit('cancel')">
    <section :class="item ? 'item-edit-content' : 'dialog dialog-window-content'">
      <form class="item-form" novalidate :aria-busy="saving" @submit.prevent="handleSave">
        <div class="item-form-content">
        <fieldset class="form-grid" :disabled="saving">
          <label v-if="showCoreFields !== false" class="wide">
            <span>Title *</span>
            <input v-model="title" autofocus required placeholder="Item title" />
          </label>

          <label v-if="formColumns.length" class="wide">
            <span>Status *</span>
            <select v-model="selectedParentId">
              <option v-for="col in formColumns" :key="col.id" :value="col.value">
                {{ col.title }}
              </option>
            </select>
          </label>

          <label class="wide">
            <span>{{ showCoreFields !== false ? 'Body' : `Description${requiredNarrative ? ' *' : ''}` }}</span>
            <textarea v-model="body" rows="3" placeholder="Description or notes..."></textarea>
          </label>

          <p v-if="computedFieldsMessage" class="wide computed-priority-note">{{ computedFieldsMessage }}</p>

          <template v-for="field in formFields" :key="field.id">
            <label>
              <span>{{ field.title }}{{ field.required ? " *" : "" }}</span>
              <textarea v-if="field.valueType === 'text'" :value="String(values[field.id] ?? '')" @input="values[field.id] = ($event.target as HTMLTextAreaElement).value" rows="3" :required="field.required" :class="{ 'field-code': field.format === 'json' || field.format === 'code' }" />
              <input
                v-else-if="field.valueType === 'url'"
                v-model="values[field.id]"
                :type="field.valueType === 'url' ? 'url' : 'text'"
                :required="field.required"
              />
              <input
                v-else-if="field.valueType === 'number'"
                v-model.number="values[field.id]"
                type="number"
                :required="field.required"
                :min="field.min ?? undefined"
                :max="field.max ?? undefined"
              />
              <input
                v-else-if="field.valueType === 'date'"
                v-model="values[field.id]"
                type="date"
                :required="field.required"
              />
              <input
                v-else-if="field.valueType === 'datetime'"
                v-model="values[field.id]"
                type="datetime-local"
                :required="field.required"
              />
              <input
                v-else-if="field.valueType === 'boolean'"
                v-model="values[field.id]"
                type="checkbox"
              />
              <select
                v-else-if="field.valueType === 'select'"
                v-model="values[field.id]"
                :required="field.required"
              >
                <option value="">Select option</option>
                <option
                  v-for="opt in field.options"
                  :key="opt.id"
                  :value="opt.value"
                >
                  {{ opt.title }}
                </option>
              </select>
            </label>
          </template>
        </fieldset>
        </div>
        <footer class="item-form-footer">
        <p v-if="localError || errorMessage" role="alert" class="form-error form-error-spaced">
          {{ localError || errorMessage }}
        </p>

        <div class="dialog-actions">
          <button class="button button-quiet" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button>
          <button class="button button-primary" type="submit" :disabled="saving">{{ showSaving ? 'Saving…' : errorMessage ? 'Retry save' : item ? 'Save changes' : showCoreFields !== false ? 'Save item' : 'Create item' }}</button>
        </div>
        </footer>
      </form>
    </section>
  </component>
</template>

<style scoped>
.field-code { font-family: monospace; }
.item-form { display: grid; gap: var(--section-gap); min-width: 0; }
.item-form-content { min-width: 0; }
.item-form-footer { display: grid; gap: var(--field-gap); }
.item-form-footer .dialog-actions { margin: 0; }
.item-edit-content { height: 100%; min-height: 0; padding: var(--surface-padding); }
.item-edit-content .item-form { height: 100%; grid-template-rows: minmax(0, 1fr) auto; gap: var(--space-4); }
.item-edit-content .item-form-content { overflow: auto; padding: var(--focus-room); scrollbar-gutter: stable; }
.item-edit-content .item-form-footer { padding: var(--focus-room) var(--focus-room) var(--space-4); border-top: 1px solid var(--soft); }
@media (max-width: 600px) { .item-edit-content { padding: var(--space-2); } }
</style>
<style>
.item-editor-window .spatial-body { overflow: hidden; }
</style>
