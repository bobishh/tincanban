<script setup lang="ts">
import type { HistoryEntry } from "../domain/historyTypes"
import { historyActionLabel, historyAuthorLabel } from "./historyPresentation"
import { ref } from "vue"
const props = withDefaults(defineProps<{
  history: HistoryEntry[]; readOnly?: boolean; historyLoading?: boolean; historyError?: string
  historyNotice?: string; historyHasMore?: boolean; restoreSaving?: boolean; restoreError?: string; restoreNotice?: string
  verifiedPeople?: Record<string, string>
}>(), { verifiedPeople: () => ({}) })
const emit = defineEmits<{ restoreVersion: [hash: string]; loadEarlierHistory: [] }>()
const copyStatus = ref("")
const technicalDetails = (entry: HistoryEntry) => [
  `Change hash: ${entry.hash}`, `Operation: ${entry.action}`, `Actor: ${entry.actor}`,
  ...(entry.personId ? [`Person ID: ${entry.personId}`] : []),
  ...(entry.deviceId ? [`Device ID: ${entry.deviceId}`] : []),
  ...(entry.entityIds.length ? [`Entity IDs: ${entry.entityIds.join(", ")}`] : []),
  ...(entry.message ? [`Original change metadata: ${entry.message}`] : []),
  ...(entry.archive ? [`Archive source ID: ${entry.archive.sourceId}`, `Archive baseline ID: ${entry.archive.baselineId}`,
    `Archive epoch: ${entry.archive.historyEpoch}`, `Archive observation: ${entry.archive.observation}`] : []),
].join("\n")
async function copyDetails(entry: HistoryEntry) {
  try {
    await navigator.clipboard.writeText(technicalDetails(entry))
    copyStatus.value = "Details copied"
  } catch { copyStatus.value = "Could not copy. Select the details and copy them manually." }
}
</script>
<template>
        <section class="detail-section detail-subsection">
          <div class="section-heading detail-section-head">
            <span class="detail-label">History</span>
            <h3>{{ history.length ? `${history.length} changes` : "No recorded history" }}</h3>
          </div>
          <div v-if="history.length" class="item-history-list">
            <div
              v-for="(entry, index) in history"
              :key="entry.hash"
              class="item-history-entry"
            >
              <div class="item-history-head">
                <strong>{{ historyActionLabel(entry.action) }}</strong>
                <span class="item-history-time">{{ new Date(entry.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
              </div>
              <div class="item-history-author">
                Author: <span>{{ historyAuthorLabel(entry, entry.personId ? props.verifiedPeople[entry.personId] : undefined) }}</span>
                <span v-if="entry.archive && entry.archive.observation !== 'admitted'"> · {{ entry.archive.observation }} archive</span>
              </div>
              <button v-if="entry.archive || index < history.length - 1" class="button button-small button-quiet" type="button"
                :disabled="readOnly || restoreSaving || historyLoading" @click="emit('restoreVersion', entry.hash)">Restore this version</button>
              <details class="history-technical">
                <summary>Technical details</summary>
                <pre class="technical-value">{{ technicalDetails(entry) }}</pre>
                <button class="button button-small button-quiet" type="button" @click="copyDetails(entry)">Copy details</button>
              </details>
            </div>
          </div>
          <p v-if="copyStatus" class="reading-explanation" role="status">{{ copyStatus }}</p>
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
.detail-subsection { padding-top: var(--space-4); border-top: 1px solid var(--line); }
.detail-section-head { margin-bottom: var(--space-3); }
.detail-section-head h3 { margin: 0; font-size: 1rem; }
.item-history-list { display: grid; gap: var(--space-2); max-height: 240px; overflow-y: auto; }
.item-history-entry { display: grid; justify-items: start; gap: var(--space-1); padding: var(--space-2) 0; border-bottom: 1px solid var(--soft); font-size: .875rem; }
.item-history-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-1); }
.item-history-time, .item-history-author { color: var(--muted); }
.item-history-author, .history-technical { font-family: var(--site-font-reading); font-size: var(--site-font-body-size, 16px); line-height: 1.5; }
.history-technical summary { cursor: pointer; }
.history-technical pre { max-width: 100%; white-space: pre-wrap; }
.history-technical :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
</style>
