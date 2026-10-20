<script setup lang="ts">
import type { FieldDefinition, Item } from "../domain/entitySchemas"
import { displayFieldValue } from "../domain/cardPresentation"
import { MarkdownContent } from "../ui/markdownContent"
const props = defineProps<{ fields: FieldDefinition[]; item: Item }>()

function isWideField(field: FieldDefinition) {
  const value = displayFieldValue(field, props.item.values[field.id])
  if (field.valueType === "text" && (field.format === "markdown" || field.format === "json" || field.format === "code")) return true
  if (field.valueType === "text" && (value.length >= 120 || value.includes("\n"))) return true
  return value.length >= 120
}
</script>

<template>
  <dl class="configured-card-fields" data-discussion-text data-discussion-field="fields">
    <template v-for="field in fields" :key="field.id">
      <div v-if="displayFieldValue(field, item.values[field.id])" class="configured-card-field" :class="{ 'configured-card-field-wide': isWideField(field) }" :data-field-id="field.id">
        <dt class="detail-label">{{ field.title }}</dt>
        <dd data-discussion-text :data-discussion-field="field.id">
          <MarkdownContent v-if="field.valueType === 'text' && field.format === 'markdown'" class="configured-card-markdown reading-prose" :source="displayFieldValue(field, item.values[field.id])" />
          <pre v-else-if="field.valueType === 'text' && (field.format === 'json' || field.format === 'code')"><code>{{ displayFieldValue(field, item.values[field.id]) }}</code></pre>
          <a v-else-if="field.valueType === 'url' && /^https?:\/\//.test(displayFieldValue(field, item.values[field.id]))" :href="displayFieldValue(field, item.values[field.id])" target="_blank" rel="noreferrer">{{ displayFieldValue(field, item.values[field.id]) }}</a>
          <span v-else class="configured-card-text">{{ displayFieldValue(field, item.values[field.id]) }}</span>
        </dd>
      </div>
    </template>
  </dl>
</template>

<style scoped>
.configured-card-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); align-items: start; gap: var(--space-4); min-width: 0; margin: 0; }
.configured-card-field, dd { min-width: 0; margin: 0; }
.configured-card-field-wide { grid-column: 1 / -1; }
.configured-card-field-wide dd { max-width: min(80ch, 100%); }
.configured-card-text { white-space: pre-wrap; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; margin: 0; }
.configured-card-markdown { min-width: 0; }
a { color: var(--ink); text-decoration-thickness: 1px; text-underline-offset: 2px; overflow-wrap: anywhere; word-break: break-word; }
a:hover { color: var(--blue); }
:deep(.configured-card-markdown a) { color: var(--ink); text-decoration-thickness: 1px; text-underline-offset: 2px; overflow-wrap: anywhere; word-break: break-word; }
:deep(.configured-card-markdown a:hover) { color: var(--blue); }
</style>
