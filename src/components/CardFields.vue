<script setup lang="ts">
import type { FieldDefinition, Item } from "../domain/entitySchemas"
import { displayFieldValue } from "../domain/cardPresentation"
import { MarkdownContent } from "../ui/markdownContent"
defineProps<{ fields: FieldDefinition[]; item: Item }>()
</script>

<template>
  <dl class="configured-card-fields">
    <template v-for="field in fields" :key="field.id">
      <div v-if="displayFieldValue(field, item.values[field.id])" class="configured-card-field" :data-field-id="field.id">
        <dt class="detail-label">{{ field.title }}</dt>
        <dd data-discussion-text :data-discussion-field="field.id">
          <MarkdownContent v-if="field.valueType === 'text' && field.format === 'markdown'" :source="displayFieldValue(field, item.values[field.id])" />
          <pre v-else-if="field.valueType === 'text' && (field.format === 'json' || field.format === 'code')"><code>{{ displayFieldValue(field, item.values[field.id]) }}</code></pre>
          <a v-else-if="field.valueType === 'url' && /^https?:\/\//.test(displayFieldValue(field, item.values[field.id]))" :href="displayFieldValue(field, item.values[field.id])" target="_blank" rel="noreferrer">{{ displayFieldValue(field, item.values[field.id]) }}</a>
          <span v-else class="configured-card-text">{{ displayFieldValue(field, item.values[field.id]) }}</span>
        </dd>
      </div>
    </template>
  </dl>
</template>

<style scoped>
.configured-card-fields { display: grid; gap: var(--space-4); min-width: 0; margin: 0; }
.configured-card-field, dd { min-width: 0; margin: 0; }
.configured-card-text { white-space: pre-wrap; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; margin: 0; }
a { overflow-wrap: anywhere; }
</style>
