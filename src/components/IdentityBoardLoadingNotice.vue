<script setup lang="ts">
withDefaults(defineProps<{ error: string; expanded?: boolean }>(), { expanded: true })
defineEmits<{ retry: [] }>()
</script>

<template>
  <section v-if="expanded" class="startup-screen identity-board-loading" role="region" aria-label="Loading your boards" :aria-busy="!error">
    <div class="identity-board-loading-content">
      <span class="startup-status-mark" aria-hidden="true">
        <span v-if="error">!</span>
        <template v-else><span v-for="dot in 3" :key="dot" class="startup-status-dot"></span></template>
      </span>
      <h1>Your boards</h1>
      <div class="identity-board-loading-copy" :role="error ? 'alert' : 'status'" aria-live="polite">
        <p>{{ error ? 'Signed in. Your boards are not ready yet.' : 'Signed in. Loading your boards…' }}</p>
        <p>{{ error ? 'Check your connection or open Tincanban on another device with your boards, then retry.' : 'Finding your saved boards and loading their contents. This may take a while. Keep this page open.' }}</p>
        <details v-if="error"><summary>Loading details</summary><p>{{ error }}</p></details>
      </div>
      <button class="button" type="button" :disabled="!error" @click="$emit('retry')">Retry loading boards</button>
    </div>
  </section>
  <aside v-else class="notice-overlay" aria-live="polite">
    <div class="notice" :role="error ? 'alert' : 'status'">
      <span>{{ error || 'Signed in. Loading the rest of your boards…' }}</span>
      <button class="button button-small identity-board-retry" type="button" :disabled="!error" @click="$emit('retry')">Retry loading boards</button>
    </div>
  </aside>
</template>

<style scoped>
.identity-board-loading { padding: max(var(--space-5), var(--safe-top)) max(var(--site-gutter), var(--safe-right)) max(var(--space-5), var(--safe-bottom)) max(var(--site-gutter), var(--safe-left)); overflow-y: auto; color: var(--ink); }
.identity-board-loading-content { width: min(560px, 100%); margin-block: auto; display: grid; gap: var(--space-5); text-align: center; }
.identity-board-loading .startup-status-mark { height: var(--space-6); }
.identity-board-loading h1 { margin: 0; font: 700 2rem/1.2 var(--site-font-sans); }
.identity-board-loading-copy { min-height: 12em; font: 400 1rem/1.5 var(--site-font-sans); overflow-wrap: anywhere; }
.identity-board-loading-copy p { margin: 0 0 var(--space-4); }
.identity-board-loading-copy summary { cursor: pointer; }
.identity-board-loading .button { justify-self: center; color: var(--ink); }
.identity-board-retry { flex-shrink: 0; color: var(--ink); }
</style>
