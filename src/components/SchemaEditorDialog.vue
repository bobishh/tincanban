<script setup lang="ts">
import { computed, ref, useId, useSlots } from "vue";
import "./SchemaEditorDialog.css";
import ModalLayer from "./ModalLayer.vue";
import SchemaEntitySection from "./schema-editor/SchemaEntitySection.vue";
import SchemaPreviewDialog from "./schema-editor/SchemaPreviewDialog.vue";
import SchemaPrioritySection from "./schema-editor/SchemaPrioritySection.vue";
import SchemaTemplateSection from "./schema-editor/SchemaTemplateSection.vue";
import SchemaWorkspaceJsonSection from "./schema-editor/SchemaWorkspaceJsonSection.vue";
import { compareRanks } from "../domain/ancestry";
import type {
  Board,
  Column,
  FieldDefinition,
  Heads,
  WorkspaceDocumentV2,
} from "../domain/model";
import { emptyEmployeeProfile } from "../domain/jobPriority";
import { createDefaultPriorityPolicy } from "../domain/priority";
import {
  diffBoardSchema,
  projectBoardSchema,
  validateBoardSchemaDraft,
  type BoardSchemaDraft,
  type SchemaDiff,
  type SchemaValidationError,
} from "../domain/schema";
import {
  projectWorkspaceSettings,
  validateWorkspaceSettingsDraft,
  type WorkspaceSettingsDraft,
} from "../domain/workspaceSettings";
import type { Template } from "../types";

const props = defineProps<{
  readOnly?: boolean;
  doc: WorkspaceDocumentV2;
  board: Board;
  columns: Column[];
  fields: FieldDefinition[];
  templates: Template[];
  heads?: Heads;
  saveError?: string;
  mode: "entity" | "templates";
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (
    event: "apply",
    payload: { schema: BoardSchemaDraft; expectedHeads?: Heads },
  ): void;
  (
    event: "saveTemplate",
    payload: { id?: string; name: string; markdown: string },
  ): void;
  (
    event: "applyWorkspaceSettings",
    payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads },
  ): void;
}>();

const slots = useSlots();
const activeTab = ref<"identity" | "workspace" | "connections">(slots.identity ? "identity" : "workspace");
const workspaceTab = ref<"templates" | "priority" | "advanced">("templates");
const settingsId = useId();
const settingsTabs = computed(() => [
  ...(slots.identity ? [{ key: "identity" as const, label: "Identity" }] : []),
  { key: "workspace" as const, label: "Workspace" },
  ...(slots.connections ? [{ key: "connections" as const, label: "Connections" }] : []),
]);
function navigateTabs<T extends string>(event: KeyboardEvent, tabs: T[], active: { value: T }, attribute: string) {
  const index = tabs.indexOf(active.value);
  const target = event.key === "ArrowRight" ? (index + 1) % tabs.length
    : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
    : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
  if (target < 0) return;
  event.preventDefault();
  active.value = tabs[target];
  (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[${attribute}="${active.value}"]`)?.focus();
}
function navigateSettings(event: KeyboardEvent) {
  navigateTabs(event, settingsTabs.value.map(tab => tab.key), activeTab, "data-settings-tab");
}
function navigateWorkspace(event: KeyboardEvent) {
  navigateTabs(event, supportsAutomaticPriority.value ? ["templates", "priority", "advanced"] : ["templates", "advanced"], workspaceTab, "data-workspace-tab");
}
const draft = ref<BoardSchemaDraft>(
  projectBoardSchema(props.doc, props.board.id),
);
const validationErrors = ref<SchemaValidationError[]>([]);
const showPreview = ref(false);
const schemaDiff = ref<SchemaDiff | null>(null);
const workspaceSettings = ref<WorkspaceSettingsDraft>(
  projectWorkspaceSettings(props.doc, props.board.id),
);
const workspaceJson = ref(JSON.stringify(workspaceSettings.value, null, 2));
const workspaceErrors = ref<SchemaValidationError[]>([]);
const priorityErrors = ref<string[]>([]);

const editorEntityName = computed(
  () => draft.value.entityName || props.board.entityName || "item",
);
const supportsAutomaticPriority = computed(() =>
  Boolean(
    props.board.preset?.bindings["field.priority"] &&
      props.board.preset?.bindings["field.fitScore"],
  ),
);
const priorityPolicy = computed(
  () => workspaceSettings.value.board.priorityPolicy ?? null,
);
const criterionFields = computed(() =>
  props.fields.filter(
    (field) =>
      !field.archivedAt &&
      field.id !== priorityPolicy.value?.priorityFieldId &&
      field.id !== priorityPolicy.value?.fitFieldId,
  ),
);
const priorityOptions = computed(() => {
  const field = props.fields.find(
    (item) => item.id === priorityPolicy.value?.priorityFieldId,
  );
  if (!field || field.valueType !== "select") return [];
  return Object.values(field.options)
    .filter((option) => !option.archivedAt)
    .sort((left, right) => compareRanks(left.rank, right.rank))
    .map((option) => ({ id: option.id, title: option.title }));
});

function updateEntityDraft(nextDraft: BoardSchemaDraft) {
  draft.value = nextDraft;
  validateCurrentDraft();
}

function validateCurrentDraft() {
  validationErrors.value = validateBoardSchemaDraft(draft.value).errors;
}

function reviewEntityChanges() {
  validateCurrentDraft();
  if (validationErrors.value.length) return;

  schemaDiff.value = diffBoardSchema(props.doc, props.board.id, draft.value);
  showPreview.value = true;
}

function confirmEntityChanges() {
  emit("apply", { schema: draft.value, expectedHeads: props.heads });
  showPreview.value = false;
}

function updateWorkspaceJson(value: string) {
  workspaceJson.value = value;
  try {
    const parsed: unknown = JSON.parse(value);
    workspaceErrors.value = validateWorkspaceSettingsDraft(parsed, props.doc).errors;
    if (workspaceErrors.value.length) return;
    const settings = parsed as WorkspaceSettingsDraft;
    settings.board.employee_profile ??= emptyEmployeeProfile();
    workspaceSettings.value = settings;
  } catch (error) {
    workspaceErrors.value = [invalidJsonError(error)];
  }
}

function applyWorkspaceJson() {
  updateWorkspaceJson(workspaceJson.value);
  if (workspaceErrors.value.length) return;
  emit("applyWorkspaceSettings", {
    settings: workspaceSettings.value,
    expectedHeads: props.heads,
  });
}

function enableAutomaticPriority() {
  workspaceSettings.value.board.priorityPolicy = createDefaultPriorityPolicy(
    props.board,
    props.fields,
  );
  priorityErrors.value = priorityPolicy.value
    ? []
    : ["Priority and fit fields are unavailable"];
}

function disableAutomaticPriority() {
  workspaceSettings.value.board.priorityPolicy = null;
}

function addPriorityRule() {
  const policy = priorityPolicy.value;
  const field = criterionFields.value[0];
  if (!policy || !field) return;

  policy.rules.push({
    id: crypto.randomUUID(),
    fieldId: field.id,
    operator: defaultRuleOperator(field),
    value: defaultRuleValue(field),
    weight: 1,
  });
}

function removePriorityRule(index: number) {
  priorityPolicy.value?.rules.splice(index, 1);
}

function savePriorityRules() {
  priorityErrors.value = [];
  if (priorityPolicy.value?.evaluator === "weighted-rules-v1" && !priorityPolicy.value.rules.length) {
    priorityErrors.value = ["Add at least one priority rule"];
    return;
  }

  const errors = validateWorkspaceSettingsDraft(
    workspaceSettings.value,
    props.doc,
  ).errors.filter((error) => error.path.startsWith("/board/priorityPolicy") || error.path.startsWith("/board/employee_profile"));
  if (errors.length) {
    priorityErrors.value = errors.map((error) => error.message);
    return;
  }
  emit("applyWorkspaceSettings", {
    settings: workspaceSettings.value,
    expectedHeads: props.heads,
  });
}

function defaultRuleOperator(field: FieldDefinition) {
  return field.valueType === "number" ||
    field.valueType === "select" ||
    field.valueType === "boolean"
    ? "equals"
    : "contains";
}

function defaultRuleValue(field: FieldDefinition): boolean | number | string {
  if (field.valueType === "select")
    return (
      Object.values(field.options).find((option) => !option.archivedAt)?.id ?? ""
    );
  if (field.valueType === "boolean") return true;
  if (field.valueType === "number") return field.min ?? 0;
  return "";
}

function invalidJsonError(error: unknown): SchemaValidationError {
  return {
    path: "",
    message: `Invalid JSON syntax: ${error instanceof Error ? error.message : "unknown error"}`,
  };
}
</script>

<template>
  <ModalLayer
    protect-draft
    class="overlay overlay-level-100"
    @close="emit('close')"
  >
    <section
      class="dialog schema-editor-dialog"
      :class="{ 'schema-entity-dialog': mode === 'entity' }"
      role="dialog"
      aria-modal="true"
      :aria-label="
        mode === 'entity' ? `Edit ${editorEntityName}` : 'Settings'
      "
    >
      <header class="dialog-head">
        <div>
          <span class="eyebrow">{{
            mode === "entity" ? "Entity schema" : "Settings"
          }}</span>
          <h2>
            {{
              mode === "entity"
                ? `Edit ${editorEntityName}`
                : "Settings"
            }}
          </h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Dismiss"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div
        v-if="validationErrors.length"
        class="schema-error-banner"
        role="alert"
      >
        <strong>Validation errors:</strong>
        <ul>
          <li v-for="(error, index) in validationErrors" :key="index">
            <code v-if="error.path">{{ error.path }}</code
            >: {{ error.message }}
          </li>
        </ul>
      </div>

      <SchemaEntitySection
        v-if="mode === 'entity'"
        :model-value="draft"
        @update:model-value="updateEntityDraft"
      />

      <template v-else>
        <nav class="schema-tabs" role="tablist" aria-label="Settings views" @keydown="navigateSettings">
          <button v-for="tab in settingsTabs" :id="`${settingsId}-${tab.key}-tab`" :key="tab.key"
            class="schema-tab-btn" :class="{ active: activeTab === tab.key }" type="button" role="tab"
            :data-settings-tab="tab.key" :aria-selected="activeTab === tab.key"
            :aria-controls="`${settingsId}-${tab.key}-panel`" :tabindex="activeTab === tab.key ? 0 : -1"
            @click="activeTab = tab.key">{{ tab.label }}</button>
        </nav>
        <div v-if="activeTab === 'identity'" :id="`${settingsId}-identity-panel`" class="schema-tab-content" role="tabpanel" :aria-labelledby="`${settingsId}-identity-tab`">
          <slot name="identity" />
        </div>
        <div v-else-if="activeTab === 'connections'" :id="`${settingsId}-connections-panel`" class="schema-tab-content" role="tabpanel" :aria-labelledby="`${settingsId}-connections-tab`">
          <slot name="connections" />
        </div>
        <div v-else :id="`${settingsId}-workspace-panel`" class="schema-tab-content" role="tabpanel" :aria-labelledby="`${settingsId}-workspace-tab`">
          <p v-if="saveError" class="schema-error-banner" role="alert">{{ saveError }}</p>
          <p class="dialog-copy">Workspace: <strong>{{ doc.title }}</strong> · Board: <strong>{{ board.title }}</strong></p>
          <p v-if="readOnly" class="dialog-copy">Workspace configuration is read-only for your role.</p>
          <slot name="publication" />
          <nav class="schema-tabs schema-workspace-tabs" role="tablist" aria-label="Workspace configuration" @keydown="navigateWorkspace">
            <button :id="`${settingsId}-templates-tab`" class="schema-tab-btn" :class="{ active: workspaceTab === 'templates' }" type="button" role="tab"
              :aria-selected="workspaceTab === 'templates'" :tabindex="workspaceTab === 'templates' ? 0 : -1"
              data-workspace-tab="templates" :aria-controls="`${settingsId}-templates-panel`" @click="workspaceTab = 'templates'">Document templates</button>
            <button v-if="supportsAutomaticPriority" :id="`${settingsId}-priority-tab`" class="schema-tab-btn" :class="{ active: workspaceTab === 'priority' }" type="button" role="tab"
              :aria-selected="workspaceTab === 'priority'" :tabindex="workspaceTab === 'priority' ? 0 : -1"
              data-workspace-tab="priority" :aria-controls="`${settingsId}-priority-panel`" @click="workspaceTab = 'priority'">Priority rules</button>
            <button :id="`${settingsId}-advanced-tab`" class="schema-tab-btn" :class="{ active: workspaceTab === 'advanced' }" type="button" role="tab"
              :aria-selected="workspaceTab === 'advanced'" :tabindex="workspaceTab === 'advanced' ? 0 : -1"
              data-workspace-tab="advanced" :aria-controls="`${settingsId}-advanced-panel`" @click="workspaceTab = 'advanced'">Advanced configuration</button>
          </nav>
          <div v-if="workspaceTab === 'templates'" :id="`${settingsId}-templates-panel`" role="tabpanel" :aria-labelledby="`${settingsId}-templates-tab`">
            <p class="dialog-copy">Templates are shared across this workspace.</p>
            <SchemaTemplateSection :read-only="readOnly" :templates="templates" @save="emit('saveTemplate', $event)" />
          </div>
          <div v-else-if="workspaceTab === 'priority'" :id="`${settingsId}-priority-panel`" role="tabpanel" :aria-labelledby="`${settingsId}-priority-tab`">
            <p class="dialog-copy">Priority rules apply to {{ board.title }}.</p>
            <SchemaPrioritySection :employee-profile="workspaceSettings.board.employee_profile!" :criterion-fields="criterionFields" :errors="priorityErrors" :policy="priorityPolicy"
              :priority-options="priorityOptions" :read-only="readOnly" @add-rule="addPriorityRule" @disable="disableAutomaticPriority"
              @enable="enableAutomaticPriority" @remove-rule="removePriorityRule" @save="savePriorityRules" />
          </div>
          <div v-else :id="`${settingsId}-advanced-panel`" role="tabpanel" :aria-labelledby="`${settingsId}-advanced-tab`">
            <SchemaWorkspaceJsonSection :errors="workspaceErrors" :read-only="readOnly" :value="workspaceJson"
              @apply="applyWorkspaceJson" @update:value="updateWorkspaceJson" />
          </div>
        </div>
      </template>

      <footer
        v-if="mode === 'entity'"
        class="dialog-actions schema-dialog-actions"
      >
        <button
          class="button button-quiet"
          type="button"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          class="button button-primary"
          type="button"
          :disabled="validationErrors.length > 0"
          @click="reviewEntityChanges"
        >
          Review changes
        </button>
      </footer>

      <SchemaPreviewDialog
        v-if="showPreview && schemaDiff"
        :diff="schemaDiff"
        @close="showPreview = false"
        @confirm="confirmEntityChanges"
      />
    </section>
  </ModalLayer>
</template>
