<script setup lang="ts">
import DialogWindow from "../DialogWindow.vue";
import type { SchemaDiff } from "../../domain/schema";

defineProps<{
  workspaceId: string;
  diff: SchemaDiff;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "confirm"): void;
}>();
</script>

<template>
  <DialogWindow window-id="schema-preview" :workspace-id="workspaceId" title="Preview schema changes" close-label="Dismiss" @close="emit('close')">
    <section
      class="dialog dialog-window-content schema-preview-dialog"
    >
      <div class="preview-body">
        <p v-if="diff.cardAgingChange">Card aging: {{ diff.cardAgingChange.before }} → {{ diff.cardAgingChange.after }} days</p>
        <section v-if="diff.columnsRenamed.length">
          <h4>Renamed Columns</h4>
          <ul>
            <li v-for="column in diff.columnsRenamed" :key="column.id">
              Rename column: "{{ column.oldTitle }}" → "{{ column.newTitle }}"
            </li>
          </ul>
        </section>
        <section v-if="diff.columnsAdded.length">
          <h4>New Columns</h4>
          <ul>
            <li v-for="(column, index) in diff.columnsAdded" :key="index">
              Add column: "{{ column.title }}"
            </li>
          </ul>
        </section>
        <section v-if="diff.columnsArchived.length">
          <h4 class="preview-danger">Archived Columns</h4>
          <ul>
            <li v-for="column in diff.columnsArchived" :key="column.id">
              Archive: Column "{{ column.title }}" ({{
                column.retainedItemCount
              }}
              card{{ column.retainedItemCount === 1 ? "" : "s" }} will be
              retained for recovery)
            </li>
          </ul>
        </section>
        <section v-if="diff.fieldsAdded.length">
          <h4>New Fields</h4>
          <ul>
            <li v-for="(field, index) in diff.fieldsAdded" :key="index">
              Add field: "{{ field.title }}" ({{ field.valueType }})
            </li>
          </ul>
        </section>
        <section v-if="diff.fieldsModified.length">
          <h4>Modified Fields</h4>
          <ul>
            <li v-for="field in diff.fieldsModified" :key="field.id">
              Field "{{ field.title }}": {{ field.changes.join(", ") }}
            </li>
          </ul>
        </section>
        <section v-if="diff.fieldsArchived.length">
          <h4 class="preview-danger">Archived Fields</h4>
          <ul>
            <li v-for="field in diff.fieldsArchived" :key="field.id">
              Archive: Field "{{ field.title }}" (values will be retained)
            </li>
          </ul>
        </section>
        <p
          v-if="
            !diff.cardAgingChange &&
            !diff.columnsRenamed.length &&
            !diff.columnsAdded.length &&
            !diff.columnsArchived.length &&
            !diff.fieldsAdded.length &&
            !diff.fieldsModified.length &&
            !diff.fieldsArchived.length
          "
        >
          No structural differences detected.
        </p>
      </div>

      <div class="dialog-actions">
        <button
          class="button button-quiet"
          type="button"
          @click="emit('close')"
        >
          Back to editing
        </button>
        <button
          class="button button-primary"
          type="button"
          @click="emit('confirm')"
        >
          Confirm apply
        </button>
      </div>
    </section>
  </DialogWindow>
</template>
