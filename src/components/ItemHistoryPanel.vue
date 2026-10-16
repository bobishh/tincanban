<script setup lang="ts">
import type { HistoryEntry } from "../domain/historyTypes"
import { historyActionLabel, historyAuthorLabel } from "./historyPresentation"
import CopyableCode from "./CopyableCode.vue"
import type { ItemHistoryProps } from "./itemHistoryProps"
const props = withDefaults(defineProps<ItemHistoryProps>(), { verifiedPeople: () => ({}) })
const emit = defineEmits<{ restoreVersion: [hash: string]; loadEarlierHistory: [] }>()
const technicalDetails = (entry: HistoryEntry) => [
  { label: "Change hash", value: entry.hash },
  { label: "Operation", value: entry.action },
  { label: "Actor", value: entry.actor },
  ...(entry.personId ? [{ label: "Person ID", value: entry.personId }] : []),
  ...(entry.deviceId ? [{ label: "Device ID", value: entry.deviceId }] : []),
  ...entry.entityIds.map((value, index) => ({ label: `Entity ID ${index + 1}`, value })),
  ...(entry.message ? [{ label: "Original change metadata", value: entry.message }] : []),
  ...(entry.archive ? [
    { label: "Archive source ID", value: entry.archive.sourceId },
    { label: "Archive baseline ID", value: entry.archive.baselineId },
    { label: "Archive epoch", value: String(entry.archive.historyEpoch) },
    { label: "Archive observation", value: entry.archive.observation },
  ] : []),
]
</script>
<template>
        <section class="item-history-panel">
          <div class="section-heading detail-section-head">
            <span class="detail-label">History</span>
            <h3>{{ history.length ? `${history.length} change${history.length === 1 ? '' : 's'}` : "No recorded history" }}</h3>
          </div>
          <div v-if="history.length" class="item-history-list">
            <div
              v-for="(entry, index) in history"
              :key="entry.hash"
              class="item-history-entry"
            >
              <div class="item-history-head">
                <strong>{{ historyActionLabel(entry.action) }}</strong>
                <span class="item-history-time">{{ new Date(entry.time * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }}</span>
              </div>
              <div class="item-history-author">
                Author: <span>{{ historyAuthorLabel(entry, entry.personId ? props.verifiedPeople[entry.personId] : undefined) }}</span>
                <span v-if="entry.archive && entry.archive.observation !== 'admitted'"> · {{ entry.archive.observation }} archive</span>
              </div>
              <button v-if="entry.archive || index < history.length - 1" class="button button-small button-quiet" type="button"
                :disabled="readOnly || restoreSaving || historyLoading" @click="emit('restoreVersion', entry.hash)">Restore this version</button>
              <details class="history-technical">
                <summary>Technical details</summary>
                <div v-for="detail in technicalDetails(entry)" :key="detail.label">
                  <span>{{ detail.label }}</span>
                  <CopyableCode :value="detail.value" :label="detail.label" />
                </div>
              </details>
            </div>
          </div>
          <button v-if="historyHasMore !== false" class="button button-small button-quiet" type="button"
            :disabled="historyLoading || restoreSaving" @click="emit('loadEarlierHistory')">
            {{ historyLoading ? 'Reading earlier history…' : historyError ? 'Retry earlier history' : 'Load earlier history' }}
          </button>
          <p v-if="historyLoading" role="status" class="dialog-copy reading-explanation">Reading archived versions…</p>
          <p v-else-if="historyNotice" role="status" class="dialog-copy reading-explanation">{{ historyNotice }}</p>
          <p v-if="historyError" role="alert" class="form-error reading-explanation">{{ historyError }}</p>
          <p v-if="restoreSaving" role="status" class="dialog-copy reading-explanation">Restoring version…</p>
          <p v-else-if="restoreNotice" role="status" class="dialog-copy reading-explanation">{{ restoreNotice }}</p>
          <p v-if="restoreError" role="alert" class="form-error reading-explanation">{{ restoreError }}</p>
        </section>
</template>

<style scoped>
.item-history-panel { display: grid; gap: var(--space-3); min-width: 0; }
.detail-section-head { margin-bottom: var(--space-3); }
.detail-section-head h3 { margin: 0; font-size: 1rem; }
.item-history-list { display: grid; gap: var(--space-3); min-width: 0; }
.item-history-entry { display: grid; justify-items: start; min-width: 0; gap: var(--space-1); padding: var(--space-2) 0; font-size: .875rem; }
.item-history-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-1); }
.item-history-time, .item-history-author { color: var(--muted); }
.item-history-author, .history-technical { font-family: var(--site-font-reading); font-size: var(--site-font-secondary-size, 14px); line-height: var(--site-font-reading-line, 1.65); }
.history-technical { min-width: 0; width: 100%; }
.history-technical summary { cursor: pointer; width: fit-content; margin-bottom: var(--space-2); }
</style>
