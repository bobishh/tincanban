<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { cycleSpatialWindow, ensureWindowHost, focusSpatialWindow, raiseWindow, registerSpatialWindow, saveWindowGeometry, unregisterSpatialWindow, updateWindowGeometry, type WindowDescriptor, type WindowGeometry } from "../ui/windowManager"
import { hideLeavingElement, showEnteringElement } from "../ui/modal"
import ScrollFrame from "./ScrollFrame.vue"

const props = withDefaults(defineProps<{
  windowId: string; workspaceId: string; title: string; ariaLabel?: string; closeLabel?: string; resizeLabel?: string; initialWidth?: number; initialHeight?: number; framed?: boolean
}>(), { initialWidth: 620, initialHeight: 620, closeLabel: "Close" })
const emit = defineEmits<{ close: [] }>()
const host = ensureWindowHost()
const root = ref<HTMLElement | null>(null)
const descriptor = shallowRef<WindowDescriptor | null>(null)
const duplicate = ref(false)
const maximized = ref(false)
const geometryAnimating = ref(false)
let restored: WindowGeometry | null = null
let deferredFocusFrame = 0
let gesture: { id: number; x: number; y: number; initial: WindowGeometry; resize: boolean } | null = null
const style = computed(() => {
  const entry = descriptor.value
  if (!entry) return { visibility: "hidden" as const }
  const g = entry.geometry
  return { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px`, zIndex: entry.z }
})
function register() {
  if (descriptor.value) unregisterSpatialWindow(descriptor.value)
  if (!root.value) return
  descriptor.value = registerSpatialWindow(props.workspaceId, props.windowId, root.value, {
    x: Math.max(12, (window.innerWidth - props.initialWidth) / 2), y: 80,
    width: props.initialWidth, height: props.initialHeight,
  })
  duplicate.value = !descriptor.value
  if (descriptor.value) {
    const entry = descriptor.value
    root.value.focus({ preventScroll: true })
    // Click default focus can run after mount; defer only while its own card still holds focus.
    deferredFocusFrame = requestAnimationFrame(() => {
      deferredFocusFrame = 0
      const activeElement = document.activeElement
      const activeItemId = activeElement instanceof HTMLElement
        ? activeElement.closest<HTMLElement>("[data-item-id]")?.dataset.itemId
        : undefined
      const sameTriggerStillFocused = activeElement === entry.trigger || activeItemId === entry.windowId.slice("item:".length)
      if (descriptor.value === entry && root.value?.isConnected && sameTriggerStillFocused)
        focusSpatialWindow(entry.workspaceId, entry.windowId)
    })
  }
}
function raise() { if (descriptor.value) raiseWindow(descriptor.value) }
function start(event: PointerEvent, resize = false) {
  if (event.button !== 0 || (!resize && (event.target as HTMLElement).closest("button, a, input, textarea, [data-discussion-text]"))) return
  if (!descriptor.value || maximized.value) return
  geometryAnimating.value = false
  raise()
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: { ...descriptor.value.geometry }, resize }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}
function move(event: PointerEvent) {
  if (!gesture || gesture.id !== event.pointerId || !descriptor.value) return
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
  updateWindowGeometry(descriptor.value, gesture.resize
    ? { ...gesture.initial, width: gesture.initial.width + dx, height: gesture.initial.height + dy }
    : { ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy })
}
function end() { gesture = null; if (descriptor.value) saveWindowGeometry(descriptor.value) }
function arrow(event: KeyboardEvent, resize = false) {
  if (event.target !== event.currentTarget || !descriptor.value || maximized.value) return
  const delta = event.shiftKey ? 40 : 10
  const dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0
  const dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0
  if (!dx && !dy) return
  geometryAnimating.value = false
  event.preventDefault()
  const g = descriptor.value.geometry
  updateWindowGeometry(descriptor.value, resize ? { ...g, width: g.width + dx, height: g.height + dy } : { ...g, x: g.x + dx, y: g.y + dy })
  saveWindowGeometry(descriptor.value)
}
function resizeViewport() {
  geometryAnimating.value = false
  if (!descriptor.value) return
  updateWindowGeometry(descriptor.value, maximized.value ? { x: 12, y: 12, width: window.innerWidth, height: window.innerHeight } : descriptor.value.geometry)
}
function maximize() {
  if (!descriptor.value) return
  geometryAnimating.value = true
  if (maximized.value && restored) updateWindowGeometry(descriptor.value, restored)
  else { restored = { ...descriptor.value.geometry }; updateWindowGeometry(descriptor.value, { x: 12, y: 12, width: window.innerWidth, height: window.innerHeight }) }
  maximized.value = !maximized.value
}
function keydown(event: KeyboardEvent) {
  if (event.altKey && event.code === "Backquote") { event.preventDefault(); cycleSpatialWindow(props.workspaceId, event.shiftKey) }
  else if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.stopPropagation(); emit("close") }
}
onMounted(() => { register(); window.addEventListener("resize", resizeViewport); root.value?.focus() })
watch(() => [props.windowId, props.workspaceId], () => { maximized.value = false; restored = null; register() })
onBeforeUnmount(() => { window.removeEventListener("resize", resizeViewport); if (deferredFocusFrame) cancelAnimationFrame(deferredFocusFrame); if (descriptor.value) unregisterSpatialWindow(descriptor.value) })
</script>

<template>
  <Teleport :to="host">
    <Transition name="window" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
    <section v-if="!duplicate" ref="root" class="dialog spatial-window" :class="{ 'spatial-geometry-motion': geometryAnimating }" role="dialog" :aria-label="ariaLabel ?? title" tabindex="-1"
      :data-window-id="windowId" :style="style" @pointerdown.capture="raise" @focusin="raise" @keydown="keydown">
      <header class="spatial-titlebar" tabindex="0" :aria-label="`Move ${title}: arrow keys`"
        @pointerdown="start($event)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="arrow($event)">
        <div class="spatial-heading"><slot name="header"><strong>{{ title }}</strong></slot></div>
        <div class="spatial-controls">
          <button class="icon-button spatial-maximize" type="button" :aria-label="maximized ? 'Restore window size' : 'Maximize window'" :title="maximized ? 'Restore window size' : 'Maximize window'" @click="maximize"><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="maximized" d="M8 8h12v12H8zM4 16V4h12v4" /><rect v-else x="4" y="4" width="16" height="16" /></svg></button>
          <button class="icon-button" type="button" :aria-label="closeLabel" title="Close window" @click="emit('close')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        </div>
      </header>
      <div :key="`${workspaceId}:${windowId}`" class="spatial-body" :class="{ 'spatial-body-framed': framed }">
        <slot name="toolbar" />
        <ScrollFrame v-if="framed"><slot /></ScrollFrame>
        <slot v-else />
      </div>
      <button class="spatial-resize" type="button" :aria-label="resizeLabel ?? `Resize ${title}: arrow keys`" :disabled="maximized"
        @pointerdown="start($event, true)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="arrow($event, true)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 20 12-12M14 20l6-6" /></svg></button>
    </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.spatial-window { container: detail-window / inline-size; padding: 0; max-width: none; max-height: none; position: absolute; display: flex; flex-direction: column; pointer-events: auto; min-width: 0; min-height: 0; background: var(--panel, white); color: var(--ink, #171717); border: 2px solid var(--line, #171717); box-shadow: 6px 6px 0 var(--ink, #171717); overflow: hidden; }
.spatial-window { animation: window-appear var(--motion-panel) var(--motion-ease); }
.spatial-geometry-motion { transition: left var(--motion-panel) var(--motion-ease), top var(--motion-panel) var(--motion-ease), width var(--motion-panel) var(--motion-ease), height var(--motion-panel) var(--motion-ease); }
.window-leave-active { transition: opacity var(--motion-fast) ease, transform var(--motion-panel) var(--motion-ease); pointer-events: none; }
.window-leave-to { opacity: 0; transform: translateY(6px) scale(.985); }
.spatial-titlebar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; padding: 8px 12px; min-height: 52px; border-bottom: 2px solid var(--line, #171717); background: var(--soft, #eee); touch-action: none; user-select: none; cursor: grab; }
.spatial-titlebar :deep([data-discussion-text]) { user-select: text; -webkit-user-select: text; cursor: text; }
.spatial-heading { flex: 1; min-width: 0; padding-block: 6px; line-height: 1.5; overflow-wrap: anywhere; }
.spatial-controls { display: flex; flex: none; gap: 4px; }
.spatial-controls button { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: 8px; }
.spatial-controls svg, .spatial-resize svg { display: block; width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.spatial-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.spatial-body { animation: panel-appear var(--motion-panel) var(--motion-ease); }
.spatial-body-framed { display: flex; flex-direction: column; padding: 18px; overflow: hidden; }
.spatial-resize { position: absolute; bottom: 0; right: 0; width: 44px; height: 44px; padding: 16px 2px 2px 16px; background: transparent; border: 0; color: var(--muted, #666); cursor: nwse-resize; touch-action: none; user-select: none; }
.spatial-resize:disabled { visibility: hidden; }
@media (max-width: 600px) {
  .spatial-window {
    transition: none;
    left: max(6px, var(--safe-left)) !important;
    top: max(6px, var(--safe-top)) !important;
    width: calc(100vw - max(6px, var(--safe-left)) - max(6px, var(--safe-right))) !important;
    height: calc(100dvh - max(6px, var(--safe-top)) - max(6px, var(--safe-bottom))) !important;
  }
  .spatial-titlebar { cursor: default; }
  .spatial-resize { display: none; }
  .spatial-controls .spatial-maximize { display: none; }
}
</style>

<style>
.spatial-window .spatial-detail { width: 100%; height: 100%; max-height: none; padding: 18px; box-sizing: border-box; }
.spatial-heading .detail-head { margin: 0; align-items: center; gap: 8px; }
.spatial-heading .detail-head > :first-child { flex: 1; min-width: 0; }
.spatial-heading .detail-head-actions { flex-shrink: 0; }
.spatial-heading .detail-head-actions .button { white-space: nowrap; min-width: 44px; }
.spatial-heading .detail-head h2 { margin: 0; font-size: 1.15rem; }
.spatial-heading .detail-head p { margin: 2px 0 0; font-size: .85rem; line-height: 1.2; }
.spatial-window .status-strip-shell { position: relative; min-width: 0; flex: none; margin-bottom: 10px; }
.spatial-window .stage-scroll { position: absolute; top: 0; bottom: 3px; z-index: 1; width: 32px; min-height: 40px; padding: 0; border: 0; font-size: 1.4rem; color: var(--ink); cursor: pointer; }
.spatial-window .stage-scroll-earlier { left: 0; background: linear-gradient(to right, var(--panel) 60%, transparent); }
.spatial-window .stage-scroll-later { right: 0; background: linear-gradient(to left, var(--panel) 60%, transparent); }
.spatial-window .status-strip { flex: none; flex-wrap: nowrap; overflow-x: auto; margin-bottom: 0; padding: 3px 3px 6px; }
.spatial-window .status-strip button { flex-shrink: 0; }
.spatial-window .status-strip button { transition: background-color var(--motion-fast) ease, color var(--motion-fast) ease; }
.scroll-frame .detail-section:first-child { margin-top: 0; }
@media (max-width: 600px) {
  .spatial-titlebar { padding: 4px 8px; gap: 6px; }
  .spatial-heading { padding-block: 2px; }
  .spatial-window .spatial-detail, .spatial-body-framed { padding: 8px; }
  .spatial-heading .detail-head-actions .button { min-height: 40px; padding: 4px 8px; }
  .spatial-heading .detail-head h2 { font-size: 1.05rem; }
  .spatial-heading .detail-head .eyebrow { display: none; }
}
.spatial-window .spatial-detail > .detail-layout { flex: 1; }
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; min-width: 0; }
.detail-primary, .detail-inspector { min-width: 0; }
.detail-inspector { display: grid; align-content: start; gap: 22px; }
@container detail-window (min-width: 920px) {
  .detail-layout { grid-template-columns: minmax(0, 1.8fr) minmax(270px, .9fr); gap: 32px; align-items: start; }
  .detail-primary { grid-column: 1; grid-row: 1; }
  .detail-inspector { grid-column: 2; grid-row: 1; }
  .detail-inspector { padding-left: 24px; border-left: 2px solid var(--line); }
}
</style>
