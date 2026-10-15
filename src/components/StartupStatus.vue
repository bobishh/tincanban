<script setup lang="ts">
defineProps<{
  message: string
  expanded?: boolean
  viewOnly: boolean
  error: { message: string; detail: string; stage: string } | null
}>()
</script>

<template>
  <aside class="startup-status" :class="{ 'startup-screen': expanded, 'startup-notification': !expanded && viewOnly, 'startup-status-error': error }" :role="error ? 'alert' : 'status'" aria-label="Board status" aria-live="polite">
    <span class="startup-status-mark" aria-hidden="true">
      <template v-if="error">!</template>
      <template v-else><span v-for="dot in 3" :key="dot" class="startup-status-dot"></span></template>
    </span>
    <div class="startup-status-copy">
      <span>{{ error ? (viewOnly ? 'Checks could not finish. Saved board is view only.' : error.message) : message }}</span>
      <details v-if="error"><summary>Details</summary><p>{{ error.detail }}</p><p v-if="error.stage === 'storage'">Keep your website data. Reload to retry.</p></details>
    </div>
    <span v-if="viewOnly && !error" class="startup-status-mode">View only</span>
  </aside>
</template>

<style scoped>
.startup-status { width: min(var(--site-content-max), 100%); margin: var(--space-2) auto 0; padding: var(--space-2) var(--site-gutter); display: flex; align-items: center; gap: var(--space-2); color: var(--muted); font: 700 .85rem/1.35 var(--site-font-sans); }
.startup-notification { position: fixed; z-index: 25; right: max(16px, var(--safe-right)); bottom: max(16px, var(--safe-bottom)); width: min(440px, calc(100% - max(16px, var(--safe-left)) - max(16px, var(--safe-right)))); max-height: 40dvh; overflow: auto; margin: 0; padding: var(--space-3) var(--space-4); border: 2px solid var(--line); background: var(--paper); box-shadow: 0 4px 16px #17171718; }
.startup-status-copy { min-width: 0; }
.startup-status-mode { margin-left: auto; flex-shrink: 0; padding: var(--space-1) var(--space-2); border: 1px solid var(--line); border-radius: 3px 5px 4px 2px; background: var(--soft); font-size: .7rem; white-space: nowrap; }
.startup-status-error { color: var(--red); align-items: start; }
.startup-status-error .startup-status-mark { color: var(--red); }
.startup-status-copy details { margin-top: var(--space-1); color: var(--muted); }
.startup-status-copy summary { cursor: pointer; }
.startup-status-copy p { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }
.startup-screen { width: auto; margin: 0; padding: var(--space-5); gap: var(--space-5); font: 600 18px/1.4 system-ui, sans-serif; }
</style>
