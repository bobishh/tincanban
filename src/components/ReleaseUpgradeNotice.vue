<script setup lang="ts">
import { releaseState } from "../release/runtimeRelease"
const reload = () => window.location.reload()
</script>

<template>
  <aside v-if="releaseState.status === 'upgrade-required' || releaseState.status === 'update-available'" class="release-upgrade" role="status" aria-live="polite">
    <span v-if="releaseState.status === 'upgrade-required'">Update required. This tab is read-only; your local data stays available.</span>
    <span v-else>An update is ready. This tab still uses the previous version.</span>
    <button type="button" @click="reload">Reload to update</button>
  </aside>
</template>

<style scoped>
.release-upgrade { position: fixed; z-index: 1000; inset: auto max(var(--space-3), env(safe-area-inset-right)) max(var(--space-3), env(safe-area-inset-bottom)) max(var(--space-3), env(safe-area-inset-left)); display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 2px solid var(--line); background: var(--paper, #fffdf5); box-shadow: 4px 4px 0 #0002; font: inherit; line-height: 1.4; }
.release-upgrade button { flex-shrink: 0; }
@media (max-width: 600px) { .release-upgrade { align-items: stretch; flex-direction: column; } }
</style>
