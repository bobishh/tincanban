<script setup lang="ts">
import { watchEffect } from "vue"

const props = defineProps<{ board: HTMLElement | null }>()

watchEffect(onCleanup => {
  if (!props.board) return
  const board = props.board
  let pan: { pointerId: number; x: number; left: number } | undefined

  function stop() {
    if (!pan) return
    const { pointerId } = pan
    pan = undefined
    board.removeAttribute("data-board-panning")
    if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId)
  }

  function start(event: PointerEvent) {
    if (pan || !event.isPrimary || event.button !== 0 || event.pointerType === "touch") return
    const target = event.target
    if (!(target instanceof Element) || target.closest(
      ".lead-card, .column-drag-handle, button, a, input, select, textarea, label, [contenteditable=true]",
    )) return
    // Native scrollbars can target the scroll container itself.
    const { left, top } = board.getBoundingClientRect()
    if (event.clientX >= left + board.clientWidth || event.clientY >= top + board.clientHeight) return
    if (board.scrollWidth <= board.clientWidth) return
    pan = { pointerId: event.pointerId, x: event.clientX, left: board.scrollLeft }
    board.setPointerCapture(event.pointerId)
    board.setAttribute("data-board-panning", "")
    event.preventDefault()
  }

  function move(event: PointerEvent) {
    if (pan?.pointerId === event.pointerId) board.scrollLeft = pan.left + pan.x - event.clientX
  }

  function end(event: PointerEvent) {
    if (pan?.pointerId === event.pointerId) stop()
  }

  const measure = () => {
    const overflow = board.scrollWidth > board.clientWidth
    board.toggleAttribute("data-board-pannable", overflow)
    if (!overflow) stop()
  }
  const size = new ResizeObserver(measure)
  const observeColumns = () => {
    size.disconnect()
    size.observe(board)
    for (const child of board.children) size.observe(child)
    measure()
  }
  const children = new MutationObserver(observeColumns)
  children.observe(board, { childList: true })
  observeColumns()

  const listeners = new AbortController()
  const { signal } = listeners
  board.addEventListener("pointerdown", start, { signal })
  board.addEventListener("pointermove", move, { signal })
  board.addEventListener("pointerup", end, { signal })
  board.addEventListener("pointercancel", end, { signal })
  board.addEventListener("lostpointercapture", end, { signal })
  board.addEventListener("wheel", scrollWithShift, { passive: false, signal })
  window.addEventListener("blur", stop, { signal })
  onCleanup(() => {
    listeners.abort()
    stop()
    size.disconnect()
    children.disconnect()
    board.removeAttribute("data-board-pannable")
  })
})

function scrollWithShift(event: WheelEvent) {
  if (!event.shiftKey || event.ctrlKey || event.deltaX || !event.deltaY || !event.cancelable) return
  const board = event.currentTarget as HTMLElement
  const start = board.scrollLeft
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? board.clientWidth : 1
  board.scrollLeft += event.deltaY * unit
  if (board.scrollLeft !== start) event.preventDefault()
}
</script>

<template><slot /></template>

<style>
@media (any-pointer: fine) {
  [data-board-pannable] { cursor: grab; }
}
.board[data-board-panning], [data-board-panning] * { cursor: grabbing; }
.board[data-board-panning] { scroll-snap-type: none; user-select: none; }
</style>
