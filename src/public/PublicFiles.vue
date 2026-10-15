<script setup lang="ts">
import type { PublicBoardProjection } from "./publicSchema"
defineProps<{ files: PublicBoardProjection["files"]; fileUrl: (hash: string) => string }>()
function sizeLabel(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB` }
</script>
<template>
  <section v-if="files.length" class="public-files" aria-label="Published files">
    <h3>Files</h3>
    <ul><li v-for="file in files" :key="file.id"><a :href="fileUrl(file.sha256)" :download="file.fileName">{{ file.title || file.fileName }}</a>
      <span class="public-file-meta">{{ file.fileName }} · {{ sizeLabel(file.byteLength) }}</span></li></ul>
  </section>
</template>
