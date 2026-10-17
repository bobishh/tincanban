<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ origin: string; scopeId: string; workspaceId: string; owner: boolean;
  disabled?: boolean; recover: (origin: string, scopeId: string, workspaceId: string) => Promise<void> }>()
const pending = ref(false), failure = ref('')
async function recoverConnection() {
  if (pending.value || props.disabled || !props.owner) return
  pending.value = true; failure.value = ''
  try { await props.recover(props.origin, props.scopeId, props.workspaceId) }
  catch (cause) { failure.value = cause instanceof Error ? cause.message : 'Recovery paused. Your saved data and original upload remain available for retry.' }
  finally { pending.value = false }
}
</script>
<template>
  <div class="rusty-conflict-recovery">
    <p>Recover this connection with a fresh key. Every previous key and saved upload stays available.</p>
    <button v-if="owner" class="button" type="button" :disabled="pending || disabled" @click="recoverConnection">{{ pending ? 'Recovering connection…' : 'Recover connection' }}</button>
    <p v-else>Ask the board owner to recover this connection.</p>
    <p v-if="owner && disabled && !pending" role="status">Waiting for the current Rusty operation to finish…</p>
    <p v-if="failure" role="alert">{{ failure }}</p>
  </div>
</template>
<style scoped>
.rusty-conflict-recovery { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
.rusty-conflict-recovery > .button { justify-self: start; }
p { margin: 0; }
</style>
