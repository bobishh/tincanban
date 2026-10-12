<script setup lang="ts">
const emit = defineEmits<{
  (event: "export"): void
}>()
</script>

<template>
  <section class="sync-section">
    <p class="sync-section-copy">Back up this workspace:</p>
    <div class="dialog-actions sync-data-actions">
      <button class="button button-quiet" type="button" @click="emit('export')">Export .tincanban</button>
    </div>
  </section>
</template>

<style scoped>
.sync-section { display: grid; gap: 10px; margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--line); }
.sync-section-copy { margin: 0; color: var(--muted); font: 700 .8rem/1.45 var(--site-font-sans); letter-spacing: .06em; text-transform: uppercase; }
.sync-data-actions { justify-content: flex-start; margin: 0; }
</style>
