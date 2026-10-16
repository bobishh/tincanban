<script setup lang="ts">
import { MarkdownContent } from "../ui/markdownContent"
import { ref, computed, watch, nextTick, onMounted } from "vue"
import SpatialWindow from "./SpatialWindow.vue"
import ReferencePicker from "./ReferencePicker.vue"
import type { ReferenceChoice } from "../chat/referenceChoices"
import ParticipantAvatar from "./ParticipantAvatar.vue"
import MessageLinkAction from "./MessageLinkAction.vue"
import { chatDraft } from "../ui/chatDrafts"
import { conversationRoots, MAX_REFERENCES, MAX_MENTIONS, type Anchor, type MessageContext } from "../chat/context"

interface ChatMessage {
  id: string
  personId: string
  name: string
  body: string
  createdAt: string
  context?: MessageContext
  status?: "saving"
}

const props = withDefaults(
  defineProps<{
  readOnly?: boolean
    workspaceId?: string
    workspaceScope?: string
    windowId?: string
    title?: string
    connectionLabel?: string
    initialContext?: MessageContext
    fieldTitles?: Record<string, string>
    referenceChoices?: readonly ReferenceChoice[]
  members?: readonly {personId: string; name: string}[]
  memberAvatars?: Record<string, string>
    allMessages?: readonly ChatMessage[]
    targetId?: string
    navigationState?: string
    sendMessage?: (body: string, context?: MessageContext) => Promise<boolean>
    workspaceTitle: string
    messages: readonly ChatMessage[]
    currentPersonId: string
    sending: boolean
    error: string
    loading: boolean
    connected: boolean
    typingPeople: readonly string[]
  }>(),
  {
    workspaceTitle: "",
    messages: () => [],
    currentPersonId: "",
    sending: false,
    error: "",
    loading: false,
    connected: false,
    typingPeople: () => [],
  }
)

const emit = defineEmits<{
  close: []
  send: [body: string]
  typing: [active: boolean]
  reference: [anchor: Anchor]
  read: [ids: string[]]
  thread: [messageId: string, replying?: boolean]
}>()

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
const cached = chatDraft(props.workspaceId ?? "", props.windowId ?? "chat", props.initialContext)
const draft = computed({ get: () => cached.body, set: value => { cached.body = value } })
const context = computed({ get: () => cached.context, set: value => { cached.context = value } })
function attachInitialContext(value?: MessageContext) {
  if (!value) return
  if (value.replyTo) context.value = clone(value)
  else if (!draft.value && !context.value.replyTo) context.value.references = clone(value.references)
  else for (const anchor of value.references) {
    if (context.value.references.length < MAX_REFERENCES && !context.value.references.some(existing => JSON.stringify(existing) === JSON.stringify(anchor))) context.value.references.push(clone(anchor))
  }
}
attachInitialContext(props.initialContext)
const mentionQuery = ref("")
const toolsOpen = ref(false)
const mentionChoices = computed(() => (props.members ?? []).filter(member => member.name.toLowerCase().includes(mentionQuery.value.toLowerCase())))
function mention(member: {personId: string; name: string}) {
  if (context.value.mentions.length >= MAX_MENTIONS && !context.value.mentions.includes(member.personId)) return
  if (!context.value.mentions.includes(member.personId)) context.value.mentions.push(member.personId)
  draft.value += `${draft.value && !draft.value.endsWith(" ") ? " " : ""}@${member.name} `
  mentionQuery.value = ""
}
function resetComposerContext() {
  const initial = props.initialContext
  context.value = { references: clone(initial?.references ?? []), mentions: [],
    ...(props.windowId?.startsWith("conversation:") && initial?.conversationRootId
      ? { replyTo: initial.conversationRootId, conversationRootId: initial.conversationRootId } : {}) }
}
const replyQuote = computed(() => props.messages.find(message => message.id === context.value.replyTo)?.body ?? "Message unavailable")
function quote(message: ChatMessage) { return (props.allMessages ?? props.messages).find(candidate => candidate.id === message.context?.replyTo)?.body ?? "Message unavailable" }
const threadRoots = computed(() => {
  const all = (props.allMessages ?? props.messages).map(message => ({ id: message.id, workspaceId: props.workspaceScope ?? "", context: message.context }))
  return new Map([...conversationRoots(all)].flatMap(([id, root]) => {
    return root.state === "invalid" ? [] : [[id, root.rootId] as const]
  }))
})
const inThread = computed(() => Boolean(props.windowId?.startsWith("conversation:")))
const threadRoot = computed(() => (props.allMessages ?? props.messages).find(message => message.id === props.initialContext?.conversationRootId))
function visibleReferences(message: ChatMessage) {
  const inherited = inThread.value && message.context?.replyTo ? threadRoot.value?.context?.references ?? [] : []
  return (message.context?.references ?? []).filter(anchor => !inherited.some(parent => JSON.stringify(parent) === JSON.stringify(anchor)))
}
const replyCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const message of props.allMessages ?? props.messages) {
    const root = message.context?.replyTo ? threadRoots.value.get(message.id) : undefined
    if (root && !message.status) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  return counts
})
function anchorLabel(anchor: Anchor) {
  const item = props.referenceChoices?.find(choice => choice.anchor.itemId === anchor.itemId)?.title ?? "Open item"
  return anchor.selection?.exact ?? (anchor.fieldId ? `${item} · ${props.fieldTitles?.[anchor.fieldId] ?? "Field"}` : item)
}
watch(() => props.initialContext, attachInitialContext)
const isSubmitting = ref(false)
const isComposing = ref(false)
const userJustSent = ref(false)
const submittedDraft = ref("")
const messageListRef = ref<HTMLElement | null>(null)
const isAtBottom = ref(true)
const visibleCount = ref(100)
const availableMessages = computed<readonly ChatMessage[]>(() => {
  if (!props.messages) return []
  if (props.messages.length > 2000) {
    return props.messages.slice(-2000)
  }
  return props.messages
})

const hasEarlier = computed(() => {
  return availableMessages.value.length > visibleCount.value
})

const displayedMessages = computed(() => {
  const all = availableMessages.value
  const visible = all.length <= visibleCount.value ? all : all.slice(-visibleCount.value)
  if (inThread.value) return visible
  const roots = new Set(visible.filter(message => !message.context?.replyTo).map(message => message.id))
  return visible.filter(message => !message.context?.replyTo || !roots.has(threadRoots.value.get(message.id) ?? ""))
})
const typingLabel = computed(() => props.typingPeople.length === 1
  ? `${props.typingPeople[0]} is typing…`
  : props.typingPeople.length > 1 ? `${props.typingPeople[0]} and ${props.typingPeople.length - 1} others are typing…` : "")

function isScrolledToBottom(el: HTMLElement, threshold = 40): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function handleScroll() {
  const el = messageListRef.value
  if (!el) return
  isAtBottom.value = isScrolledToBottom(el)
  reportVisible()
}

function reportVisible() {
  const log = messageListRef.value
  const window = log?.closest<HTMLElement>(".spatial-window")
  if (!log || !window?.contains(document.activeElement) || props.loading) return
  const bounds = log.getBoundingClientRect()
  const ids = [...log.querySelectorAll<HTMLElement>("[data-message-id]")].filter(element => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  }).map(element => element.dataset.messageId!)
  emit("read", ids)
}

async function scrollToBottom(smooth = false) {
  await nextTick()
  const el = messageListRef.value
  if (!el) return
  el.scrollTo({
    top: el.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  })
}

async function loadEarlier() {
  const el = messageListRef.value
  if (!el) return
  const prevHeight = el.scrollHeight
  const prevTop = el.scrollTop

  visibleCount.value = Math.min(
    visibleCount.value + 100,
    2000,
    availableMessages.value.length
  )

  await nextTick()
  const newHeight = el.scrollHeight
  el.scrollTop = prevTop + (newHeight - prevHeight)
}

async function handleSubmit() {
  const text = draft.value.trim()
  if (!text || props.sending || isSubmitting.value) {
    return
  }
  isSubmitting.value = true
  userJustSent.value = true
  submittedDraft.value = text
  draft.value = ""
  emit("typing", false)
  if (props.sendMessage) {
    const sentContext = clone(context.value)
    const success = await props.sendMessage(text, sentContext.references.length || sentContext.mentions.length || sentContext.replyTo ? sentContext : undefined)
    if (success) {
      resetComposerContext()
      cached.context = clone(context.value)
    } else if (!draft.value) { draft.value = text; context.value = sentContext }
    isSubmitting.value = false
  } else emit("send", text)
  void scrollToBottom(true)
  await nextTick()
  document.getElementById(`message-${props.windowId ?? 'chat'}`)?.focus({ preventScroll: true })
}

function closeChat() {
  emit("typing", false)
  emit("close")
}

watch(draft, value => emit("typing", Boolean(value.trim())))
let revealedTarget = ""
async function revealTarget() {
  if (!props.targetId) { revealedTarget = ""; return }
  if (revealedTarget === props.targetId) return
  visibleCount.value = 2000
  await nextTick()
  if (revealedTarget === props.targetId) return
  const element = messageListRef.value?.querySelector(`[data-message-id="${CSS.escape(props.targetId)}"]`) as HTMLElement | null
  if (element) revealedTarget = props.targetId
  element?.scrollIntoView({ block: "center" })
  element?.focus({ preventScroll: true })
  reportVisible()
}
watch(() => [props.targetId, props.messages.length, props.loading], () => { void revealTarget() }, { immediate: true })

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    if (e.shiftKey || e.isComposing || isComposing.value) {
      return
    }
    e.preventDefault()
    void handleSubmit()
  }
}

watch(
  [() => props.sending, () => props.error] as const,
  ([sending, error], [prevSending]) => {
    if (prevSending && !sending) {
      isSubmitting.value = false
      if (error && !draft.value) draft.value = submittedDraft.value
      submittedDraft.value = ""
    } else if (sending) {
      isSubmitting.value = true
    }
    if (error) {
      isSubmitting.value = false
    }
  }
)

watch(
  () => props.messages,
  async (newMsgs) => {
    const el = messageListRef.value
    if (!el) return

    const lastMsg = newMsgs && newMsgs.length > 0 ? newMsgs[newMsgs.length - 1] : null
    const isFromMe = Boolean(
      lastMsg &&
      props.currentPersonId &&
      lastMsg.personId === props.currentPersonId
    )

    const shouldScroll = !props.targetId && (userJustSent.value || isFromMe || isAtBottom.value)
    if (shouldScroll) {
      userJustSent.value = false
      await nextTick()
      await scrollToBottom(true)
    }
    if (!props.targetId) reportVisible()
  },
  { deep: true }
)

watch(
  () => props.loading,
  async (newLoading, oldLoading) => {
    if (oldLoading && !newLoading) {
      await nextTick()
      await scrollToBottom(false)
    }
  }
)

onMounted(async () => {
  await nextTick()
  if (props.targetId) await revealTarget()
  else await scrollToBottom(false)
  reportVisible()
  if (!props.readOnly) document.getElementById(`message-${props.windowId ?? 'chat'}`)?.focus({ preventScroll: true })
})

function formatDisplayTime(createdAt: string): string {
  if (!createdAt) return ""
  try {
    const d = new Date(createdAt)
    if (isNaN(d.getTime())) return createdAt
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    return `${date} · ${time}`
  } catch {
    return createdAt
  }
}
</script>

<template>
  <SpatialWindow :window-id="windowId ?? 'chat'" :workspace-id="workspaceId ?? ''" :title="title ?? (`Chat${workspaceTitle ? ` · ${workspaceTitle}` : ''}`)" resize-label="Resize chat" :aria-label="title ?? 'Workspace chat'" close-label="Close" :initial-width="680" :initial-height="720" @close="closeChat">
    <template #header><div class="chat-window-heading"><strong>{{ title ?? (`Chat${workspaceTitle ? ` · ${workspaceTitle}` : ''}`) }}</strong><span class="chat-connection" :class="{ 'is-connected': connected }">{{ connectionLabel ?? (connected ? 'Connected' : 'Offline · saved locally') }}</span></div></template>
    <div class="chat-dialog conversation-content">
      <p v-if="navigationState" role="status">{{ navigationState }}</p>
      <div ref="messageListRef" class="chat-messages-log" role="log" aria-label="Messages" @scroll="handleScroll">
        <button v-if="hasEarlier" class="button button-small" type="button" @click="loadEarlier">Load earlier messages</button>
        <p v-if="loading" role="status">Loading messages…</p>
        <p v-else-if="!displayedMessages.length">No messages yet. Send a message to start chatting.</p>
        <article v-for="msg in displayedMessages" :key="msg.id" v-memo="[msg.personId, msg.body, msg.name, msg.createdAt, msg.status, msg.context, memberAvatars?.[msg.personId], replyCounts.get(msg.id), targetId, readOnly, workspaceScope, referenceChoices, fieldTitles, inThread, threadRoot, currentPersonId]" class="chat-message-item" :data-message-id="msg.id" tabindex="-1" :class="{ 'is-own': msg.personId === currentPersonId, 'is-reply': Boolean(msg.context?.replyTo), 'is-linked-message': msg.id === targetId }">
          <div class="chat-message-meta">
            <ParticipantAvatar :person-id="msg.personId" :avatar-data="memberAvatars?.[msg.personId]" />
            <strong class="chat-message-author">{{ msg.name || 'Anonymous' }}</strong>
            <span v-if="msg.personId === currentPersonId" class="chat-author-tag">(You)</span>
            <time class="chat-message-time" :datetime="msg.createdAt">{{ formatDisplayTime(msg.createdAt) }}</time>
            <span v-if="msg.status === 'saving'" class="chat-message-pending">Saving locally…</span>
          </div>
          <blockquote v-if="!inThread && msg.context?.replyTo" class="reply-quote">{{ quote(msg) }}</blockquote>
          <div v-if="visibleReferences(msg).length" class="reference-chips">
            <button v-for="(anchor, index) in visibleReferences(msg)" :key="index" class="button button-small" type="button" @click="emit('reference', anchor)">{{ anchorLabel(anchor) }}</button>
          </div>
          <MarkdownContent class="chat-message-body reading-prose" :source="msg.body" />
          <div class="message-actions">
            <button v-if="!inThread && !readOnly && !msg.status && !msg.context?.replyTo && !replyCounts.get(msg.id)" class="message-action" type="button" aria-label="Reply to message" @click="emit('thread', msg.id, true)">Reply</button>
            <button v-if="!inThread && !msg.context?.replyTo && replyCounts.get(msg.id) && !msg.status" class="message-action" type="button" @click="emit('thread', msg.id)">{{ replyCounts.get(msg.id) }} {{ replyCounts.get(msg.id) === 1 ? 'reply' : 'replies' }}</button>
            <button v-if="!inThread && msg.context?.replyTo && !msg.status" class="message-action" type="button" @click="emit('thread', msg.id)">View conversation</button>
            <MessageLinkAction v-if="workspaceScope" :workspace-scope="workspaceScope" :message-id="msg.id" :disabled="Boolean(msg.status)" />
          </div>
        </article>
        <div v-if="typingLabel" class="chat-typing" role="status" aria-label="Typing presence">{{ typingLabel }}</div>
      </div>
      <p v-if="error" class="form-error chat-error-banner reading-explanation" role="alert">{{ error }}</p>
      <p v-if="readOnly" class="chat-status">Visitor · view only</p>
      <footer v-else class="chat-footer">
        <div class="reference-chips">
          <span v-for="(anchor, index) in context.references" :key="index" class="draft-reference"><button class="button button-small" type="button" @click="emit('reference', anchor)">{{ anchorLabel(anchor) }}</button><button class="button button-small" type="button" aria-label="Remove reference" @click="context.references.splice(index, 1)">×</button></span>
        </div>
        <div v-if="context.replyTo && !inThread" class="reply-quote">Replying to: {{ replyQuote }} <button type="button" aria-label="Cancel reply" @click="context.replyTo = undefined; context.conversationRootId = undefined">×</button></div>
        <div v-if="context.mentions.length" class="reference-chips"><span v-for="personId in context.mentions" :key="personId">@{{ members?.find(member => member.personId === personId)?.name ?? 'Participant' }} <button class="button button-small" type="button" aria-label="Remove mention" @click="context.mentions = context.mentions.filter(id => id !== personId)">×</button></span></div>
        <div class="chat-compose-tools" :class="{ 'is-open': toolsOpen }">
        <ReferencePicker v-if="referenceChoices?.length" :choices="referenceChoices" :selected="context.references" @select="anchor => context.references.push(clone(anchor))" />
        <details v-if="members?.length" class="mention-picker">
          <summary>Invite @participant</summary>
          <input v-model="mentionQuery" aria-label="Find participant" />
          <button v-for="member in mentionChoices" :key="member.personId" class="button button-small" type="button" :disabled="context.mentions.length >= MAX_MENTIONS" @click="mention(member)"><ParticipantAvatar :person-id="member.personId" :avatar-data="memberAvatars?.[member.personId]" />{{ member.name }}</button>
        </details>
        </div>
        <form class="chat-composer-form" @submit.prevent="handleSubmit">
          <button v-if="referenceChoices?.length || members?.length" class="button button-quiet chat-tools-toggle" type="button" aria-label="Add reference or participant" :aria-expanded="toolsOpen" @click="toolsOpen = !toolsOpen">+</button>
          <label :for="`message-${windowId ?? 'chat'}`" class="chat-composer-label">Message</label>
          <textarea :id="`message-${windowId ?? 'chat'}`" v-model="draft" class="chat-textarea reading-input" aria-label="Message" placeholder="Message…" :disabled="isSubmitting" rows="3" @keydown="handleKeyDown" @compositionstart="isComposing = true" @compositionend="isComposing = false" />
          <button class="button button-primary chat-submit-btn" type="submit" aria-label="Send message" :disabled="!draft.trim() || sending || isSubmitting">{{ sending ? 'Saving…' : 'Send' }}</button>
        </form>
      </footer>
    </div>
  </SpatialWindow>
</template>

<style src="./WorkspaceChat.css" scoped></style>
<style src="../styles/design-system/reading-fonts.css"></style>
<style scoped>
.conversation-content { width: 100%; height: 100%; min-width: 0; min-height: 0; max-width: none; max-height: none; border: 0; box-shadow: none; padding: var(--space-3) var(--space-4); }
.chat-message-meta { align-items: center; }
.reference-chips, .message-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-block: var(--space-1); }
.draft-reference { display: inline-flex; align-items: center; }
.reference-chips button { white-space: normal; overflow-wrap: anywhere; text-align: left; }
.reply-quote { margin: var(--space-1) 0; padding: var(--space-1) var(--space-2); border-left: 2px solid var(--muted); color: var(--muted); overflow-wrap: anywhere; }
.mention-picker { margin-block: var(--space-1); }
.mention-picker button { display: inline-flex; align-items: center; gap: var(--space-1); }
.chat-composer-form { display: grid; gap: var(--space-1); }
.chat-tools-toggle { display: none; }
.chat-window-heading { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.chat-window-heading .chat-connection { margin: 0; font-size: .65rem; letter-spacing: 0; }
@media (max-width: 600px) {
  .conversation-content { padding: var(--space-1) var(--space-2); }
  .chat-footer { position: relative; margin-top: var(--space-1); padding-top: var(--space-1); }
  .chat-footer > .reference-chips:empty { display: none; }
  .chat-composer-form { grid-template-columns: auto minmax(0, 1fr) auto; align-items: end; }
  .chat-composer-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); }
  .chat-tools-toggle { display: block; width: 40px; height: 48px; padding: var(--space-1); }
  .chat-textarea { grid-column: 2; height: 48px; min-height: var(--control-size); max-height: 88px; resize: none; padding: var(--space-2); }
  .chat-submit-btn { grid-column: 3; width: auto; min-height: var(--control-size); padding: var(--space-1) var(--space-2); }
  .chat-compose-tools { display: none; position: absolute; z-index: 3; bottom: calc(100% + 6px); left: 0; width: 100%; max-height: 40dvh; overflow: auto; padding: var(--space-2); border: 2px solid var(--line); background: var(--panel); }
  .chat-compose-tools.is-open { display: block; animation: panel-appear var(--motion-panel) var(--motion-ease); }
  .chat-messages-log { gap: var(--space-2); padding: var(--space-2); }
  .chat-message-item { padding: var(--space-2) var(--space-2); gap: var(--space-1); }
  .chat-author-tag { display: none; }
  .chat-message-meta { gap: var(--space-1); }
  .chat-message-time { font-size: .65rem; }
}
</style>
