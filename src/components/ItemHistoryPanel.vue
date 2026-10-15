<script setup lang="ts">
import type { HistoryEntry } from "../domain/history"
defineProps<{
  history: HistoryEntry[]; readOnly?: boolean; historyLoading?: boolean; historyError?: string
  historyNotice?: string; historyHasMore?: boolean; restoreSaving?: boolean; restoreError?: string; restoreNotice?: string
}>()
const emit = defineEmits<{ restoreVersion: [hash: string]; loadEarlierHistory: [] }>()
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
                <strong>{{ entry.action }}</strong>
                <span class="item-history-time">{{ new Date(entry.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
              </div>
              <div class="item-history-author">
                Author: <span>{{ entry.authorLabel }}</span>
                <span v-if="entry.archive"> · Archived<span v-if="entry.archive.observation !== 'admitted'"> · {{ entry.archive.observation }}</span></span>
              </div>
              <button v-if="entry.archive || index < history.length - 1" class="button button-small button-quiet" type="button"
                :disabled="readOnly || restoreSaving || historyLoading" @click="emit('restoreVersion', entry.hash)">Restore this version</button>
            </div>
          </div>
          <button v-if="historyHasMore !== false" class="button button-small button-quiet" type="button"
            :disabled="historyLoading || restoreSaving" @click="emit('loadEarlierHistory')">
            {{ historyLoading ? 'Reading earlier history…' : historyError ? 'Retry earlier history' : 'Load earlier history' }}
          </button>
          <p v-if="historyLoading" role="status" class="dialog-copy">Reading archived versions…</p>
          <p v-else-if="historyNotice" role="status" class="dialog-copy">{{ historyNotice }}</p>
          <p v-if="historyError" role="alert" class="form-error">{{ historyError }}</p>
          <p v-if="restoreSaving" role="status" class="dialog-copy">Restoring version…</p>
          <p v-else-if="restoreNotice" role="status" class="dialog-copy">{{ restoreNotice }}</p>
          <p v-if="restoreError" role="alert" class="form-error">{{ restoreError }}</p>
        </section>
</template>

<style scoped>
.detail-subsection { padding-top: var(--space-4); border-top: 2px solid var(--line); }
.detail-section-head { margin-bottom: var(--space-3); }
.detail-section-head h3 { margin: 0; font-size: 1rem; }
.item-history-list { display: grid; gap: var(--space-2); max-height: 170px; overflow-y: auto; }
.item-history-entry { padding: var(--space-2) var(--space-3); border: 2px solid var(--soft); font-size: .8rem; }
.item-history-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-1); }
.item-history-time, .item-history-author { color: var(--muted); }
</style>
