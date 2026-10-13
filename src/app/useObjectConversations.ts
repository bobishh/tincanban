import { itemDiscussions } from "../chat/itemDiscussions"
import { itemReferenceChoices } from "../chat/referenceChoices"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import { conversationMessages, conversationRoot, type Anchor, type MessageContext } from "../chat/context"
import { getChatScope } from "../chat/service"
import type { StoredChatMessage } from "../chat/store"
import { captureSelectedSource, createSourceHighlighter, findSourceOwner, type SelectedSource } from "../chat/sourceSelection"
import { createMessageNavigation, type Discussion } from "./messageNavigation"
import { focusSpatialWindow } from "../ui/windowManager"
import { isItem, type Item } from "../domain/model"
import { isItemArchived } from "../domain/archive"
import { chatDraft } from "../ui/chatDrafts"


export function useObjectConversations(app: ReturnType<typeof useAppController>) {
  const scope = ref("")
  const discussions = ref<Discussion[]>([])
  const selection = ref<SelectedSource | null>(null)
  const contextMenu = ref<{ itemId: string; fieldId?: string; selection?: Anchor["selection"]; x: number; y: number } | null>(null)
  const sourceState = ref("")
  const navigationState = ref("")
  const linkedMessageId = ref("")
  const highlighter = createSourceHighlighter(state => { sourceState.value = state })
  const { navigate, dismiss: dismissLink } = createMessageNavigation(app, discussions, navigationState, linkedMessageId)
  const workspaceId = computed(() => app.workspace.activeWorkspace.id)
  const currentDiscussions = computed(() => discussions.value.filter(view => view.workspaceId === workspaceId.value))
  const cardDiscussions = computed(() => itemDiscussions(app.collaboration.device.chat.messages.value,
    scope.value, app.workspace.activeBoard.value?.id ?? ""))
  const fieldTitles = computed(() => Object.fromEntries<string>([
    ["title", "Title"], ["narrative", "Description"], ["overview", "Overview"],
    ...app.workspace.boardFields.value.map(field => [field.id, field.title] as const),
  ]))
  const referenceChoices = createReferenceChoices(app, scope)

  async function discuss(itemId: string, fieldId?: string, selected?: Anchor["selection"]) {
    const requestedWorkspace = workspaceId.value
    sourceState.value = "Opening discussion…"
    try {
      const nextScope = await getChatScope(requestedWorkspace)
      if (requestedWorkspace !== workspaceId.value) return
      scope.value = nextScope
      const item = app.workspace.getActiveDoc()?.entities[itemId]
      if (!item || !isItem(item)) { sourceState.value = "Source unavailable"; return }
      const anchor: Anchor = { workspaceScope: scope.value, boardId: app.workspace.activeBoard.value?.id ?? "", itemId, ...(fieldId ? { fieldId } : {}), ...(selected ? { selection: selected } : {}) }
      const id = `discussion:${itemId}`
      const existing = discussions.value.find(view => view.workspaceId === workspaceId.value && view.id === id)
      if (existing) { existing.context = { references: [anchor], mentions: [] }; existing.anchor = { ...anchor, fieldId: undefined, selection: undefined }; focusSpatialWindow(workspaceId.value, id) }
      else discussions.value.push({ workspaceId: workspaceId.value, id, title: `Discussion · ${item.title}`, anchor: { workspaceScope: anchor.workspaceScope, boardId: anchor.boardId, itemId }, context: { references: [anchor], mentions: [] } })
      selection.value = null
      contextMenu.value = null
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
    const context: MessageContext = !replying && cached.body && cached.context.replyTo
      ? JSON.parse(JSON.stringify(cached.context)) as MessageContext
      : { references: target.context?.references ?? [], mentions: [], replyTo, conversationRootId: root.rootId }
    const existing = discussions.value.find(view => view.workspaceId === workspaceId.value && view.id === id)
    if (existing) { existing.targetId = target.id; existing.context = context }
    else discussions.value.push({ workspaceId: workspaceId.value, id, title: "Discussion · replies", rootId: root.rootId, targetId: target.id, context })
    await nextTick()
    focusSpatialWindow(workspaceId.value, id)
  }
  const messages = (view: Discussion) => conversationMessages(app.collaboration.device.chat.messages.value as StoredChatMessage[], { anchor: view.anchor, rootId: view.rootId }) as typeof app.collaboration.device.chat.messages.value
  function close(view: Discussion) { dismissLink(view.id); discussions.value = discussions.value.filter(candidate => candidate !== view) }
  function focusOrigin(itemId: string) {
    const owner = findSourceOwner(itemId)
    if (owner) owner.focus({ preventScroll: true })
    else document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"] .card-open-button`)?.focus({ preventScroll: true })
  }
  function selectedDiscuss() { const value = selection.value; if (value) { focusOrigin(value.itemId); void discuss(value.itemId, value.fieldId, value.selection) } }

  function captureSelection() { if (!contextMenu.value) selection.value = captureSelectedSource() }
  function contextual(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    const owner = target?.closest<HTMLElement>("[data-discussion-item]")
    if (!owner?.dataset.discussionItem || target?.closest("input, textarea, [contenteditable=true]")) return
    event.preventDefault()
    captureSelection()
    const selected = selection.value?.itemId === owner.dataset.discussionItem ? selection.value : null
    contextMenu.value = { itemId: owner.dataset.discussionItem,
      fieldId: selected?.fieldId ?? target?.closest<HTMLElement>("[data-discussion-field]")?.dataset.discussionField,
      ...(selected ? { selection: selected.selection } : {}),
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 64)) }
    selection.value = null
    void nextTick(() => document.querySelector<HTMLElement>(".discussion-context-menu button")?.focus({ preventScroll: true }))
  }
  function contextualDiscuss() { const value = contextMenu.value; if (value) { focusOrigin(value.itemId); void discuss(value.itemId, value.fieldId, value.selection) } }
  function dismissContext(event: Event) {
    if (!(event.target instanceof Element) || !event.target.closest(".discussion-context-menu")) contextMenu.value = null
  }
  function menuKey(event: KeyboardEvent) { if (event.key === "Escape" && contextMenu.value) { contextMenu.value = null; event.preventDefault() } }
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
    highlighter.clear(); selection.value = null; contextMenu.value = null; sourceState.value = ""; linkedMessageId.value = ""; scope.value = ""
    if (!app.workspace.ready.value) return
    const id = workspaceId.value
    try { const next = await getChatScope(id); if (id === workspaceId.value) scope.value = next } catch { /* workspace not available yet */ }
  }, { immediate: true })
  registerConversationListeners({ navigate: () => { void navigate() }, captureSelection, contextual, dismissContext, menuKey, clear: () => highlighter.clear() })
  return { scope, currentDiscussions, cardDiscussions, fieldTitles, referenceChoices, selection, contextMenu, sourceState, navigationState, linkedMessageId, discuss, selectedDiscuss, contextualDiscuss, messages, close, openReference, openThread, openCard, navigate, dismissLink,
    openCardDiscussion: (itemId: string) => {
      const messageId = cardDiscussions.value.get(itemId)?.messageId
      return messageId ? openThread(messageId) : discuss(itemId)
    } }
}

function createReferenceChoices(app: ReturnType<typeof useAppController>, scope: Ref<string>) {
  return computed(() => itemReferenceChoices(
    Object.values(app.workspace.getActiveDoc()?.entities ?? {}).filter((entity): entity is Item => isItem(entity) && !isItemArchived(entity)),
    app.workspace.boardFields.value, scope.value, app.workspace.activeBoard.value?.id ?? "",
    app.workspace.activeBoard.value?.preset?.bindings["field.notes"],
  ))
}

function registerConversationListeners(handlers: {
  navigate: (event?: HashChangeEvent) => void
  captureSelection: () => void
  contextual: (event: MouseEvent) => void
  dismissContext: (event: Event) => void
  menuKey: (event: KeyboardEvent) => void
  clear: () => void
}) {
  const { navigate, captureSelection, contextual, dismissContext, menuKey, clear } = handlers
  const onHashChange = () => { void navigate() }
  onMounted(() => {
    document.addEventListener("selectionchange", captureSelection)
    document.addEventListener("contextmenu", contextual)
    document.addEventListener("pointerdown", dismissContext)
    document.addEventListener("keydown", menuKey)
    window.addEventListener("hashchange", onHashChange)
    void navigate()
  })
  onBeforeUnmount(() => {
    clear()
    document.removeEventListener("selectionchange", captureSelection)
    document.removeEventListener("contextmenu", contextual)
    document.removeEventListener("pointerdown", dismissContext)
    document.removeEventListener("keydown", menuKey)
    window.removeEventListener("hashchange", onHashChange)
  })
}
