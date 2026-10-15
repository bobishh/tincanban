<script setup lang="ts">
import { ref } from "vue";
import type { BoardSchemaDraft } from "../../domain/schema";

type BoardSchemaField = BoardSchemaDraft["fields"][number];

const props = defineProps<{
  modelValue: BoardSchemaDraft;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: BoardSchemaDraft): void;
}>();

const showAddField = ref(false);
const newFieldTitle = ref("");
const newFieldValueType = ref<BoardSchemaField["valueType"]>("text");
const newFieldRequired = ref(false);
const newFieldOptions = ref("");

function cancelAddField() {
  resetAddField();
}

function addField() {
  const title = newFieldTitle.value.trim();
  if (!title) return;

  const field: BoardSchemaField = {
    id: `fld_${crypto.randomUUID().slice(0, 8)}`,
    title,
    valueType: newFieldValueType.value,
    required: newFieldRequired.value,
    options: selectOptions(),
  };
  emit("update:modelValue", {
    ...props.modelValue,
    fields: [...props.modelValue.fields, field],
  });
  resetAddField();
}

function removeField(index: number) {
  emit("update:modelValue", {
    ...props.modelValue,
    fields: props.modelValue.fields.filter(
      (_, fieldIndex) => fieldIndex !== index,
    ),
  });
}

function updateEntityName(event: Event) {
  const entityName = (event.target as HTMLInputElement).value;
  emit("update:modelValue", { ...props.modelValue, entityName });
}

function updateAgingThreshold(name: "watch" | "aged" | "overdue", event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  emit("update:modelValue", {
    ...props.modelValue,
    cardAgingPolicy: {
      version: 1,
      thresholds: { ...(props.modelValue.cardAgingPolicy?.thresholds ?? { watch: 7, aged: 14, overdue: 30 }), [name]: value },
    },
  });
}

function selectOptions(): BoardSchemaField["options"] {
  if (newFieldValueType.value !== "select") return undefined;
  return newFieldOptions.value
    .split(",")
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title) => ({ id: `opt_${crypto.randomUUID().slice(0, 8)}`, title }));
}

function resetAddField() {
  newFieldTitle.value = "";
  newFieldValueType.value = "text";
  newFieldRequired.value = false;
  newFieldOptions.value = "";
  showAddField.value = false;
}
</script>

<template>
  <div class="schema-tab-content">
    <section class="schema-section">
      <label class="schema-field-label">
        <span>Entity name</span>
        <input
          :value="modelValue.entityName"
          class="schema-input"
          placeholder="Item"
          @input="updateEntityName"
        />
      </label>
    </section>

    <section class="schema-section">
      <header class="schema-section-head"><h3>Card aging</h3></header>
      <p class="schema-help">Cards become tinted after this many days without a meaningful update. Archived cards and columns named Done, Complete, or Completed are excluded.</p>
      <div class="schema-aging-fields ui-grid">
        <label><span>Watch after days</span><input :value="modelValue.cardAgingPolicy?.thresholds.watch ?? 7" min="1" type="number" @input="updateAgingThreshold('watch', $event)" /></label>
        <label><span>Aged after days</span><input :value="modelValue.cardAgingPolicy?.thresholds.aged ?? 14" min="1" type="number" @input="updateAgingThreshold('aged', $event)" /></label>
        <label><span>Stale after days</span><input :value="modelValue.cardAgingPolicy?.thresholds.overdue ?? 30" min="1" type="number" @input="updateAgingThreshold('overdue', $event)" /></label>
      </div>
    </section>

    <section class="schema-section">
      <header class="schema-section-head">
        <h3>Custom Fields</h3>
        <button
          v-if="!showAddField"
          class="button button-small"
          type="button"
          @click="showAddField = true"
        >
          + Add field
        </button>
      </header>

      <form
        v-if="showAddField"
        class="schema-add-field-form"
        @submit.prevent="addField"
      >
        <label>
          <span>Field name</span>
          <input
            v-model="newFieldTitle"
            class="schema-input"
            placeholder="e.g. Severity"
          />
        </label>
        <label>
          <span>Type</span>
          <select v-model="newFieldValueType" class="schema-select">
            <option value="text">text</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="select">select</option>
            <option value="url">url</option>
            <option value="date">date</option>
            <option value="datetime">datetime</option>
          </select>
        </label>
        <label v-if="newFieldValueType === 'select'">
          <span>Options (comma-separated)</span>
          <input
            v-model="newFieldOptions"
            class="schema-input"
            placeholder="e.g. Low, Medium, High"
          />
        </label>
        <label class="schema-checkbox-label">
          <input v-model="newFieldRequired" type="checkbox" />
          <span>Required</span>
        </label>
        <div class="schema-add-field-actions">
          <button
            class="button button-quiet"
            type="button"
            @click="cancelAddField"
          >
            Cancel
          </button>
          <button class="button button-primary" type="submit">
            Save field
          </button>
        </div>
      </form>

      <div class="schema-fields-list">
        <article
          v-for="(field, index) in modelValue.fields"
          :key="field.id || index"
          class="schema-field-item"
        >
          <header class="schema-field-item-head">
            <span class="field-item-header">
              <strong>{{ field.title }}</strong>
              <span class="field-type">{{ field.valueType }}</span>
              <span v-if="field.required" class="required-badge">Required</span>
            </span>
            <button
              class="button button-small button-danger"
              type="button"
              :aria-label="`Remove ${field.title} field`"
              @click="removeField(index)"
            >
              Remove
            </button>
          </header>
          <div v-if="field.valueType === 'select'" class="schema-options-box">
            <div class="options-pills">
              <span
                v-for="option in field.options || []"
                :key="option.id || option.title"
                class="option-pill"
              >
                {{ option.title }}
              </span>
              <span
                v-if="!(field.options && field.options.length)"
                class="no-options"
                >No options yet</span
              >
            </div>
          </div>
        </article>
        <p
          v-if="!modelValue.fields.length && !showAddField"
          class="schema-empty-state"
        >
          No custom fields defined on this board.
        </p>
      </div>
    </section>
  </div>
</template>
