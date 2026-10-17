<script setup lang="ts">
defineProps<{
  presence: string
  saveState: "idle" | "saving" | "saved" | "error"
  diagnostic?: string
}>()
</script>
<template>
  <section class="workspace-status" aria-label="Workspace status">
    <h4>Board status</h4>
    <p role="status">{{ saveState === 'error' ? 'Changes could not be saved on this device.' : saveState === 'saving' ? 'Saving changes on this device…' : 'Changes saved on this device.' }}</p>
    <p>{{ presence }}</p>
    <p v-if="diagnostic" class="sync-error" role="status">{{ diagnostic }} Changes saved on this device stay available. Open Sync to check the connection.</p>
  </section>
  <slot />
</template>
<style scoped>
.workspace-status { display: grid; gap: var(--space-2); }
h4, p { margin: 0; }
</style>
