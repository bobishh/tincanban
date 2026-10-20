<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { cycleSpatialWindow, ensureWindowHost, focusSpatialWindow, raiseWindow, registerSpatialWindow, saveWindowGeometry, unregisterSpatialWindow, updateWindowGeometry, type WindowDescriptor, type WindowGeometry } from "../ui/windowManager"
import { hideLeavingElement, showEnteringElement } from "../ui/modal"
import ScrollFrame from "./ScrollFrame.vue"

const props = withDefaults(defineProps<{
  windowId: string; workspaceId: string; title: string; ariaLabel?: string; closeLabel?: string; resizeLabel?: string; initialWidth?: number; initialHeight?: number; framed?: boolean; busy?: boolean; modal?: boolean
}>(), { initialWidth: 620, initialHeight: 620, closeLabel: "Close", modal: false })
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
  }, props.modal)
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
  // A keyboard choice takes precedence over the opening click's focus repair.
  if (deferredFocusFrame) { cancelAnimationFrame(deferredFocusFrame); deferredFocusFrame = 0 }
  if (event.altKey && event.code === "Backquote") { event.preventDefault(); cycleSpatialWindow(props.workspaceId, event.shiftKey) }
  else if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.stopPropagation(); if (!props.busy) emit("close") }
}
onMounted(() => { register(); window.addEventListener("resize", resizeViewport); root.value?.focus() })
watch(() => [props.windowId, props.workspaceId], () => { maximized.value = false; restored = null; register() })
onBeforeUnmount(() => { window.removeEventListener("resize", resizeViewport); if (deferredFocusFrame) cancelAnimationFrame(deferredFocusFrame); if (descriptor.value) unregisterSpatialWindow(descriptor.value) })
</script>

<template>
  <Teleport :to="host">
    <Transition name="window" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
    <section v-if="!duplicate" ref="root" class="dialog spatial-window" :class="{ 'spatial-geometry-motion': geometryAnimating }" role="dialog" :aria-label="ariaLabel ?? title" :aria-modal="modal ? 'true' : undefined" tabindex="-1"
      :data-window-id="windowId" :style="style" @pointerdown.capture="raise" @focusin="raise" @keydown="keydown">
      <header class="spatial-titlebar" tabindex="0" :aria-label="`Move ${title}: arrow keys`" :title="title"
        @pointerdown="start($event)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="arrow($event)">
        <div class="spatial-heading"><slot name="header"><strong>{{ title }}</strong></slot></div>
        <div class="spatial-controls">
          <button class="icon-button spatial-maximize" type="button" :aria-label="maximized ? 'Restore window size' : 'Maximize window'" :title="maximized ? 'Restore window size' : 'Maximize window'" @click="maximize"><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="maximized" d="M8 8h12v12H8zM4 16V4h12v4" /><rect v-else x="4" y="4" width="16" height="16" /></svg></button>
          <button class="icon-button" type="button" :aria-label="closeLabel" title="Close window" :disabled="busy" @click="emit('close')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        </div>
      </header>
      <div :key="`${workspaceId}:${windowId}`" class="spatial-body" :class="{ 'spatial-body-framed': framed }">
        <slot name="toolbar" />
        <ScrollFrame v-if="framed"><slot /></ScrollFrame>
        <slot v-else />
      </div>
      <button class="spatial-resize" type="button" :aria-label="resizeLabel ?? 'Resize dialog with arrow keys'" :disabled="maximized"
        @pointerdown="start($event, true)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="arrow($event, true)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 20 12-12M14 20l6-6" /></svg></button>
    </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.spatial-window { container: detail-window / inline-size; padding: 0; max-width: none; max-height: none; position: absolute; display: flex; flex-direction: column; pointer-events: auto; min-width: 0; min-height: 0; background: var(--panel, white); color: var(--ink, #171717); border: 2px solid var(--line, #171717); box-shadow: 6px 6px 0 var(--ink, #171717); overflow: hidden; animation: window-appear var(--motion-panel) var(--motion-ease); }
.spatial-geometry-motion { transition: left var(--motion-panel) var(--motion-ease), top var(--motion-panel) var(--motion-ease), width var(--motion-panel) var(--motion-ease), height var(--motion-panel) var(--motion-ease); }
.window-leave-active { transition: opacity var(--motion-fast) ease, transform var(--motion-panel) var(--motion-ease); pointer-events: none; }
.window-leave-to { opacity: 0; transform: translateY(6px) scale(.985); }
.spatial-titlebar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex: none; box-sizing: border-box; height: 64px; min-height: 64px; max-height: 64px; padding: var(--space-2) var(--space-3); border-bottom: 2px solid var(--line, #171717); background: var(--soft, #eee); touch-action: none; user-select: none; cursor: grab; }
.spatial-titlebar :deep([data-discussion-text]) { user-select: text; -webkit-user-select: text; cursor: text; }
.spatial-heading { flex: 1; min-width: 0; padding-block: var(--space-1); line-height: 1.5; overflow: hidden; }
.spatial-controls { display: flex; flex: none; gap: var(--space-1); }
.spatial-controls button { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: var(--space-2); }
.spatial-controls svg, .spatial-resize svg { display: block; width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.spatial-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; animation: panel-appear var(--motion-panel) var(--motion-ease); }
.spatial-body-framed { display: flex; flex-direction: column; padding: var(--space-4); overflow: hidden; }
.spatial-resize { position: absolute; bottom: 0; right: 0; width: 44px; height: 44px; padding: var(--space-4) var(--space-1) var(--space-1) var(--space-4); background: transparent; border: 0; color: var(--muted, #666); cursor: nwse-resize; touch-action: none; user-select: none; }
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
.detail-dialog { display: flex; flex-direction: column; width: min(620px, 100%); max-height: calc(100vh - 60px); overflow: hidden; border-radius: 0; }
.detail-dialog:focus { outline: none; }
.detail-head-actions { display: flex; align-items: center; gap: var(--space-2); }
.detail-scroll { min-height: 0; overflow: auto; padding: var(--focus-room); }
.status-strip { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-5); }.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }.detail-grid div { display: grid; gap: var(--space-1); }.detail-grid strong { font-size: 1rem; text-transform: capitalize; }.detail-grid small { color: var(--muted); font-size: .8rem; }.source-link { display: inline-block; margin: var(--space-4) 0 var(--space-1); color: var(--blue); font-weight: 700; text-decoration-thickness: 2px; text-underline-offset: 3px; }.detail-section { margin-top: var(--space-5); }.detail-copy { margin-top: var(--space-2); color: var(--ink); white-space: pre-wrap; }.section-heading { justify-content: space-between; align-items: end; }.section-heading h3 { margin-top: var(--space-1); font-size: 1rem; }.document-form { display: grid; gap: var(--space-3); margin-top: var(--space-3); padding: var(--space-3) 0 0; border: 0; }.document-row { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); padding: var(--space-2) 0; border: 0; }.document-icon { width: 30px; height: 30px; display: grid; place-items: center; border: 2px solid var(--line); color: var(--blue); font: 700 .8rem/1 var(--site-font-sans); }.document-row div { display: grid; gap: var(--space-1); flex: 1; }.document-row strong { font-size: .8rem; }.document-row span { color: var(--muted); font: 700 .8rem/1 var(--site-font-sans); }.open-path { color: var(--blue); font: 700 .8rem/1 var(--site-font-sans); }

.spatial-window .spatial-detail { width: 100%; height: 100%; max-height: none; padding: var(--space-4); box-sizing: border-box; }
.spatial-heading .detail-head { margin: 0; align-items: center; flex-wrap: nowrap; gap: var(--space-2); min-width: 0; }
.spatial-heading .detail-head > :first-child { flex: 1; min-width: 0; }
.spatial-heading .detail-head-actions { flex: none; flex-shrink: 0; flex-wrap: nowrap; }
.spatial-heading .detail-head-actions .button { white-space: nowrap; min-width: 44px; }
.spatial-heading .detail-head h2 { margin: 0; font-size: var(--site-font-detail-heading-size, 1.5rem); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spatial-heading > strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spatial-heading .detail-head p { margin: var(--space-1) 0 0; font-size: .85rem; line-height: 1.2; }
.spatial-window .status-strip-shell { min-width: 0; flex: none; margin-bottom: var(--space-2); }
.spatial-window .status-strip { flex: none; flex-wrap: wrap; margin-bottom: 0; padding: var(--space-1) var(--space-1) var(--space-1); }
.spatial-window .status-strip button { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; transition: background-color var(--motion-fast) ease, color var(--motion-fast) ease; }
.detail-actions-row { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: var(--space-4) var(--space-6); min-width: 0; margin-bottom: var(--space-5); }
.detail-stages-row { min-width: 0; }
.detail-stages-row .status-strip-shell { min-width: 0; }
.detail-actions-row .quick-note-form { min-width: 0; }
.detail-configured-fields { min-width: 0; }
.scroll-frame .detail-section:first-child { margin-top: 0; }
@media (max-width: 600px) {
  .spatial-titlebar { padding: var(--space-1) var(--space-2); gap: var(--space-1); }
  .spatial-heading { padding-block: var(--space-1); }
  .spatial-window .spatial-detail, .spatial-body-framed { padding: var(--space-2); }
  .spatial-heading .detail-head-actions .button { min-height: var(--control-size-compact); padding: var(--space-1) var(--space-2); }
  .spatial-heading .detail-head h2 { font-size: var(--site-font-detail-heading-mobile-size, 1.35rem); }
  .spatial-heading .detail-head .eyebrow { display: none; }
}
.spatial-window .spatial-detail > .detail-layout { flex: 1; }
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); min-width: 0; }
.detail-primary { min-width: 0; }
@container detail-window (min-width: 920px) {
  .detail-actions-row { grid-template-columns: minmax(0, 1.55fr) minmax(260px, .75fr); }
}
</style>
