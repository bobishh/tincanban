import { nextTick, ref, shallowRef, type Ref } from "vue"
import { isItem } from "../domain/model"
import type { AppBoardContext } from "./useAppBoard"
import { commitBoardDrop } from "./commitBoardDrop"
import { findDragTarget, type DropMarker } from "./boardDragTarget"
import { createBoardDragGap } from "./boardDragGap"
import { captureSelection, restoreSelection, preserveSelectionAfterMove, type SelectionSnapshot } from "./boardDragSelection"
import "./boardDrag.css"

type DragPresentation = {
  highlightMoved(id: string, kind: "item" | "column"): void
}
export type DragPreview = { id: string; kind: "item" | "column"; title: string; card?: HTMLElement; width: number; height?: number }
type ActiveDrag = { workspaceId: string; boardId: string; id: string; kind: "item" | "column"; source: HTMLElement; sourceParentId: string; x: number; y: number; originX: number; originY: number; grabX: number; grabY: number; started: boolean; pointerId: number; touch: boolean; preview: DragPreview; target: DropMarker | null }

export function useBoardDragController(core: AppBoardContext, presentation: DragPresentation) {
  const dragPreview = shallowRef<DragPreview | null>(null)
  const dragPreviewElement: Ref<HTMLElement | null> = ref(null)
  const gap = createBoardDragGap()
  let board: HTMLElement | null = null
  let active: ActiveDrag | null = null
  let longPress: ReturnType<typeof setTimeout> | undefined
  let suppressClick = false
  let selectionSnapshot: SelectionSnapshot | null = null

  const clear = () => {
    const hadGesture = active !== null || selectionSnapshot !== null
    if (longPress) clearTimeout(longPress); longPress = undefined
    if (active) active.source.classList.remove("board-drag-source")
    board?.classList.remove("board-drag-pending", "board-dragging")
    if (hadGesture) restoreSelection(selectionSnapshot, board)
    selectionSnapshot = null
    active = null
    dragPreview.value = null
    gap.clear()
    frames.cancel()
  }
  const updateTarget = () => {
    // Measure the unchanged board, then reopen the visual gap. Its extra spacing
    // must not change the insertion target while the pointer stays still.
    gap.clear(); if (!active || !board) return
    active.target = findDragTarget(active, board)?.marker ?? null
    gap.show(active.target, active.source, board)
  }
  const frames = dragFrameLoop(() => {
    if (!active) return false
    if (!validDrag(active, board, core)) { clear(); return false }
    updateAutoscroll(active.x, active.y, board)
    updateTarget()
    positionPreview(active, dragPreviewElement.value)
    return nearScrollEdge(active, board)
  })
  const queuePoint = (x: number, y: number) => {
    if (!active) return
    active.x = x
    active.y = y
    frames.request()
  }
  const begin = (event: PointerEvent) => {
    if (!active || active.started) return
    active.started = true
    active.x = event.clientX
    active.y = event.clientY
    active.source.classList.add("board-drag-source")
    board?.classList.remove("board-drag-pending")
    restoreSelection(selectionSnapshot, board)
    board?.classList.add("board-dragging")
    dragPreview.value = active.preview
    updateTarget()
    const moving = active
    void nextTick(() => positionPreview(moving, dragPreviewElement.value))
  }
  const onPointerDown = (event: PointerEvent) => {
    if (!board || active || !canStartDrag(event, core)) return
    const drag = locateDragSource(event, board, core)
    if (!drag) return
    const moving: ActiveDrag = { ...drag, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, started: false, pointerId: event.pointerId, touch: event.pointerType === "touch", target: null }
    active = moving
    selectionSnapshot = captureSelection()
    if (!moving.touch) board.classList.add("board-drag-pending")
    if (moving.touch) longPress = setTimeout(() => { if (active === moving) { begin(event); queuePoint(moving.x, moving.y) } }, 180)
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return
    if (!active.started) {
      if (active.touch && Math.hypot(event.clientX - active.originX, event.clientY - active.originY) > 8) { clear(); return }
      if (active.touch && longPress) return
      if (!active.touch && Math.hypot(event.clientX - active.originX, event.clientY - active.originY) < 4) return
      begin(event)
    }
    event.preventDefault()
    queuePoint(event.clientX, event.clientY)
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return
    if (!active.started || !validDrag(active, board, core)) { clear(); return }
    active.x = event.clientX
    active.y = event.clientY
    updateTarget()
    const finished = { ...active, selection: selectionSnapshot }
    clear()
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
    preserveSelectionAfterMove(finished.selection, () => board, commitBoardDrop({ ...finished, title: finished.preview.title }, core, presentation))
  }
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onTouchMove = (event: TouchEvent) => { if (active?.started) event.preventDefault() }
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") clear() }
  const onBlur = () => clear()
  const handlers: BoardDragHandlers = { onPointerDown, onClick, onPointerMove, onPointerUp, onTouchMove, onKeyDown, onBlur, onCancel: clear }
  const detach = () => {
    clear()
    if (!board) return
    removeBoardListeners(board, handlers)
    board = null
  }
  const attach = (element: HTMLElement | null) => {
    if (board === element) return
    detach()
    board = element
    if (board) addBoardListeners(board, handlers)
  }
  const setupBoardDrag = async () => {
    await nextTick()
    const current = core.boardRef.value
    if (!current || !core.tincanban.activeBoard.value || !canDrag(core)) { detach(); return }
    attach(current)
    if (active && !validDrag(active, current, core)) clear()
  }
  return { dragPreview, setupBoardDrag, destroyBoardDrag: detach,
    setDragPreviewElement: (element: HTMLElement | null) => { dragPreviewElement.value = element },
  }
}

type BoardDragHandlers = { onPointerDown: (event: PointerEvent) => void; onClick: (event: MouseEvent) => void; onPointerMove: (event: PointerEvent) => void; onPointerUp: (event: PointerEvent) => void; onTouchMove: (event: TouchEvent) => void; onKeyDown: (event: KeyboardEvent) => void; onBlur: () => void; onCancel: () => void }
function addBoardListeners(board: HTMLElement, handlers: BoardDragHandlers) {
  board.addEventListener("pointerdown", handlers.onPointerDown)
  board.addEventListener("click", handlers.onClick, true)
  document.addEventListener("pointermove", handlers.onPointerMove, { passive: false })
  document.addEventListener("pointerup", handlers.onPointerUp)
  document.addEventListener("pointercancel", handlers.onCancel)
  document.addEventListener("touchmove", handlers.onTouchMove, { passive: false })
  document.addEventListener("keydown", handlers.onKeyDown)
  window.addEventListener("blur", handlers.onBlur)
}
function removeBoardListeners(board: HTMLElement, handlers: BoardDragHandlers) {
  board.removeEventListener("pointerdown", handlers.onPointerDown)
  board.removeEventListener("click", handlers.onClick, true)
  document.removeEventListener("pointermove", handlers.onPointerMove)
  document.removeEventListener("pointerup", handlers.onPointerUp)
  document.removeEventListener("pointercancel", handlers.onCancel)
  document.removeEventListener("touchmove", handlers.onTouchMove)
  document.removeEventListener("keydown", handlers.onKeyDown)
  window.removeEventListener("blur", handlers.onBlur)
}

function canDrag(core: AppBoardContext) { return core.canEditItems.value || core.isEditingBoard.value && core.canEditBoard.value }
function canStartDrag(event: PointerEvent, core: AppBoardContext) {
  if (event.button !== 0 || !canDrag(core)) return false
  const target = event.target instanceof Element ? event.target : null
  const control = target?.closest("button, input, select, textarea, a, [contenteditable=true]")
  return Boolean(target && (!control || control.matches(".card-open-button") && !core.isEditingBoard.value))
}
function locateDragSource(event: PointerEvent, board: HTMLElement, core: AppBoardContext) {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return null
  const kind: ActiveDrag["kind"] = core.isEditingBoard.value ? "column" : "item"
  const source = target.closest<HTMLElement>(kind === "column" ? ".column" : ".lead-card[data-item-id]")
  if (!source || !board.contains(source)) return null
  if (kind === "column" && (!core.canEditBoard.value || !target.closest(".column-header.column-drag-handle"))) return null
  const id = source.dataset[kind === "item" ? "itemId" : "columnId"]
  if (!id) return null
  const bounds = source.getBoundingClientRect()
  const preview = createDragPreview(id, kind, source, core)
  if (!preview) return null
  return { workspaceId: core.tincanban.activeWorkspace.id, boardId: core.tincanban.activeBoard.value!.id, id, kind, source, sourceParentId: source.closest<HTMLElement>("[data-column-id]")?.dataset.columnId ?? "", preview, grabX: event.clientX - bounds.left, grabY: event.clientY - bounds.top }
}

function createDragPreview(id: string, kind: "item" | "column", source: HTMLElement, core: AppBoardContext): DragPreview | null {
  const { width, height } = source.getBoundingClientRect()
  if (kind === "column") {
    const column = core.tincanban.genericColumns.value.find(candidate => candidate.id === id)
    return column ? { id, kind, title: column.title, width } : null
  }
  const item = core.tincanban.getActiveDoc()?.entities[id]
  if (!isItem(item)) return null
  // Snapshot the rendered card, including filtered excerpts, fields, aging and
  // discussion badges. The original remains owned by Vue in its source stack.
  const card = source.cloneNode(true) as HTMLElement
  card.classList.remove("card-moved")
  card.dataset.inkId = id
  delete card.dataset.itemId
  for (const element of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("id")
    for (const name of element.getAttributeNames()) if (name.startsWith("data-discussion-")) element.removeAttribute(name)
  }
  return { id, kind, title: item.title, card, width, height }
}

function positionPreview(drag: ActiveDrag, element: HTMLElement | null) {
  if (element) element.style.transform = `translate3d(${drag.x - drag.grabX}px, ${drag.y - drag.grabY}px, 0)`
}
function nearScrollEdge(drag: ActiveDrag, board: HTMLElement | null) {
  if (!board) return false
  const bounds = board.getBoundingClientRect()
  return drag.x < bounds.left + 80 || drag.x > bounds.right - 80 || drag.y < 80 || drag.y > window.innerHeight - 80
}
function updateAutoscroll(x: number, y: number, board: HTMLElement | null) {
  if (!board) return
  const bounds = board.getBoundingClientRect()
  const amount = (point: number, start: number, end: number) => point < start + 72 ? -Math.ceil((start + 72 - point) / 8) : point > end - 72 ? Math.ceil((point - (end - 72)) / 8) : 0
  board.scrollLeft += amount(x, bounds.left, bounds.right)
  scrollNearestAncestor(x, y, amount)
  if (y < 80) window.scrollBy(0, -Math.ceil((80 - y) / 8))
  else if (y > window.innerHeight - 80) window.scrollBy(0, Math.ceil((y - (window.innerHeight - 80)) / 8))
}
function scrollNearestAncestor(x: number, y: number, amount: (point: number, start: number, end: number) => number) {
  let ancestor = document.elementFromPoint(x, y)?.parentElement ?? null
  while (ancestor && ancestor !== document.body) {
    const bounds = ancestor.getBoundingClientRect()
    if (ancestor.scrollHeight > ancestor.clientHeight && y > bounds.top && y < bounds.bottom) {
      ancestor.scrollTop += amount(y, bounds.top, bounds.bottom)
      return
    }
    ancestor = ancestor.parentElement
  }
}

function dragFrameLoop(run: () => boolean) {
  let id = 0
  const tick = () => { id = 0; if (run()) request() }
  const request = () => { if (!id) id = requestAnimationFrame(tick) }
  return { request, cancel() { if (id) cancelAnimationFrame(id); id = 0 } }
}

function validDrag(drag: ActiveDrag, board: HTMLElement | null, core: AppBoardContext) {
  if (!board?.contains(drag.source) || core.tincanban.activeWorkspace.id !== drag.workspaceId || core.tincanban.activeBoard.value?.id !== drag.boardId) return false
  if (core.isEditingBoard.value !== (drag.kind === "column")) return false
  if (!(drag.kind === "column" ? core.canEditBoard.value : core.canEditItems.value)) return false
  return !drag.target || Boolean(board.querySelector(`[data-column-id="${CSS.escape(drag.target.targetId)}"]`))
}
