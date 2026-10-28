import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue"
import type { Anchor } from "../chat/context"
import { captureSelectedSource, findSourceOwner, type SelectedSource } from "../chat/sourceSelection"

type DiscussionSource = { itemId: string; fieldId?: string; selection?: Anchor["selection"]; x: number; y: number }

/** Capture source selections and keep the destination picker independent of chat drafts. */
export function useDiscussionActions(openChats: Readonly<Ref<{ id: string; title: string }[]>>,
  submit: (source: DiscussionSource, destinationId?: string) => Promise<void>) {
  const selection = ref<SelectedSource | null>(null)
  const contextMenu = ref<(DiscussionSource & { chooseChat?: boolean }) | null>(null)
  function focusOrigin(itemId: string) {
    const owner = findSourceOwner(itemId)
    if (owner) owner.focus({ preventScroll: true })
    else document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"] .card-open-button`)?.focus({ preventScroll: true })
  }
  async function placeMenu() {
    const current = contextMenu.value
    await nextTick()
    if (!current || contextMenu.value !== current) return
    const menu = document.querySelector<HTMLElement>(".discussion-context-menu")
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    current.x = Math.max(8, Math.min(current.x, window.innerWidth - bounds.width - 8))
    current.y = Math.max(8, Math.min(current.y, window.innerHeight - bounds.height - 8))
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true })
  }
  function chooseDiscussion(value: { itemId: string; fieldId?: string; selection?: Anchor["selection"]; x: number; y: number }) {
    if (!openChats.value.length) { focusOrigin(value.itemId); void submit(value); return }
    contextMenu.value = { ...value, chooseChat: true, x: Math.min(value.x, Math.max(8, window.innerWidth - 360)) }
    selection.value = null
    void placeMenu()
  }
  function selectedDiscuss() { if (selection.value) chooseDiscussion(selection.value) }
  function discussIn(destinationId?: string) {
    const value = contextMenu.value
    if (value) { focusOrigin(value.itemId); void submit(value, destinationId) }
  }

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
    void placeMenu()
  }
  function contextualDiscuss() { if (contextMenu.value) chooseDiscussion(contextMenu.value) }
  function dismissContext(event: Event) {
    if (!(event.target instanceof Element) || !event.target.closest(".discussion-context-menu")) contextMenu.value = null
  }
  function menuKey(event: KeyboardEvent) {
    if (contextMenu.value && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(".discussion-context-menu button:not(:disabled)")]
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      event.preventDefault(); event.stopPropagation()
    } else if (event.key === "Escape" && contextMenu.value) {
      contextMenu.value = null
      event.preventDefault(); event.stopPropagation()
    }
  }
  function clear() { selection.value = null; contextMenu.value = null }
  onMounted(() => {
    document.addEventListener("selectionchange", captureSelection)
    document.addEventListener("contextmenu", contextual)
    document.addEventListener("pointerdown", dismissContext)
    document.addEventListener("keydown", menuKey, true)
  })
  onBeforeUnmount(() => {
    document.removeEventListener("selectionchange", captureSelection)
    document.removeEventListener("contextmenu", contextual)
    document.removeEventListener("pointerdown", dismissContext)
    document.removeEventListener("keydown", menuKey, true)
  })
  return { selection, contextMenu, selectedDiscuss, contextualDiscuss, discussIn, clear }
}
