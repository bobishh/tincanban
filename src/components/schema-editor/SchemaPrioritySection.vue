<script setup lang="ts">
import { computed } from "vue";
import type { FieldDefinition, PriorityPolicy } from "../../domain/model";

type RuleOperator = "equals" | "at_least" | "at_most" | "is_set" | "contains";

const props = defineProps<{
  criterionFields: FieldDefinition[];
  errors: string[];
  policy: PriorityPolicy | null;
  priorityOptions: Array<{ id: string; title: string }>;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  (event: "add-rule"): void;
  (event: "disable"): void;
  (event: "enable"): void;
  (event: "remove-rule", index: number): void;
}>();

const currentPolicy = computed(() => props.policy);
function fieldForRule(fieldId: string) {
  return props.criterionFields.find((field) => field.id === fieldId);
}

function optionsForRule(fieldId: string) {
  const field = fieldForRule(fieldId);
  if (!field || field.valueType !== "select") return [];
  return Object.values(field.options)
    .filter((option) => !option.archivedAt)
    .map((option) => ({ id: option.id, title: option.title }));
}

function operatorsFor(
  fieldId: string,
): Array<{ value: RuleOperator; label: string }> {
  const field = fieldForRule(fieldId);
  if (field?.valueType === "number") {
    return [
      { value: "equals", label: "equals" },
      { value: "at_least", label: "at least" },
      { value: "at_most", label: "at most" },
      { value: "is_set", label: "is set" },
    ];
  }
  if (field && ["text", "url"].includes(field.valueType)) {
    return [
      { value: "contains", label: "contains" },
      { value: "equals", label: "equals" },
      { value: "is_set", label: "is set" },
    ];
  }
  return [
    { value: "equals", label: "equals" },
    { value: "is_set", label: "is set" },
  ];
}

function resetRule(index: number) {
  const policy = currentPolicy.value;
  if (!policy) return;
  const rule = policy.rules[index];
  const field = fieldForRule(rule.fieldId);
  if (!field) return;

  rule.operator =
    field.valueType === "number" ||
    field.valueType === "select" ||
    field.valueType === "boolean"
      ? "equals"
      : "contains";
  rule.value = defaultRuleValue(field);
}

function defaultRuleValue(field: FieldDefinition): boolean | number | string {
  if (field.valueType === "select") {
    return (
      Object.values(field.options).find((option) => !option.archivedAt)?.id ?? ""
    );
  }
  if (field.valueType === "boolean") return true;
  if (field.valueType === "number") return field.min ?? 0;
  return "";
}
</script>

<template>
  <div class="schema-tab-content priority-settings">
    <label class="priority-toggle"><input type="checkbox" role="switch" :checked="!!currentPolicy" :disabled="readOnly" @change="($event.target as HTMLInputElement).checked ? emit('enable') : emit('disable')" />Automatic priority</label>
    <p class="dialog-copy">Calculate values from configured fields and weighted rules.</p>
    <div v-if="errors.length" class="schema-error-banner" role="alert">
      {{ errors[0] }}
    </div>

    <template v-if="currentPolicy">
      <header class="priority-settings-head">
        <div>
          <h3>Automatic priority</h3>
          <p>
            Matching rules add points. Fit is clamped to 0–10; priority follows
            the thresholds.
          </p>
        </div>

      </header>

      <label class="priority-order">
        <span>Card order</span>
        <select
          v-model="currentPolicy.sort"
          aria-label="Card order"
          :disabled="readOnly"
        >
          <option value="fit_desc">Highest fit first</option>
          <option value="fit_asc">Lowest fit first</option>
          <option value="manual">Manual order</option>
        </select>
      </label>

      <fieldset
        v-if="currentPolicy.evaluator === 'weighted-rules-v1'"
        :disabled="readOnly"
        class="priority-rules"
        aria-label="Weighted criteria"
      >
        <div
          v-for="(rule, index) in currentPolicy.rules"
          :key="rule.id"
          class="priority-rule-row"
        >
          <label>
            <span>Criterion</span>
            <select
              v-model="rule.fieldId"
              :aria-label="`Criterion field ${index + 1}`"
              @change="resetRule(index)"
            >
              <option
                v-for="field in criterionFields"
                :key="field.id"
                :value="field.id"
              >
                {{ field.title }}
              </option>
            </select>
          </label>
          <label>
            <span>Match</span>
            <select
              v-model="rule.operator"
              :aria-label="`Rule operator ${index + 1}`"
            >
              <option
                v-for="operator in operatorsFor(rule.fieldId)"
                :key="operator.value"
                :value="operator.value"
              >
                {{ operator.label }}
              </option>
            </select>
          </label>
          <label v-if="rule.operator !== 'is_set'">
            <span>Value</span>
            <select
              v-if="fieldForRule(rule.fieldId)?.valueType === 'select'"
              v-model="rule.value"
              :aria-label="`Preferred value ${index + 1}`"
            >
              <option
                v-for="option in optionsForRule(rule.fieldId)"
                :key="option.id"
                :value="option.id"
              >
                {{ option.title }}
              </option>
            </select>
            <select
              v-else-if="fieldForRule(rule.fieldId)?.valueType === 'boolean'"
              v-model="rule.value"
              :aria-label="`Preferred value ${index + 1}`"
            >
              <option :value="true">Yes</option>
              <option :value="false">No</option>
            </select>
            <input
              v-else-if="fieldForRule(rule.fieldId)?.valueType === 'number'"
              v-model.number="rule.value"
              type="number"
              :aria-label="`Preferred value ${index + 1}`"
            />
            <input
              v-else
              v-model="rule.value"
              :aria-label="`Preferred value ${index + 1}`"
            />
          </label>
          <label>
            <span>Points</span>
            <input
              v-model.number="rule.weight"
              type="number"
              min="-10"
              max="10"
              :aria-label="`Points ${index + 1}`"
            />
          </label>
          <button
            class="button button-small button-danger priority-rule-remove"
            type="button"
            :aria-label="`Remove ${fieldForRule(rule.fieldId)?.title ?? 'criterion'} rule`"
            @click="emit('remove-rule', index)"
          >
            Remove
          </button>
        </div>
        <button
          class="button button-small"
          type="button"
          :disabled="!criterionFields.length"
          @click="emit('add-rule')"
        >
          + Add criterion
        </button>
      </fieldset>

      <fieldset
        :disabled="readOnly"
        class="priority-thresholds"
        aria-label="Priority thresholds"
      >
        <legend>Priority thresholds</legend>
        <label v-for="band in currentPolicy.bands" :key="band.optionId">
          <span
            >{{
              priorityOptions.find((option) => option.id === band.optionId)
                ?.title ?? "Priority"
            }}
            minimum</span
          >
          <input
            v-model.number="band.minScore"
            type="number"
            min="0"
            max="10"
          />
        </label>
      </fieldset>
    </template>

    <section v-else class="priority-empty">
      <h3>Manual priority</h3>
      <p>
        Values are set manually. Enable automatic priority and configure rules to calculate values from fields.
      </p>

    </section>


  </div>
</template>

<style scoped>
.priority-profile { display: grid; gap: var(--space-3); min-width: 0; margin: 0; padding: var(--space-3); }
.priority-toggle { display: flex; align-items: center; gap: var(--space-2); }
.priority-profile-import { display: grid; gap: var(--space-2); justify-items: start; }
.priority-profile label { display: grid; gap: var(--space-2); }
</style>
