<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

const viewport = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const metrics = ref({ height: 1, total: 1, top: 0 })
let observer: ResizeObserver | undefined
function measure() {
  const element = viewport.value
  if (element) metrics.value = { height: element.clientHeight, total: Math.max(1, element.scrollHeight), top: element.scrollTop }
}
const overflowing = computed(() => metrics.value.total > metrics.value.height + 1)
const thumbStyle = computed(() => ({
  height: `${metrics.value.height / metrics.value.total * 100}%`,
  top: `${metrics.value.top / metrics.value.total * 100}%`,
}))
onMounted(() => {
  observer = new ResizeObserver(measure)
  if (viewport.value) observer.observe(viewport.value)
  if (content.value) observer.observe(content.value)
  measure()
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="scroll-frame">
    <div ref="viewport" class="scroll-frame-viewport" @scroll.passive="measure">
      <div ref="content" class="scroll-frame-content"><slot /></div>
    </div>
    <div v-if="overflowing" class="scroll-frame-track" aria-hidden="true"><span class="scroll-frame-thumb" :style="thumbStyle"></span></div>
  </div>
</template>

<style scoped>
.scroll-frame { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.scroll-frame-viewport { height: 100%; overflow: auto; overscroll-behavior: contain; scrollbar-width: none; padding: var(--space-3) var(--space-4) var(--space-3) var(--space-3); }
.scroll-frame-viewport::-webkit-scrollbar { display: none; }
.scroll-frame-track { position: absolute; inset: 6px 5px 6px auto; width: 5px; background: var(--soft); border-image-source: none !important; pointer-events: none; }
.scroll-frame-thumb { position: absolute; right: 0; width: 100%; background: var(--muted); border-image-source: none !important; }
</style>
