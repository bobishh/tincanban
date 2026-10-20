<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRaw, useId, useSlots, watch } from "vue";
import "./SchemaEditorDialog.css";
import DialogWindow from "./DialogWindow.vue";
import SettingsIdentitySection from "./SettingsIdentitySection.vue";
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
  workspaceId?: string;
  readOnly?: boolean;
  doc: WorkspaceDocumentV2;
  board: Board;
  columns: Column[];
  fields: FieldDefinition[];
  templates: Template[];
  saveTemplate: (input: { id?: string; newId?: string; name: string; markdown: string }) => Promise<string>;
  heads?: Heads;
  saveError?: string;
  saving?: boolean;
  mode: "entity" | "templates";
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (
    event: "apply",
    payload: { schema: BoardSchemaDraft; expectedHeads?: Heads },
  ): void;
  (
    event: "applyWorkspaceSettings",
    payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads },
  ): void;
}>();

const slots = useSlots();
type SettingsTab = "identity" | "workspace" | "templates" | "priority" | "json";
const activeTab = ref<SettingsTab>(slots.identity ? "identity" : "workspace");
const settingsContent = ref<HTMLElement>();
watch(activeTab, async () => {
  await nextTick();
  const content = settingsContent.value;
  if (!content) return;
  content.scrollTop = 0;
  content.getAnimations().forEach(animation => animation.cancel());
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    content.animate([{ opacity: .6 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  }
});
const templateEditor = ref({ id: null as string | null, newId: null as string | null, name: "", markdown: "", saving: false, error: "", notice: "" });
const settingsId = useId();
const compactQuery = window.matchMedia("(max-width: 600px)");
const compactSettings = ref(compactQuery.matches);
const updateCompactSettings = () => { compactSettings.value = compactQuery.matches; };
compactQuery.addEventListener("change", updateCompactSettings);
onBeforeUnmount(() => compactQuery.removeEventListener("change", updateCompactSettings));
const settingsTabs = computed(() => [
  ...(slots.identity ? [{ key: "identity" as const, label: "Identity" }] : []),
  { key: "workspace" as const, label: "Workspace" },
  { key: "templates" as const, label: "Document templates" },
  ...(supportsAutomaticPriority.value ? [{ key: "priority" as const, label: "Priority rules" }] : []),
  { key: "json" as const, label: "settings.json" },
]);
function navigateTabs<T extends string>(event: KeyboardEvent, tabs: T[], active: { value: T }, attribute: string) {
  const index = tabs.indexOf(active.value);
  const target = (event.key === "ArrowDown" || event.key === "ArrowRight") ? (index + 1) % tabs.length
    : (event.key === "ArrowUp" || event.key === "ArrowLeft") ? (index + tabs.length - 1) % tabs.length
    : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
  if (target < 0) return;
  event.preventDefault();
  active.value = tabs[target];
  (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[${attribute}="${active.value}"]`)?.focus();
}
function navigateSettings(event: KeyboardEvent) {
  navigateTabs(event, settingsTabs.value.map(tab => tab.key), activeTab, "data-settings-tab");
}
const draft = ref<BoardSchemaDraft>(
  projectBoardSchema(props.doc, props.board.id),
);
const validationErrors = ref<SchemaValidationError[]>([]);
const showPreview = ref(false);
const schemaDiff = ref<SchemaDiff | null>(null);
const reviewedSchema = ref<BoardSchemaDraft | null>(null);
const reviewedHeads = ref<Heads | undefined>();
const workspaceSettings = ref<WorkspaceSettingsDraft>(
  projectWorkspaceSettings(props.doc, props.board.id),
);
const workspaceJson = ref(JSON.stringify(workspaceSettings.value, null, 2));
const workspaceErrors = ref<SchemaValidationError[]>([]);
const priorityErrors = ref<string[]>([]);
const disabledPolicy = ref<WorkspaceSettingsDraft["board"]["priorityPolicy"]>(null);
watch(workspaceSettings, () => {
  if (activeTab.value !== "json") workspaceJson.value = JSON.stringify(workspaceSettings.value, null, 2);
}, { deep: true });

const editorEntityName = computed(
  () => draft.value.entityName || props.board.entityName || "item",
);
const supportsAutomaticPriority = computed(() => props.fields.some(field => field.valueType === "select" && !field.archivedAt));
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

  reviewedSchema.value = structuredClone(toRaw(draft.value));
  reviewedHeads.value = props.heads ? structuredClone(props.heads) : undefined;
  schemaDiff.value = diffBoardSchema(props.doc, props.board.id, reviewedSchema.value);
  showPreview.value = true;
}

function confirmEntityChanges() {
  if (!reviewedSchema.value) return;
  emit("apply", { schema: reviewedSchema.value, expectedHeads: reviewedHeads.value });
  cancelEntityReview();
}

function cancelEntityReview() {
  showPreview.value = false;
  reviewedSchema.value = null;
  reviewedHeads.value = undefined;
}

function updateWorkspaceJson(value: string) {
  workspaceJson.value = value;
  try {
    const parsed: unknown = JSON.parse(value);
    workspaceErrors.value = validateWorkspaceSettingsDraft(parsed, props.doc).errors;
    if (workspaceErrors.value.length) return;
    const settings = parsed as WorkspaceSettingsDraft;
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
  workspaceSettings.value.board.priorityPolicy = disabledPolicy.value ?? createDefaultPriorityPolicy(
    props.board,
    props.fields,
  );
  priorityErrors.value = priorityPolicy.value
    ? []
    : ["Priority and fit fields are unavailable"];
}

function disableAutomaticPriority() {
  disabledPolicy.value = priorityPolicy.value;
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
  ).errors.filter((error) => error.path.startsWith("/board/priorityPolicy"));
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
  <DialogWindow :window-id="mode === 'entity' ? 'entity-settings' : 'workspace-settings'" :workspace-id="workspaceId ?? 'local'" :title="mode === 'entity' ? `Edit ${editorEntityName}` : 'Settings'" :aria-label="mode === 'entity' ? `Edit ${editorEntityName}` : 'Settings'" close-label="Dismiss" :busy="saving || showPreview" @close="emit('close')">
    <section
      class="dialog dialog-window-content schema-editor-dialog"
      :class="{ 'schema-entity-dialog': mode === 'entity', 'settings-dialog': mode === 'templates' }"
      :inert="showPreview"
    >
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

      <div v-else class="settings-layout">
        <nav class="settings-nav" role="tablist" aria-label="Settings views" :aria-orientation="compactSettings ? 'horizontal' : 'vertical'" @keydown="navigateSettings">
          <button v-for="tab in settingsTabs" :id="`${settingsId}-${tab.key}-tab`" :key="tab.key"
            class="settings-nav-button" :class="{ active: activeTab === tab.key }" type="button" role="tab"
            :data-settings-tab="tab.key" :aria-selected="activeTab === tab.key"
            :aria-controls="`${settingsId}-${tab.key}-panel`" :tabindex="activeTab === tab.key ? 0 : -1"
            @click="activeTab = tab.key">{{ tab.label }}</button>
        </nav>
        <div class="settings-main">
          <div :id="`${settingsId}-${activeTab}-panel`" ref="settingsContent" class="settings-content" role="tabpanel" :aria-labelledby="`${settingsId}-${activeTab}-tab`">
            <KeepAlive><SettingsIdentitySection v-if="activeTab === 'identity'"><slot name="identity" /></SettingsIdentitySection></KeepAlive>
            <template v-if="activeTab !== 'identity'">
              <h3 class="settings-section-title">{{ settingsTabs.find(tab => tab.key === activeTab)?.label }}</h3>
              <p class="dialog-copy">{{ doc.title }}<template v-if="board.title !== doc.title"> · {{ board.title }}</template></p>
              <p v-if="readOnly" class="dialog-copy">Workspace configuration is read-only for your role.</p>
              <p v-if="saveError" class="schema-error-banner" role="alert">{{ saveError }}</p>
              <slot v-if="activeTab === 'workspace'" name="workspace" />
              <template v-else-if="activeTab === 'templates'">
                <p class="dialog-copy">Templates are shared across this workspace.</p>
                <SchemaTemplateSection v-model:editor="templateEditor" :read-only="readOnly" :templates="templates" :save-template="saveTemplate" />
              </template>
              <SchemaPrioritySection v-else-if="activeTab === 'priority'"                 :criterion-fields="criterionFields" :errors="priorityErrors" :policy="priorityPolicy" :priority-options="priorityOptions"
                :read-only="readOnly || saving" @add-rule="addPriorityRule" @disable="disableAutomaticPriority"
                @enable="enableAutomaticPriority" @remove-rule="removePriorityRule" />
              <SchemaWorkspaceJsonSection v-else :errors="workspaceErrors" :read-only="readOnly || saving" :value="workspaceJson" @update:value="updateWorkspaceJson" />
            </template>
          </div>
          <footer v-if="activeTab === 'priority' || activeTab === 'json'" class="settings-save-bar">
            <button class="button button-primary" type="button" :disabled="readOnly || saving || (activeTab === 'json' && workspaceErrors.length > 0)"
              @click="activeTab === 'priority' ? savePriorityRules() : applyWorkspaceJson()">{{ saving ? 'Saving…' : activeTab === 'priority' ? 'Save priority rules' : 'Apply JSON' }}</button>
          </footer>
        </div>
      </div>

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
        :workspace-id="workspaceId ?? 'local'"
        @close="cancelEntityReview"
        @confirm="confirmEntityChanges"
      />
    </section>
  </DialogWindow>
</template>
