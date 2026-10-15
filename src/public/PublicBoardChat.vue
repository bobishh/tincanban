<script setup lang="ts">
import { computed, ref } from "vue"
import type { PublicBoardProjection } from "./publicSchema"

const props = defineProps<{ projection: PublicBoardProjection; targetId: string }>()
const emit = defineEmits<{ close: []; openCard: [id: string] }>()
const thread = ref<string | null>(null)
const boardId = computed(() => props.projection.board.id)
const messages = computed(() => props.projection.discussions.filter(message => thread.value
  ? message.threadId === thread.value
  : props.targetId === boardId.value || message.targets.some(target => (target.cardId ?? target.id) === props.targetId)))
const title = computed(() => props.targetId === boardId.value && !thread.value ? "Board discussion" : "Discussion")
function openThread(id: string) { thread.value = props.projection.discussions.find(message => message.id === id)?.threadId ?? null }
</script>
<template>
  <section class="public-discussion" role="dialog" aria-modal="true" aria-label="Published discussion">
    <header class="public-discussion-header"><div><span class="eyebrow">Read-only</span><h2>{{ title }}</h2></div>
      <button class="button button-small" type="button" :aria-label="thread ? 'Back to discussion' : 'Close discussion'" @click="thread ? thread = null : emit('close')">{{ thread ? 'Back' : 'Close' }}</button>
    </header>
    <p class="public-discussion-note">Published discussion. Replies are not available in this copy.</p>
    <ol class="public-discussion-messages">
      <li v-for="message in messages" :key="message.id" class="public-discussion-message">
        <header><strong>{{ message.author }}</strong><time :datetime="message.createdAt">{{ message.createdAt }}</time></header>
        <p>{{ message.body }}</p>
        <button v-if="!thread && message.replyTo === null" class="button button-small button-quiet" type="button" @click="openThread(message.id)">View thread</button>
        <button v-for="target in message.targets.filter(target => target.type === 'card')" :key="target.id" class="button button-small button-quiet" type="button" @click="emit('openCard', target.id)">Open card</button>
      </li>
      <li v-if="!messages.length" class="empty-column">No published messages</li>
    </ol>
  </section>
</template>
<style scoped>
.public-discussion { position: fixed; z-index: 30; inset: 5vh max(1rem, calc((100vw - 620px) / 2)); display: flex; flex-direction: column; max-height: 90vh; padding: var(--space-5); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: 0 24px 80px #0005; }
.public-discussion-header { display: flex; justify-content: space-between; align-items: start; gap: var(--space-4); }
.public-discussion-header h2 { margin: var(--space-1) 0; }
.public-discussion-note { color: var(--muted); }
.public-discussion-messages { overflow: auto; list-style: none; margin: 0; padding: 0; }
.public-discussion-message { padding: var(--space-3) 0; border-top: 1px solid var(--line); }
.public-discussion-message header { display: flex; justify-content: space-between; gap: var(--space-3); }
.public-discussion-message p { white-space: pre-wrap; }
@media (max-width: 700px) { .public-discussion { inset: 1rem; max-height: calc(100dvh - 2rem); } }
</style>
