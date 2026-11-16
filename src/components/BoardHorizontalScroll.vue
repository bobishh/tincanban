<script setup lang="ts">
import { ref, watchEffect } from "vue"

const props = defineProps<{ board: HTMLElement | null }>()
const limit = ref(0)
const position = ref(0)
const thumbWidth = ref("100%")

watchEffect(onCleanup => {
  const { board } = props
  if (!board) return
  const track = () => { position.value = Math.round(board.scrollLeft) }
  const measure = () => {
    const { clientWidth, scrollWidth } = board
    limit.value = scrollWidth - clientWidth
    thumbWidth.value = scrollWidth ? `${clientWidth / scrollWidth * 100}%` : "100%"
    track()
  }
  const size = new ResizeObserver(measure)
  const observeWidths = () => {
    size.disconnect()
    size.observe(board)
    for (const child of board.children) size.observe(child)
    measure()
  }
  const children = new MutationObserver(observeWidths)
  children.observe(board, { childList: true })
  observeWidths()
  board.addEventListener("scroll", track, { passive: true })
  board.addEventListener("wheel", scrollWithShift, { passive: false })
  onCleanup(() => {
    size.disconnect()
    children.disconnect()
    board.removeEventListener("scroll", track)
    board.removeEventListener("wheel", scrollWithShift)
  })
})

function scrollFromSlider(event: Event) {
  props.board?.scrollTo({ left: (event.target as HTMLInputElement).valueAsNumber, behavior: "instant" })
}

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

<template>
  <div class="board-scrollbar">
    <input v-show="limit > 0" class="board-scrollbar-input" type="range" min="0" :max="limit" :value="position"
      :style="{ '--thumb-width': thumbWidth }" aria-label="Scroll board horizontally" @input="scrollFromSlider" />
  </div>
</template>

<style scoped>
.board-scrollbar { display: none; }

@media (min-width: 769px) {
  /* Clip page overflow without creating an ancestor scroll container. */
  :global(body:has(.board-scrollbar)) { overflow-x: clip; }
  /* Keep the page header in its original scroll flow. */
  :global(.shell:has(.board-scrollbar) > .topbar) { position: relative; }

  .board-scrollbar {
    position: sticky;
    top: 0;
    z-index: 4;
    display: block;
    height: var(--section-gap);
    /* Use the existing space above the columns, including while this component loads. */
    margin-bottom: calc(-1 * var(--section-gap));
    padding-inline: var(--site-gutter);
    pointer-events: none;
  }
}

.board-scrollbar-input {
  display: block;
  width: 100%;
  height: 100%;
  margin: 0;
  appearance: none;
  background: linear-gradient(var(--soft), var(--soft)) center / 100% 6px no-repeat var(--paper);
  cursor: pointer;
  pointer-events: auto;
}

.board-scrollbar-input::-webkit-slider-thumb {
  appearance: none;
  width: clamp(24px, var(--thumb-width), 100%);
  height: 10px;
  border-radius: 5px;
  background: var(--muted);
  cursor: grab;
}

.board-scrollbar-input::-moz-range-thumb {
  width: clamp(24px, var(--thumb-width), 100%);
  height: 10px;
  border: 0;
  border-radius: 5px;
  background: var(--muted);
  cursor: grab;
}

@media (forced-colors: active) {
  .board-scrollbar-input { appearance: auto; }
  .board-scrollbar-input::-webkit-slider-thumb { appearance: auto; }
}
</style>
