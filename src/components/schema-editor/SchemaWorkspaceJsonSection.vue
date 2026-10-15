<script setup lang="ts">
import type { SchemaValidationError } from "../../domain/schema";

defineProps<{
  errors: SchemaValidationError[];
  readOnly?: boolean;
  value: string;
}>();

const emit = defineEmits<{
  (event: "update:value", value: string): void;
}>();
</script>

<template>
  <div class="schema-tab-content workspace-json-editor">
    <p>
      Edit settings.json for this workspace. One apply updates workspace title,
      board, columns, card stage buttons, fields, and document templates.
    </p>
    <div v-if="errors.length" class="schema-error-banner" role="alert">
      <strong>Validation errors:</strong>
      <ul>
        <li v-for="(error, index) in errors" :key="index">
          <code v-if="error.path">{{ error.path }}</code
          >: {{ error.message }}
        </li>
      </ul>
    </div>
    <label class="workspace-json-label">
      <span>Workspace settings JSON</span>
      <textarea
        :readonly="readOnly"
        :value="value"
        class="schema-json-textarea"
        rows="22"
        aria-label="Workspace settings JSON"
        spellcheck="false"
        @input="
          emit('update:value', ($event.target as HTMLTextAreaElement).value)
        "
      ></textarea>
    </label>

  </div>
</template>

<style scoped>
textarea.schema-json-textarea {
  font: 400 max(.7rem, 14px)/1.5 var(--site-font-mono);
}
</style>
