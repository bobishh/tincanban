<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { Board, Column, Item } from "../domain/model"
import type { Lead } from "../types"
import { priorityLabels } from "../types"
import { cardStageButtons } from "../domain/cardStageButtons"
import { MarkdownContent } from "../ui/markdownContent"
import SpatialWindow from "./SpatialWindow.vue"
import CardStageStrip from "./CardStageStrip.vue"
import type { ApplicationSourceData } from "../domain/applicationSourceData"
import type { WorkspaceDocumentV2 } from "../domain/entitySchemas"
import type { HistoryEntry } from "../domain/history"
import ItemHistoryPanel from "./ItemHistoryPanel.vue"
const props = defineProps<{ lead: Lead; item?: Item | null; board?: Board | null; columns: Column[]; workspaceId: string; readOnly: boolean; narrative: string; applicationSourceDocument?: WorkspaceDocumentV2 | null; applicationSourceDocVersion?: number; move: (item: Item, columnId: string) => Promise<void>;
  history?: HistoryEntry[]; historyLoading?: boolean; historyError?: string; historyNotice?: string; historyHasMore?: boolean;
  restoreSaving?: boolean; restoreError?: string; restoreNotice?: string }>()
const applicationSource = ref<ApplicationSourceData | null>(null)
let sourceReadGeneration = 0
watch(() => [props.lead.id, props.workspaceId, props.applicationSourceDocVersion, props.applicationSourceDocument] as const,
  async ([leadId, workspaceId, docVersion, doc]) => {
    const generation = ++sourceReadGeneration
    applicationSource.value = null
    if (!doc || doc.id !== workspaceId) return
    try {
      const { assertApplicationSourceRecord } = await import("../domain/applicationSourceData")
      const { verifyApplicationSourceDigest } = await import("../domain/commandApplicationSource")
      const originals = Object.values(doc.entities).filter(entity => entity.kind === "application_source" &&
        entity.placement.parentId === leadId).map(entity => assertApplicationSourceRecord(entity, doc.entities, workspaceId))
        .filter(data => data.observation.phase === "original")
      if (originals.length !== 1) return
      const verified = await verifyApplicationSourceDigest(originals[0])
      if (generation === sourceReadGeneration && props.lead.id === leadId && props.workspaceId === workspaceId &&
        props.applicationSourceDocVersion === docVersion && props.applicationSourceDocument === doc) {
        applicationSource.value = verified
      }
    } catch {
      if (generation === sourceReadGeneration) applicationSource.value = null
    }
  }, { immediate: true })
const sourceUrl = computed(() => {
  try { const url = new URL(props.lead.url ?? ""); return ["https:", "http:"].includes(url.protocol) ? url.href : null }
  catch { return null }
})
const emit = defineEmits<{ close: []; edit: [item: Item]; updateMarkdown: [markdown: string]; content: [element: HTMLElement | null];
  restoreVersion: [hash: string]; loadEarlierHistory: [] }>()
</script>
<template>
  <SpatialWindow framed :window-id="`item:${lead.id}`" :workspace-id="workspaceId" :title="lead.company" aria-label="Lead details" close-label="Close detail" :initial-width="760" :initial-height="700" @close="emit('close')">
    <template #header><div class="detail-head" :data-discussion-item="lead.id">
      <div><h2 data-discussion-text :data-discussion-field="board?.preset?.bindings['field.company']">{{ lead.company }}</h2><p data-discussion-text :data-discussion-field="board?.preset?.bindings['field.role']">{{ lead.role }}</p></div>
      <div class="detail-head-actions"><button v-if="item" class="button button-small" type="button" :disabled="readOnly" @click="emit('edit', item)">Edit</button></div>
    </div></template>
    <template #toolbar>
      <CardStageStrip v-if="item" :item="item" :columns="columns" :buttons="cardStageButtons(board, columns)" :read-only="readOnly" :move="move" />
      <slot name="toolbar" />
    </template>
    <section :ref="element => emit('content', element as HTMLElement | null)" class="detail-layout" data-detail-layout tabindex="-1" :data-discussion-item="lead.id">
      <div class="detail-primary" data-detail-primary role="region" aria-label="Lead description and documents">
        <section v-if="item && narrative" class="detail-section"><span class="detail-label">Description</span><MarkdownContent class="detail-copy" data-discussion-text data-discussion-field="narrative" :source="narrative" :editable-tasks="!readOnly" @task-toggle="emit('updateMarkdown', $event)" /></section>
        <section v-if="lead.sourceText" class="detail-section"><span class="detail-label">Source snapshot</span><p class="source-snapshot" data-discussion-text :data-discussion-field="board?.preset?.bindings['field.sourceText']">{{ lead.sourceText }}</p></section>
        <section v-if="applicationSource || lead.url" class="detail-section" role="region" aria-label="Original posting evidence">
          <span class="detail-label">Original posting title</span>
          <template v-if="applicationSource?.observation.status === 'available'">
            <h3>{{ applicationSource.observation.title }}</h3>
            <p>{{ applicationSource.observation.company }}</p>
            <p class="detail-copy">{{ applicationSource.observation.text }}</p>
          </template>
          <p v-else-if="applicationSource" role="status">Original posting evidence unavailable{{ applicationSource.observation.reason ? `: ${applicationSource.observation.reason}` : "." }}</p>
          <p v-else role="status">Original posting evidence pending · no original title is available.</p>
          <a v-if="applicationSource?.observation.jobUrl" class="source-link" :href="applicationSource.observation.jobUrl" target="_blank" rel="noreferrer">Open original posting ↗</a>
        </section>
        <slot name="primary" />
        <ItemHistoryPanel v-if="item" :history="history ?? []" :read-only="readOnly"
          :history-loading="historyLoading" :history-error="historyError" :history-notice="historyNotice" :history-has-more="historyHasMore"
          :restore-saving="restoreSaving" :restore-error="restoreError" :restore-notice="restoreNotice"
          @restore-version="emit('restoreVersion', $event)" @load-earlier-history="emit('loadEarlierHistory')" />
      </div>
      <aside class="detail-inspector" data-detail-inspector aria-label="Lead properties and actions">
        <div class="detail-grid" data-discussion-text data-discussion-field="overview">
          <div><span class="detail-label">Priority</span><strong data-discussion-text :data-discussion-field="board?.preset?.bindings['field.priority']">{{ lead.priority ? priorityLabels[lead.priority] : '—' }}</strong></div>
          <div><span class="detail-label">Fit</span><strong data-discussion-text :data-discussion-field="board?.preset?.bindings['field.fitScore']">{{ lead.fitScore ?? '—' }}<small v-if="lead.fitScore !== undefined">/10</small></strong></div>
          <div><span class="detail-label">Location</span><strong data-discussion-text :data-discussion-field="board?.preset?.bindings['field.location']">{{ lead.location || '—' }}</strong></div>
          <div><span class="detail-label">Work mode</span><strong data-discussion-text :data-discussion-field="board?.preset?.bindings['field.workMode']">{{ lead.workMode || '—' }}</strong></div>
        </div>
        <a v-if="sourceUrl" class="source-link" :href="sourceUrl" target="_blank" rel="noreferrer">Open job source ↗</a>
        <slot name="inspector" />
      </aside>
    </section>
  </SpatialWindow>
</template>
