import { itemDiscussions } from "../chat/itemDiscussions"
import { itemReferenceChoices } from "../chat/referenceChoices"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import { conversationMessages, conversationRoot, MAX_REFERENCES, type Anchor, type MessageContext } from "../chat/context"
import { getChatScope } from "../chat/service"
import type { StoredChatMessage } from "../chat/store"
import { createSourceHighlighter, findSourceOwner } from "../chat/sourceSelection"
import { createMessageNavigation, type Discussion } from "./messageNavigation"
import { focusSpatialWindow } from "../ui/windowManager"
import { isItem, type Item } from "../domain/model"
import { isItemArchived } from "../domain/archive"
import { chatDraft } from "../ui/chatDrafts"
import { useDiscussionActions } from "./useDiscussionActions"


export function useObjectConversations(app: ReturnType<typeof useAppController>) {
  const scope = ref("")
  const discussions = ref<Discussion[]>([])
  const sourceState = ref("")
  const navigationState = ref("")
  const linkedMessageId = ref("")
  const highlighter = createSourceHighlighter(state => { sourceState.value = state })
  const { navigate, dismiss: dismissLink } = createMessageNavigation(app, discussions, navigationState, linkedMessageId)
  const workspaceId = computed(() => app.workspace.activeWorkspace.id)
  const currentDiscussions = computed(() => discussions.value.filter(view => view.workspaceId === workspaceId.value))
  const openChats = computed(() => chatDestinations(app.collaboration.device.chat.open.value,
    currentDiscussions.value, app.collaboration.device.chat.messages.value))
  const actions = useDiscussionActions(openChats, (source, destinationId) =>
    discuss(source.itemId, source.fieldId, source.selection, destinationId))
  const cardDiscussions = computed(() => itemDiscussions(app.collaboration.device.chat.messages.value,
    scope.value, app.workspace.activeBoard.value?.id ?? ""))
  const fieldTitles = computed(() => Object.fromEntries<string>([
    ["title", "Title"], ["narrative", "Description"], ["overview", "Overview"],
    ...app.workspace.boardFields.value.map(field => [field.id, field.title] as const),
  ]))
  const referenceChoices = createReferenceChoices(app, scope)

  async function discuss(itemId: string, fieldId?: string, selected?: Anchor["selection"], destinationId?: string) {
    const requestedWorkspace = workspaceId.value
    sourceState.value = "Opening discussion…"
    try {
      const nextScope = await getChatScope(requestedWorkspace)
      if (requestedWorkspace !== workspaceId.value) return
      scope.value = nextScope
      const item = app.workspace.getActiveDoc()?.entities[itemId]
      if (!item || !isItem(item)) { sourceState.value = "Source unavailable"; return }
      const anchor: Anchor = { workspaceScope: scope.value, boardId: app.workspace.activeBoard.value?.id ?? "", itemId, ...(fieldId ? { fieldId } : {}), ...(selected ? { selection: selected } : {}) }
      if (destinationId) {
        attachDraftReference(requestedWorkspace, destinationId, anchor, openChats.value, app.collaboration.device.chat.sending.value)
        actions.clear(); sourceState.value = ""
        await nextTick()
        focusSpatialWindow(requestedWorkspace, destinationId)
        document.getElementById(`message-${destinationId}`)?.focus({ preventScroll: true })
        return
      }
      const id = `discussion:${itemId}`
      const existing = discussions.value.find(view => view.workspaceId === workspaceId.value && view.id === id)
      if (existing) { existing.context = { references: [anchor], mentions: [] }; existing.anchor = { ...anchor, fieldId: undefined, selection: undefined }; focusSpatialWindow(workspaceId.value, id) }
      else discussions.value.push({ workspaceId: workspaceId.value, id, title: `Discussion · ${item.title}`, anchor: { workspaceScope: anchor.workspaceScope, boardId: anchor.boardId, itemId }, context: { references: [anchor], mentions: [] } })
      actions.clear()
      sourceState.value = ""
      await nextTick()
      focusSpatialWindow(requestedWorkspace, id)
      await app.collaboration.device.chat.refresh()
    } catch (error) {
      if (requestedWorkspace === workspaceId.value) sourceState.value = `Could not open discussion · ${error instanceof Error ? error.message : String(error)}`
    }
  }
  async function openThread(messageId: string, replying = false) {
    const all = app.collaboration.device.chat.messages.value as StoredChatMessage[]
    const target = all.find(message => message.id === messageId && !message.id.startsWith("pending:"))
    if (!target) { sourceState.value = "Message unavailable"; return }
    const root = conversationRoot(target, all)
    if (root.state === "invalid") { sourceState.value = "Invalid reply conversation"; return }
    const id = `conversation:${root.rootId}`
    const replyTo = replying || !all.some(message => message.id === root.rootId) ? target.id : root.rootId
    const cached = chatDraft(workspaceId.value, id)
    const context: MessageContext = !replying && cached.context.replyTo && cached.context.conversationRootId === root.rootId
      ? JSON.parse(JSON.stringify(cached.context)) as MessageContext
      : { references: target.context?.references ?? [], mentions: [], replyTo, conversationRootId: root.rootId }
    cached.context = JSON.parse(JSON.stringify(context)) as MessageContext
    const existing = discussions.value.find(view => view.workspaceId === workspaceId.value && view.id === id)
    if (existing) { existing.targetId = target.id; existing.context = context }
    else discussions.value.push({ workspaceId: workspaceId.value, id, title: "Discussion · replies", rootId: root.rootId, targetId: target.id, context })
    await nextTick()
    focusSpatialWindow(workspaceId.value, id)
  }
  const messages = (view: Discussion) => conversationMessages(app.collaboration.device.chat.messages.value as StoredChatMessage[], { anchor: view.anchor, rootId: view.rootId }) as typeof app.collaboration.device.chat.messages.value
  function close(view: Discussion) { dismissLink(view.id); discussions.value = discussions.value.filter(candidate => candidate !== view) }
  function openCard(item: Item, event: MouseEvent) {
    if ((event.target as Element).closest("a, input, button")) return
    app.actions.openBoardItem(item)
  }

  async function openReference(anchor: Anchor) {
    highlighter.clear()
    sourceState.value = ""
    if (!app.collaboration.permissions.confirmedRole.value || app.collaboration.device.sync.isWorkspaceAccessRevoked(workspaceId.value)) { sourceState.value = "Workspace access unavailable"; return }
    if (anchor.workspaceScope !== scope.value) { sourceState.value = "Workspace unavailable"; return }
    const item = app.workspace.getActiveDoc()?.entities[anchor.itemId]
    if (anchor.boardId !== app.workspace.activeBoard.value?.id || !item || !isItem(item) || isItemArchived(item)) { sourceState.value = "Source unavailable"; return }
    app.actions.openBoardItem(item)
    await nextTick()
    const owner = findSourceOwner(anchor.itemId)
    const sourceWindow = owner?.closest<HTMLElement>("[data-window-id]")
    if (sourceWindow) focusSpatialWindow(workspaceId.value, sourceWindow.dataset.windowId!)
    if (anchor.fieldId && owner) highlighter.highlight(owner, anchor)
  }

  watch(() => [workspaceId.value, app.workspace.ready.value], async () => {
    highlighter.clear(); actions.clear(); sourceState.value = ""; linkedMessageId.value = ""; scope.value = ""
    if (!app.workspace.ready.value) return
    const id = workspaceId.value
    try { const next = await getChatScope(id); if (id === workspaceId.value) scope.value = next } catch { /* workspace not available yet */ }
  }, { immediate: true })
  registerConversationNavigation(() => { void navigate() }, () => highlighter.clear())
  return { scope, currentDiscussions, openChats, cardDiscussions, fieldTitles, referenceChoices, ...actions, sourceState, navigationState, linkedMessageId, discuss, messages, close, openReference, openThread, openCard, navigate, dismissLink,
    openCardDiscussion: (itemId: string) => {
      const messageId = cardDiscussions.value.get(itemId)?.messageId
      return messageId ? openThread(messageId) : discuss(itemId)
    } }
}

function createReferenceChoices(app: ReturnType<typeof useAppController>, scope: Ref<string>) {
  return computed(() => itemReferenceChoices(
    Object.values(app.workspace.getActiveDoc()?.entities ?? {}).filter((entity): entity is Item => isItem(entity) && !isItemArchived(entity)),
    app.workspace.boardFields.value, scope.value, app.workspace.activeBoard.value?.id ?? "",
    app.workspace.activeBoard.value?.cardPresentation?.narrativeFieldId,
  ))
}

function registerConversationNavigation(navigate: () => void, clear: () => void) {
  onMounted(() => { window.addEventListener("hashchange", navigate); navigate() })
  onBeforeUnmount(() => { clear(); window.removeEventListener("hashchange", navigate) })
}

function attachDraftReference(workspaceId: string, destinationId: string, anchor: Anchor, openChats: { id: string }[], sending: boolean) {
  if (sending) throw new Error("Wait for the message to finish saving, then choose a chat.")
  if (!openChats.some(chat => chat.id === destinationId)) throw new Error("This chat was closed. Choose another chat.")
  const cached = chatDraft(workspaceId, destinationId)
  if (cached.context.references.some(reference => JSON.stringify(reference) === JSON.stringify(anchor))) return
  if (cached.context.references.length >= MAX_REFERENCES) throw new Error("Remove a reference before adding another")
  cached.context.references.push(anchor)
}


function chatDestinations(workspaceOpen: boolean, discussions: Discussion[], messages: readonly { id: string; body: string }[]) {
  const choices = [
    ...(workspaceOpen ? [{ id: "chat", title: "Workspace chat" }] : []),
    ...discussions.map(view => ({ id: view.id, title: view.rootId
      ? `Replies · ${(messages.find(message => message.id === view.rootId)?.body ?? "Message unavailable").replace(/\s+/gu, " ").trim().slice(0, 72)}`
      : view.title })),
  ]
  const counts = new Map<string, number>()
  for (const choice of choices) counts.set(choice.title, (counts.get(choice.title) ?? 0) + 1)
  return choices.map((choice, index) => ({ ...choice, title: (counts.get(choice.title) ?? 0) > 1 ? `${choice.title} · ${index + 1}` : choice.title }))
}
