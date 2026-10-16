<script setup lang="ts">
import { ref, watch } from "vue"
import type { ApplicationSourceData } from "../domain/applicationSourceData"
import type { WorkspaceDocumentV2 } from "../domain/entitySchemas"

const props = defineProps<{ leadId: string; leadUrl?: string; workspaceId: string; document?: WorkspaceDocumentV2 | null; documentVersion?: number }>()
const applicationSource = ref<ApplicationSourceData | null>(null)
let sourceReadGeneration = 0
watch(() => [props.leadId, props.workspaceId, props.documentVersion, props.document] as const,
  async ([leadId, workspaceId, version, doc]) => {
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
      if (generation === sourceReadGeneration && props.leadId === leadId && props.workspaceId === workspaceId &&
        props.documentVersion === version && props.document === doc) applicationSource.value = verified
    } catch {
      if (generation === sourceReadGeneration) applicationSource.value = null
    }
  }, { immediate: true })
</script>

<template>
  <section v-if="applicationSource || leadUrl" class="detail-section" role="region" aria-label="Original posting evidence">
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
</template>
