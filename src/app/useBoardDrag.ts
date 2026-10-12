import { nextTick, ref, shallowRef, type Ref } from "vue"
import type { Lead } from "../types"
import type { Item } from "../domain/model"
import { isItem } from "../domain/model"
import type { AppBoardContext } from "./useAppBoard"
import { commitBoardDrop } from "./commitBoardDrop"
import { findDragTarget, type DropMarker, type MarkerPosition } from "./boardDragTarget"
import { captureSelection, restoreSelection, preserveSelectionAfterMove, type SelectionSnapshot } from "./boardDragSelection"
import "./boardDrag.css"

type DragPresentation = {
  leadForItem(item: Item): Pick<Lead, "company" | "role" | "priority" | "fitScore" | "location"> | undefined
  cardFields(item: Item): { id: string; title: string; value: string }[]
  cardNotes(item: Item): string | null
  highlightMoved(id: string, kind: "item" | "column"): void
}
export type DragPreview = { id: string; kind: "item" | "column"; title: string; lead?: ReturnType<DragPresentation["leadForItem"]>; ageLevel?: string; ageLabel?: string; body?: string; context: ReturnType<DragPresentation["cardFields"]>; notes?: string; width: number }
type ActiveDrag = { workspaceId: string; boardId: string; id: string; kind: "item" | "column"; source: HTMLElement; sourceParentId: string; x: number; y: number; originX: number; originY: number; started: boolean; pointerId: number; touch: boolean; preview: DragPreview; target: DropMarker | null }

export function useBoardDragController(core: AppBoardContext, presentation: DragPresentation) {
  const dragPreview = shallowRef<DragPreview | null>(null)
  const dropMarker = shallowRef<DropMarker | null>(null)
  const dragPreviewElement: Ref<HTMLElement | null> = ref(null)
  const dropMarkerElement: Ref<HTMLElement | null> = ref(null)
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
    dropMarker.value = null
    frames.cancel()
  }
  const updateTarget = () => {
    if (active && board) refreshTarget(active, board, dropMarker, dropMarkerElement)
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
    const drag = locateDragSource(event, board, core, presentation)
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
  return { dragPreview, dropMarker, setupBoardDrag, destroyBoardDrag: detach,
    setDragPreviewElement: (element: HTMLElement | null) => { dragPreviewElement.value = element },
    setDropMarkerElement: (element: HTMLElement | null) => { dropMarkerElement.value = element },
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
  if (target?.closest("[data-discussion-text]") && pointerHitsText(event)) return false
  const control = target?.closest("button, input, select, textarea, a, [contenteditable=true]")
  return Boolean(target && (!control || control.matches(".card-open-button") && !core.isEditingBoard.value))
}
function pointerHitsText(event: PointerEvent) {
  const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY)
  const position = document.caretPositionFromPoint?.(event.clientX, event.clientY)
  const text = caret?.startContainer ?? position?.offsetNode
  const offset = caret?.startOffset ?? position?.offset
  if (!text || offset === undefined || text.nodeType !== Node.TEXT_NODE) return false
  const length = text.textContent?.length ?? 0
  if (!length) return false
  const range = document.createRange()
  range.setStart(text, Math.max(0, offset - 1))
  range.setEnd(text, Math.min(length, offset + 1))
  return [...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
}

function locateDragSource(event: PointerEvent, board: HTMLElement, core: AppBoardContext, presentation: DragPresentation) {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return null
  const kind: ActiveDrag["kind"] = core.isEditingBoard.value ? "column" : "item"
  const source = target.closest<HTMLElement>(kind === "column" ? ".column" : ".lead-card[data-item-id]")
  if (!source || !board.contains(source)) return null
  if (kind === "column" && (!core.canEditBoard.value || !target.closest(".column-header.column-drag-handle"))) return null
  const id = source.dataset[kind === "item" ? "itemId" : "columnId"]
  if (!id) return null
  const bounds = source.getBoundingClientRect()
  const preview = createDragPreview(id, kind, bounds.width, core, presentation)
  if (!preview) return null
  Object.assign(preview, previewAge(source))
  return { workspaceId: core.tincanban.activeWorkspace.id, boardId: core.tincanban.activeBoard.value!.id, id, kind, source, sourceParentId: source.closest<HTMLElement>("[data-column-id]")?.dataset.columnId ?? "", preview }
}

function previewAge(source: HTMLElement) {
  return { ageLevel: [...source.classList].find(name => name.startsWith("card-aging-")),
    ageLabel: source.querySelector(".card-activity-age")?.textContent ?? undefined }
}

function createDragPreview(id: string, kind: "item" | "column", width: number, core: AppBoardContext, presentation: DragPresentation): DragPreview | null {
  if (kind === "column") {
    const column = core.tincanban.genericColumns.value.find(candidate => candidate.id === id)
    return column ? { id, kind, title: column.title, width, context: [] } : null
  }
  const item = core.tincanban.getActiveDoc()?.entities[id]
  if (!isItem(item)) return null
  const lead = presentation.leadForItem(item)
  return { id, kind, title: item.title, lead, body: item.body, context: presentation.cardFields(item), notes: presentation.cardNotes(item) ?? undefined, width }
}

function positionPreview(drag: ActiveDrag, element: HTMLElement | null) {
  if (element) element.style.transform = `translate3d(${drag.x + 14}px, ${drag.y + 14}px, 0)`
}
function applyMarker(position: MarkerPosition, element: HTMLElement | null) {
  if (!element) return
  element.style.width = `${position.width}px`
  element.style.height = position.vertical ? `${position.height ?? 0}px` : "4px"
  element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
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

function refreshTarget(drag: ActiveDrag, board: HTMLElement, marker: Ref<DropMarker | null>, element: Ref<HTMLElement | null>) {
  const result = findDragTarget(drag, board)
  drag.target = result?.marker ?? null
  if (!result) { if (marker.value) marker.value = null; return }
  const current = marker.value
  if (current?.targetId === result.marker.targetId && current.beforeId === result.marker.beforeId && current.vertical === result.marker.vertical) {
    applyMarker(result.position, element.value)
    return
  }
  marker.value = result.marker
  void nextTick(() => {
    if (marker.value === result.marker || marker.value?.targetId === result.marker.targetId && marker.value.beforeId === result.marker.beforeId) applyMarker(result.position, element.value)
  })
}

function validDrag(drag: ActiveDrag, board: HTMLElement | null, core: AppBoardContext) {
  if (!board?.contains(drag.source) || core.tincanban.activeWorkspace.id !== drag.workspaceId || core.tincanban.activeBoard.value?.id !== drag.boardId) return false
  if (core.isEditingBoard.value !== (drag.kind === "column")) return false
  if (!(drag.kind === "column" ? core.canEditBoard.value : core.canEditItems.value)) return false
  return !drag.target || Boolean(board.querySelector(`[data-column-id="${CSS.escape(drag.target.targetId)}"]`))
}
