<script setup lang="ts">
import { defineAsyncComponent, ref, shallowRef, watch, type Component } from "vue"
import type { useWorkspaceChat } from "../chat/useWorkspaceChat"
import type { useObjectConversations } from "../app/useObjectConversations"

const props = defineProps<{
  workspaceId: string; workspaceTitle: string; readOnly: boolean; canView: boolean; connected: boolean
  memberAvatars?: Record<string, string>
  chat: ReturnType<typeof useWorkspaceChat>; conversations: ReturnType<typeof useObjectConversations>
}>()
const emit = defineEmits<{ workspaces: []; chatClose: []; sourceDismiss: [] }>()
const DiscussionChat = defineAsyncComponent<Component>(() => import("./WorkspaceChat.vue"))
const primaryChatComponent = shallowRef<Component | null>(null)
const primaryChatState = ref<"closed" | "loading" | "error" | "ready">("closed")
let chatLoadGeneration = 0

async function loadPrimaryChat() {
  const generation = ++chatLoadGeneration
  primaryChatState.value = "loading"
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (!props.chat.open.value || generation !== chatLoadGeneration) return
  try {
    const module = await import("./WorkspaceChat.vue") as { default: Component }
    if (props.chat.open.value && generation === chatLoadGeneration) {
      primaryChatComponent.value = module.default
      primaryChatState.value = "ready"
    }
  } catch {
    if (props.chat.open.value && generation === chatLoadGeneration) primaryChatState.value = "error"
  }
}

function reloadApp() { window.location.reload() }
function closeChat() { props.conversations.dismissLink("chat"); emit("chatClose") }

watch(() => props.chat.open.value, open => {
  if (open && primaryChatComponent.value) primaryChatState.value = "ready"
  else if (open) void loadPrimaryChat()
  else if (!open) { chatLoadGeneration++; primaryChatState.value = "closed" }
}, { immediate: true })
</script>

<template>
    <div v-if="chat.open.value && primaryChatState === 'loading'" class="chat-open-pending" role="status" aria-live="polite">
      <span>Opening chat…</span><button class="button button-small" type="button" @click="closeChat">Close</button>
    </div>
    <div v-else-if="chat.open.value && primaryChatState === 'error'" class="chat-open-pending" role="alert">
      <span>Chat could not load.</span><button class="button button-small" type="button" @click="reloadApp">Reload tincanban</button>
      <button class="button button-small" type="button" @click="closeChat">Close</button>
    </div>
    <component :is="primaryChatComponent" v-if="chat.open.value && primaryChatComponent && primaryChatState === 'ready'" :key="workspaceId" :workspace-title="workspaceTitle"
      :read-only="readOnly" :workspace-id="workspaceId" :workspace-scope="conversations.scope.value" :field-titles="conversations.fieldTitles.value"
      :members="chat.members.value" :member-avatars="memberAvatars" :reference-choices="conversations.referenceChoices.value" :send-message="chat.send" :target-id="conversations.linkedMessageId.value" :navigation-state="conversations.navigationState.value"
      :messages="canView ? chat.messages.value : []" :current-person-id="chat.personId.value" :sending="chat.sending.value"
      :error="chat.error.value" :loading="chat.loading.value" :connected="connected"
      :typing-people="chat.typingPeople.value"
      @close="closeChat" @send="chat.send" @typing="chat.setTyping" @reference="conversations.openReference" @read="chat.markVisible" @thread="conversations.openThread" />
    <DiscussionChat v-for="view in conversations.currentDiscussions.value" :key="`${view.workspaceId}:${view.id}`" :workspace-id="view.workspaceId" :window-id="view.id" :title="view.title"
      :workspace-title="workspaceTitle" :workspace-scope="conversations.scope.value" :initial-context="view.context" :reference-choices="conversations.referenceChoices.value" :field-titles="conversations.fieldTitles.value" :members="chat.members.value" :member-avatars="memberAvatars"
      :messages="canView ? conversations.messages(view) : []" :all-messages="canView ? chat.messages.value : []" :current-person-id="chat.personId.value" :sending="chat.sending.value" :error="chat.error.value" :loading="chat.loading.value"
      :connected="connected" :typing-people="chat.typingPeople.value" :read-only="readOnly" :send-message="chat.send" :target-id="view.targetId"
      @close="conversations.close(view)" @reference="conversations.openReference" @read="chat.markVisible" @typing="chat.setTyping" @thread="conversations.openThread" />
    <button v-if="conversations.selection.value && !readOnly" class="button button-small selection-discuss" type="button" aria-label="Discuss selection"
      :style="{ left: `${conversations.selection.value.x}px`, top: `${conversations.selection.value.y}px` }" @pointerdown.prevent @click="conversations.selectedDiscuss">{{ conversations.openChats.value.length ? "Discuss in…" : "Discuss" }}</button>
    <div v-if="conversations.contextMenu.value && !readOnly" class="discussion-context-menu" role="menu" :aria-label="conversations.contextMenu.value.chooseChat ? 'Choose chat' : 'Discussion actions'"
      :style="{ left: `${conversations.contextMenu.value.x}px`, top: `${conversations.contextMenu.value.y}px` }" @pointerdown.prevent>
      <template v-if="conversations.contextMenu.value.chooseChat">
        <p class="discussion-picker-status" role="status">{{ chat.sending.value ? "Wait for the message to finish saving, then choose a chat." : "Choose where to add this reference." }}</p>
        <button v-for="chatWindow in conversations.openChats.value" :key="chatWindow.id" :disabled="chat.sending.value" class="button button-small" role="menuitem" type="button" @click="conversations.discussIn(chatWindow.id)">Discuss in #{{ chatWindow.title }}</button>
        <button class="button button-small" role="menuitem" type="button" @click="conversations.discussIn()">New discussion</button>
      </template>
      <button v-else class="button button-small" role="menuitem" type="button" @click="conversations.contextualDiscuss">Discuss</button>
    </div>
    <aside v-if="conversations.sourceState.value" class="source-feedback" role="status">{{ conversations.sourceState.value }}<button type="button" aria-label="Dismiss source feedback" @click="emit('sourceDismiss')">×</button></aside>
    <aside v-if="conversations.navigationState.value" class="source-feedback" role="status">{{ conversations.navigationState.value }}
      <button class="button button-small" type="button" @click="emit('workspaces')">Open workspaces</button>
      <button class="button button-small" type="button" @click="conversations.navigate">Retry message link</button>
    </aside>
</template>

<style scoped>
.selection-discuss { position: fixed; z-index: 28; touch-action: manipulation; }
.discussion-context-menu { position: fixed; z-index: 28; padding: var(--space-1); background: var(--panel); border: 2px solid var(--ink); box-shadow: 3px 3px 0 var(--ink); display: grid; gap: var(--space-1); max-width: min(22rem, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; }
.discussion-picker-status { min-height: 3em; margin: 0; font-size: var(--site-font-secondary-size, 14px); }
.discussion-context-menu button { width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.source-feedback { position: fixed; bottom: 12px; left: 12px; z-index: 29; max-width: calc(100vw - 24px); padding: var(--space-2) var(--space-3); background: var(--panel); border: 2px solid var(--ink); overflow-wrap: anywhere; }
.chat-open-pending { position: fixed; z-index: 10001; inset: 50% auto auto 50%; display: flex; align-items: center; gap: var(--space-3); max-width: calc(100vw - 24px); padding: var(--space-3); transform: translate(-50%, -50%); background: var(--panel); color: var(--ink); border: 2px solid var(--line); box-shadow: 6px 6px 0 var(--ink); }
</style>
