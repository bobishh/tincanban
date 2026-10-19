import { recordUsageAction } from "../usageActions"
import type { MessageContext } from "./context"
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { meshTrace } from "../sync/meshTrace"
import { bootstrapIdentity } from "../domain/identity"
import { messageOrderKey, type ChatSnapshot } from "./store"
import { resolveDisplayNamesWithIdentity } from "./names"
import { readLocal, writeLocal } from "../localDb"
import {
  ensureChatProfile,
  sendChatMessage,
  sendChatTyping,
  subscribeChat,
  loadChat,
  loadChatTyping,
  readChatCursor,
  markChatRead,
  type ChatTyping,
} from "./service"

type SubscriptionOptions = {
  workspaceId: Ref<string>
  open: Ref<boolean>
  personId: Ref<string>
  snapshot: Ref<ChatSnapshot>
  names: Ref<Record<string, string>>
  toast: Ref<{ workspaceId: string; text: string } | null>
  nameError: Ref<string>
  refresh: () => Promise<boolean | undefined>
  refreshTyping: () => void
}

type PendingChatMessage = {
  id: string
  workspaceId: string
  personId: string
  createdAt: string
  body: string
  status: "saving"
  context?: MessageContext
}

function createPendingMessage(workspaceId: string, personId: string, body: string, context?: MessageContext): PendingChatMessage {
  return { id: `pending:${crypto.randomUUID()}`, workspaceId, personId,
    createdAt: new Date().toISOString(), body: body.trim(), status: "saving", ...(context ? { context } : {}) }
}

function appendMessages(snapshot: Ref<ChatSnapshot>, added: ChatSnapshot["messages"]): void {
  if (!added.length) return
  const messages = new Map(snapshot.value.messages.map(message => [message.id, message]))
  for (const message of added) messages.set(message.id, message)
  snapshot.value = { ...snapshot.value, messages: [...messages.values()].sort((left, right) =>
    messageOrderKey(left).localeCompare(messageOrderKey(right))) }
}

async function traceRenderedMessages(workspaceId: string, messages: Array<{ id: string }>, isCurrent: () => boolean, seen: Set<string>) {
  await nextTick()
  if (!isCurrent()) return
  for (const message of messages.slice(-100)) {
    const key = `${workspaceId}:${message.id}`
    if (message.id.startsWith("pending:") || seen.has(key)) continue
    seen.add(key)
    if (seen.size > 1000) seen.delete(seen.values().next().value!)
    meshTrace("chat.dom.updated", { workspaceId, recordId: message.id })
  }
}

function watchRenderedMessages(workspaceId: Ref<string>, open: Ref<boolean>, messages: Readonly<Ref<Array<{ id: string }>>>) {
  const seen = new Set<string>()
  watch([open, messages], () => {
    if (!open.value) return
    const id = workspaceId.value
    void traceRenderedMessages(id, messages.value, () => id === workspaceId.value && open.value, seen)
  })
}

function createChatViews(
  snapshot: Ref<ChatSnapshot>,
  pending: Ref<PendingChatMessage[]>,
  identityName: Ref<string>,
  personId: Ref<string>,
  ownerId: Ref<string>,
  cursor: Ref<string | null>,
  typing: Ref<ChatTyping[]>
) {
  const names = computed(() => resolveDisplayNamesWithIdentity(
    snapshot.value.profiles.map(profile => ({ personId: profile.personId, name: profile.name })),
    { personId: personId.value, name: identityName.value },
  ))
  const displayName = computed(() => identityName.value)
  const members = computed(() => {
    const profiles = snapshot.value.profiles.map(profile => ({ personId: profile.personId, name: profile.name }))
    if (personId.value && !profiles.some(profile => profile.personId === personId.value)) {
      profiles.push({ personId: personId.value, name: identityName.value })
    }
    return profiles.map((profile) => ({
    personId: profile.personId,
    name: names.value[profile.personId] ?? profile.name,
    role: profile.personId === ownerId.value ? "Owner" : "Member",
    })).sort((left, right) => left.personId < right.personId ? -1 : left.personId > right.personId ? 1 : 0)
  })
  const messages = computed(() => [...snapshot.value.messages, ...pending.value].map((message) => ({
    ...message,
    name: names.value[message.personId] ?? (message.personId === personId.value
      ? identityName.value
      : `Participant · ${message.personId.slice(0, 6)}`),
  })))
  const unread = computed(() => snapshot.value.messages.filter((message) =>
    message.personId !== personId.value && (!cursor.value || messageOrderKey(message) > cursor.value)).length)
  const typingPeople = computed(() => [...new Set(typing.value.filter((item) => item.personId !== personId.value)
    .map((item) => item.personId))].map((id) => names.value[id] ?? `Participant · ${id.slice(0, 6)}`))
  return { names, displayName, members, messages, unread, typingPeople }
}

function subscribeWorkspaceChat(options: SubscriptionOptions): () => void {
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = subscribeChat((event) => {
    if (event.workspaceId !== options.workspaceId.value) return
    appendMessages(options.snapshot, event.added)
    if (event.history || event.profilesChanged) void options.refresh()
    if (event.typing?.length) options.refreshTyping()
    if (event.remote && !options.snapshot.value.profiles.some((profile) => profile.personId === options.personId.value)) {
      void ensureChatProfile(event.workspaceId)
        .then(() => {
          if (event.workspaceId === options.workspaceId.value) {
            options.nameError.value = ""
            void options.refresh()
          }
        })
        .catch(() => undefined)
    }
    if (!event.remote || event.history || options.open.value || document.visibilityState !== "visible" || !document.hasFocus()) return
    const last = event.added.filter((message) => message.personId !== options.personId.value).at(-1)
    if (!last) return
    void navigator.locks.request(`tincanban-chat-notification:${last.workspaceId}`, async () => {
      const key = `tincanban.chat.notified:${last.workspaceId}`
      const order = messageOrderKey(last)
      if ((await readLocal(key) ?? "") >= order) return
      await writeLocal(key, order)
      if (options.workspaceId.value !== event.workspaceId || options.open.value) return
      const sender = options.names.value[last.personId] ?? "New message"
      options.toast.value = { workspaceId: event.workspaceId, text: `${sender}: ${last.body.slice(0, 120)}` }
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        options.toast.value = null
      }, 6000)
    }).catch(() => undefined)
  })
  return () => {
    unsubscribe()
    clearTimeout(toastTimer)
  }
}

function createReadMarker(workspaceId: Ref<string>, snapshot: Ref<ChatSnapshot>, cursor: Ref<string | null>) {
  async function markVisible(ids: string[]) {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return
    const id = workspaceId.value
    const visible = snapshot.value.messages.filter(message => ids.includes(message.id))
    const last = visible.at(-1)
    if (!last) return
    const key = messageOrderKey(last)
    await markChatRead(id, key)
    if (id === workspaceId.value && (!cursor.value || key > cursor.value)) cursor.value = key
  }

  return markVisible
}

export function useWorkspaceChat(workspaceId: Ref<string>, ownerId: Ref<string>, identityName: Ref<string>) {
  const open = ref(false), loading = ref(false), sending = ref(false)
  const error = ref("")
  const nameError = ref("")
  const personId = ref("")
  const cursor = ref<string | null>(null)
  const snapshot = ref<ChatSnapshot>({ messages: [], profiles: [] })
  const pending = ref<PendingChatMessage[]>([])
  const toast = ref<{ workspaceId: string; text: string } | null>(null)
  const typing = ref<ChatTyping[]>([])
  let typingExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined
  let typingAnnounced = false
  let lastTypingPublished = 0
  let generation = 0
  let sendGeneration = 0
  const { names, displayName, members, messages, unread, typingPeople } = createChatViews(
    snapshot, pending, identityName, personId, ownerId, cursor, typing
  )

  function refreshTyping() {
    typing.value = loadChatTyping(workspaceId.value)
    clearTimeout(typingExpiryTimer)
    if (typing.value.length) typingExpiryTimer = setTimeout(refreshTyping, 6_100)
  }

  function publishTyping(active: boolean) {
    if (!workspaceId.value || !personId.value) return
    void sendChatTyping(workspaceId.value, active).catch(() => {})
  }

  function setTyping(active: boolean) {
    clearTimeout(typingIdleTimer)
    if (!active) {
      if (typingAnnounced) publishTyping(false)
      typingAnnounced = false
      return
    }
    const now = Date.now()
    if (!typingAnnounced || now - lastTypingPublished >= 2_500) {
      typingAnnounced = true
      lastTypingPublished = now
      publishTyping(true)
    }
    typingIdleTimer = setTimeout(() => setTyping(false), 1_500)
  }

  const markVisible = createReadMarker(workspaceId, snapshot, cursor)

  async function refresh() {
    const id = workspaceId.value
    if (!id) return
    const current = ++generation
    try {
      const [next, read] = await Promise.all([loadChat(id), readChatCursor(id)])
      if (current !== generation || id !== workspaceId.value) return
      snapshot.value = next
      cursor.value = read
      return true
    } catch (err) {
      if (id === workspaceId.value) error.value = err instanceof Error ? err.message : "Could not load chat"
      return false
    }
  }

  watch([workspaceId, ownerId], async () => {
    setTyping(false)
    generation++
    sendGeneration++
    sending.value = false
    snapshot.value = { messages: [], profiles: [] }
    pending.value = []
    error.value = ""
    nameError.value = ""
    toast.value = null
    typing.value = []
    if (!workspaceId.value || !ownerId.value) return
    const id = workspaceId.value
    loading.value = true
    try {
      personId.value = (await bootstrapIdentity()).identity.personId
      await refresh()
      await ensureChatProfile(id)
      await refresh()
    } catch (err) { if (id === workspaceId.value) nameError.value = err instanceof Error ? err.message : "Could not load profile" }
    finally { if (id === workspaceId.value) loading.value = false }
  }, { immediate: true })

  watch(open, () => {
    if (open.value) { toast.value = null; void refresh(); refreshTyping() }
    else setTyping(false)
  })
  watchRenderedMessages(workspaceId, open, messages)
  const visibility = () => { if (document.visibilityState === "visible") void refresh() }
  document.addEventListener("visibilitychange", visibility)
  const unsubscribe = subscribeWorkspaceChat({
    workspaceId, open, personId, snapshot, names, toast, nameError, refresh, refreshTyping,
  })
  onBeforeUnmount(() => {
    setTyping(false)
    unsubscribe()
    clearTimeout(typingExpiryTimer)
    clearTimeout(typingIdleTimer)
    document.removeEventListener("visibilitychange", visibility)
  })

  async function send(body: string, context?: MessageContext) {
    if (sending.value) return false
    setTyping(false)
    sending.value = true
    error.value = ""
    const id = workspaceId.value
    const operation = ++sendGeneration
    const pendingMessage = createPendingMessage(id, personId.value, body, context)
    pending.value = [...pending.value, pendingMessage]
    try { await sendChatMessage(id, body, context); recordUsageAction("chat_send"); return true }
    catch (err) { if (operation === sendGeneration && id === workspaceId.value) error.value = err instanceof Error ? err.message : "Could not save message. Try again."; return false }
    finally {
      pending.value = pending.value.filter(message => message.id !== pendingMessage.id)
      if (operation === sendGeneration) sending.value = false
    }
  }
  return { open, loading, sending, error, nameError, personId, displayName, members, messages, unread, toast,
    typingPeople, setTyping, send, refresh, markVisible }
}
