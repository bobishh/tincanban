<script setup lang="ts">
import { MarkdownContent } from "../ui/markdownContent"
import SpatialWindow from "./SpatialWindow.vue"
import QuickNoteForm from "./QuickNoteForm.vue"
import type { Item, FieldDefinition } from "../domain/model"
import type { HistoryEntry } from "../domain/history"
import type { Document, DocumentInput } from "../types"
import CardStageStrip from "./CardStageStrip.vue"
import type { Column } from "../domain/model"
import type { CardStageButton } from "../domain/cardStageButtons"
import { LazyItemDocuments as ItemDocuments } from "../app/lazyItemDocuments"
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
            <MarkdownContent class="detail-copy" data-discussion-field="narrative" data-discussion-text :source="narrative" :editable-tasks="!readOnly" @task-toggle="emit('updateMarkdown', item, $event)" />
          </div>
          <ItemDocuments
            :documents="documents"
            :workspace-id="props.workspaceId"
            :attachment-coverage="props.attachmentCoverage"
            :read-only="readOnly"
            :save="saveDocument"
            :update="updateDocument"
          />

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

        <section class="detail-section detail-subsection">
          <div class="section-heading detail-section-head">
            <span class="detail-label">History</span>
            <h3>{{ history?.length ? `${history.length} changes` : "No recorded history" }}</h3>
          </div>
          <div v-if="history?.length" class="item-history-list">
            <div
              v-for="(entry, index) in history"
              :key="entry.hash"
              class="item-history-entry"
            >
              <div class="item-history-head">
                <strong>{{ entry.action }}</strong>
                <span class="item-history-time">{{ new Date(entry.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
              </div>
              <div class="item-history-author">
                Author: <span>{{ entry.authorLabel }}</span>
              </div>
              <button v-if="index < history.length - 1" class="button button-small button-quiet" type="button"
                :disabled="readOnly || restoreSaving" @click="emit('restoreVersion', entry.hash)">Restore this version</button>
            </div>
          </div>
          <p v-if="restoreSaving" role="status" class="dialog-copy">Restoring version…</p>
          <p v-else-if="restoreNotice" role="status" class="dialog-copy">{{ restoreNotice }}</p>
          <p v-if="restoreError" role="alert" class="form-error">{{ restoreError }}</p>
        </section>
        </div>
      </div>

      <div class="dialog-actions dialog-actions-split">
        <button v-if="archived" class="button button-small" type="button" :disabled="readOnly" @click="emit('restoreItem', item.id)">Restore item</button>
        <button v-else class="button button-danger" type="button" :disabled="readOnly" @click="emit('archiveItem', item.id)">Archive item</button>
        <div class="dialog-action-group">
          <button class="button button-quiet" type="button" aria-label="Close detail" @click="emit('close')">Close detail</button>
        </div>
      </div>
      <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
    </section>
  </SpatialWindow>
</template>

<style src="../styles/design-system/reading-fonts.css"></style>
<style scoped>
.detail-head { margin: 0; align-items: center; gap: 12px; }
.detail-head h2 { font-size: 1.1rem; margin: 2px 0 0; }
.detail-head-actions { flex-wrap: wrap; }
.detail-dialog { width: 100%; height: 100%; max-height: none; padding: 18px; border: 0; box-shadow: none; }
.detail-scroll { flex: 1; }
.dialog-actions { padding-right: 30px; flex-shrink: 0; }
</style>
