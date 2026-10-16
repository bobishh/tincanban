<script setup lang="ts">
import { MarkdownContent } from "../ui/markdownContent"
import { defineAsyncComponent, type Component } from "vue"
import SpatialWindow from "./SpatialWindow.vue"
import QuickNoteForm from "./QuickNoteForm.vue"
import type { Item, FieldDefinition, Column } from "../domain/entitySchemas"
import type { HistoryEntry } from "../domain/historyTypes"
import type { Document, DocumentInput } from "../types"
import CardStageStrip from "./CardStageStrip.vue"
import type { CardStageButton } from "../domain/cardStageButtons"
const ItemHistoryPanel = defineAsyncComponent<Component>(() => import("./ItemHistoryPanel.vue"))
import type { AttachmentCoverageStatus } from "./attachmentCoveragePresentation"

const props = defineProps<{
  workspaceId?: string
  attachmentCoverage?: Record<string, AttachmentCoverageStatus[]>
  readOnly?: boolean
  item: Item
  columns: Column[]
  cardStageButtons: CardStageButton[]
  moveToColumn: (item: Item, columnId: string) => Promise<void>
  archived?: boolean
  narrative: string
  narrativeFieldId?: string
  subitems: Item[]
  fields: FieldDefinition[]
  documents: Document[]
  saveDocument: (document: Omit<DocumentInput, "leadId">) => Promise<void>
  updateDocument: (documentId: string, content: string) => Promise<void>
  history?: HistoryEntry[]
  historyNames?: Record<string, string>
  historyLoading?: boolean
  historyError?: string
  historyNotice?: string
  historyHasMore?: boolean
  archiveError?: string
  restoreSaving?: boolean
  restoreError?: string
  restoreNotice?: string
  quickNote: string
  noteSaving?: boolean
  noteError?: string
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "edit", item: Item): void
  (e: "addSubitem", parentItemId: string): void
  (e: "startMove", item: Item): void
  (e: "archiveItem", itemId: string): void
  (e: "restoreItem", itemId: string): void
  (e: "restoreVersion", changeHash: string): void
  (e: "loadEarlierHistory"): void
  (e: "update:quickNote", value: string): void
  (e: "saveNote"): void
  (e: "updateMarkdown", item: Item, markdown: string): void
}>()
</script>

<template>
  <SpatialWindow :window-id="`item:${item.id}`" :workspace-id="props.workspaceId ?? 'local'" :title="item.title" aria-label="Item overview" close-label="Dismiss" @close="emit('close')">
      <template #header>
      <div class="detail-head" :data-discussion-item="item.id">
        <div>
          <span class="eyebrow">Item</span>
          <h2 data-discussion-text data-discussion-field="title">{{ item.title }}</h2>
        </div>
        <div class="detail-head-actions">
          <button class="button button-small" type="button" :disabled="readOnly" @click="emit('edit', item)">Edit</button>
        </div>
      </div>

      </template>
    <section class="detail-dialog" :data-discussion-item="item.id">
      <div class="detail-scroll detail-layout" data-detail-layout>
        <aside class="detail-inspector" data-detail-inspector aria-label="Item actions and properties">
          <CardStageStrip :item="item" :columns="columns" :buttons="cardStageButtons" :read-only="readOnly" :move="moveToColumn" />
          <QuickNoteForm
            :model-value="quickNote"
            :saving="noteSaving"
            :error="noteError"
            :read-only="readOnly"
            @update:model-value="emit('update:quickNote', $event)"
            @save="emit('saveNote')"
          />

          <div v-if="fields.length" class="detail-grid" data-discussion-text data-discussion-field="overview">
            <template v-for="field in fields" :key="field.id">
              <div v-if="item.values[field.id] !== undefined && item.values[field.id] !== null && item.values[field.id] !== ''">
                <span class="detail-label">{{ field.title }}</span>
                <strong v-if="field.valueType === 'select'" :data-discussion-field="field.id" data-discussion-text>
                  {{ field.options[String(item.values[field.id])]?.title ?? item.values[field.id] }}
                </strong>
                <strong v-else :data-discussion-field="field.id" data-discussion-text>{{ String(item.values[field.id]) }}</strong>
              </div>
            </template>
          </div>
        </aside>

        <div class="detail-primary" data-detail-primary role="region" aria-label="Item content">
          <div v-if="narrative" class="detail-section" :data-discussion-field="narrativeFieldId">
            <span class="detail-label">Description</span>
            <MarkdownContent class="detail-copy reading-prose" data-discussion-field="narrative" data-discussion-text :source="narrative" :editable-tasks="!readOnly" @task-toggle="emit('updateMarkdown', item, $event)" />
          </div>
          <slot name="documents" />
          <slot name="discussion" />

        <section class="detail-section detail-subsection">
          <div class="section-heading detail-section-head">
            <div>
              <span class="detail-label">Subitems</span>
              <h3>{{ subitems.length ? `${subitems.length} subitems` : "No subitems" }}</h3>
            </div>
            <button class="button button-small" type="button" :disabled="readOnly" @click="emit('addSubitem', item.id)">+ Add subitem</button>
          </div>

          <div v-if="subitems.length" class="subitem-list">
            <div
              v-for="sub in subitems"
              :key="sub.id"
              class="subitem-row"
            >
              <span>{{ sub.title }}</span>
              <button
                class="button button-small button-quiet"
                type="button"
                :aria-label="`Move ${sub.title}`"
                :disabled="readOnly" @click="emit('startMove', sub)"
              >
                Move
              </button>
            </div>
          </div>
        </section>

        <ItemHistoryPanel v-if="history !== undefined" :history="history" :verified-people="historyNames" :read-only="readOnly"
          :history-loading="historyLoading" :history-error="historyError" :history-notice="historyNotice" :history-has-more="historyHasMore"
          :restore-saving="restoreSaving" :restore-error="restoreError" :restore-notice="restoreNotice"
          @restore-version="emit('restoreVersion', $event)" @load-earlier-history="emit('loadEarlierHistory')" />
        </div>
      </div>

      <div class="dialog-actions dialog-actions-split">
        <button v-if="archived" class="button button-small" type="button" :disabled="readOnly" @click="emit('restoreItem', item.id)">Restore item</button>
        <button v-else class="button button-danger" type="button" :disabled="readOnly" @click="emit('archiveItem', item.id)">Archive item</button>
        <div class="dialog-action-group">
          <button class="button button-quiet" type="button" aria-label="Close detail" @click="emit('close')">Close detail</button>
        </div>
      </div>
      <p v-if="archiveError" class="form-error reading-explanation" role="alert">{{ archiveError }}</p>
    </section>
  </SpatialWindow>
</template>

<style src="../styles/design-system/reading-fonts.css"></style>
<style scoped>
.detail-subsection { padding-top: var(--space-4); }
.detail-section-head { margin-bottom: var(--space-3); }
.detail-section-head h3 { margin: 0; font-size: 1rem; }
.subitem-list { display: grid; gap: var(--space-2); }
.subitem-row { padding: var(--space-2) 0; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.detail-head { margin: 0; align-items: center; gap: var(--space-3); }
.detail-head h2 { font-size: var(--site-font-detail-heading-size, 1.5rem); margin: var(--space-1) 0 0; }
.detail-head-actions { flex-wrap: wrap; }
.detail-dialog { width: 100%; height: 100%; max-height: none; padding: var(--space-4); border: 0; box-shadow: none; }
.detail-scroll { flex: 1; }
.dialog-actions { padding-right: var(--space-6); flex-shrink: 0; }
@media (max-width: 600px) {
  .detail-head h2 { font-size: var(--site-font-detail-heading-mobile-size, 1.35rem); }
}
</style>
