<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import ModalLayer from "./ModalLayer.vue"
import { avatarCropRect, AVATAR_MAX_ZOOM, AVATAR_SIZE, encodeAvatarCrop, validateImageSize } from "../avatarCrop"

const PREVIEW_SIZE = AVATAR_SIZE * 2
const props = defineProps<{ sourceUrl: string }>()
const emit = defineEmits<{ save: [avatarData: string]; cancel: [] }>()
const image = ref<HTMLImageElement | null>(null)
const loaded = ref(false)
const width = ref(0)
const height = ref(0)
const zoom = ref(1)
const centerX = ref(0)
const centerY = ref(0)
const saving = ref(false)
const error = ref("")
const frame = ref<HTMLElement | null>(null)
const frameSize = ref(PREVIEW_SIZE)
const drag = ref<{ pointerId: number; x: number; y: number; centerX: number; centerY: number } | null>(null)
const crop = computed(() => loaded.value ? avatarCropRect(width.value, height.value, zoom.value, centerX.value, centerY.value) : null)
const previewScale = computed(() => crop.value ? frameSize.value / crop.value.size : 1)
const previewStyle = computed(() => crop.value ? {
  width: `${width.value * previewScale.value}px`,
  height: `${height.value * previewScale.value}px`,
  left: `${-crop.value.x * previewScale.value}px`,
  top: `${-crop.value.y * previewScale.value}px`,
} : {})

watch(() => props.sourceUrl, () => {
  loaded.value = false
  width.value = 0
  height.value = 0
  centerX.value = 0
  centerY.value = 0
  zoom.value = 1
  saving.value = false
  error.value = ""
  drag.value = null
}, { immediate: true })

let frameObserver: ResizeObserver | undefined
watch(frame, element => {
  frameObserver?.disconnect()
  if (!element) return
  frameObserver = new ResizeObserver(entries => {
    const measured = entries[0]?.contentRect.width
    if (measured && measured > 0) frameSize.value = measured
  })
  frameObserver.observe(element)
}, { flush: "post" })
onBeforeUnmount(() => frameObserver?.disconnect())

function imageLoaded() {
  const source = image.value
  if (!source) return
  try {
    validateImageSize(source.naturalWidth, source.naturalHeight)
    width.value = source.naturalWidth
    height.value = source.naturalHeight
    centerX.value = source.naturalWidth / 2
    centerY.value = source.naturalHeight / 2
    loaded.value = true
    error.value = ""
  } catch (cause) {
    imageFailed(cause)
  }
}

function imageFailed(cause?: unknown) {
  loaded.value = false
  error.value = cause instanceof Error ? cause.message : "Photo could not be decoded. Choose a PNG, JPEG, or WebP image."
}

function beginPan(event: PointerEvent) {
  if (!loaded.value || saving.value || !crop.value) return
  event.preventDefault()
  frame.value?.setPointerCapture(event.pointerId)
  drag.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, centerX: centerX.value, centerY: centerY.value }
}

function pan(event: PointerEvent) {
  const start = drag.value
  const currentCrop = crop.value
  if (!start || start.pointerId !== event.pointerId || !currentCrop) return
  event.preventDefault()
  const scale = frameSize.value / currentCrop.size
  updateCenter(start.centerX - (event.clientX - start.x) / scale, start.centerY - (event.clientY - start.y) / scale)
}

function endPan(event: PointerEvent) {
  if (drag.value?.pointerId !== event.pointerId) return
  if (frame.value?.hasPointerCapture(event.pointerId)) frame.value.releasePointerCapture(event.pointerId)
  drag.value = null
}

function setZoom(event: Event) {
  const nextZoom = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(nextZoom) || !width.value || !height.value || !crop.value) return
  const old = crop.value
  const nextSize = Math.min(width.value, height.value) / nextZoom
  centerX.value = old.x + old.size / 2
  centerY.value = old.y + old.size / 2
  zoom.value = Math.min(AVATAR_MAX_ZOOM, Math.max(1, nextZoom))
  centerX.value = Math.min(width.value - nextSize / 2, Math.max(nextSize / 2, centerX.value))
  centerY.value = Math.min(height.value - nextSize / 2, Math.max(nextSize / 2, centerY.value))
}

function panWithKeyboard(event: KeyboardEvent) {
  if (!crop.value) return
  const step = crop.value.size / PREVIEW_SIZE * (event.shiftKey ? 24 : 6)
  if (event.key === "ArrowLeft") updateCenter(centerX.value - step, centerY.value)
  else if (event.key === "ArrowRight") updateCenter(centerX.value + step, centerY.value)
  else if (event.key === "ArrowUp") updateCenter(centerX.value, centerY.value - step)
  else if (event.key === "ArrowDown") updateCenter(centerX.value, centerY.value + step)
  else if (event.key === "Home") { centerX.value = width.value / 2; centerY.value = height.value / 2 }
  else return
  event.preventDefault()
}

function updateCenter(nextX: number, nextY: number) {
  if (!width.value || !height.value) return
  const bounded = avatarCropRect(width.value, height.value, zoom.value, nextX, nextY)
  centerX.value = bounded.x + bounded.size / 2
  centerY.value = bounded.y + bounded.size / 2
}

function resetCrop() {
  zoom.value = 1
  centerX.value = width.value / 2
  centerY.value = height.value / 2
  error.value = ""
}

async function saveCrop() {
  const source = image.value
  const current = crop.value
  if (!source || !current || saving.value) return
  saving.value = true
  error.value = ""
  try {
    emit("save", await encodeAvatarCrop(source, current))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Photo crop could not be saved"
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalLayer class="overlay-level-120" :busy="saving" :protect-draft="true" @close="emit('cancel')">
    <section class="dialog avatar-crop-dialog" role="dialog" aria-modal="true" aria-label="Crop profile photo" :aria-busy="saving">
      <div class="dialog-head"><div><span class="eyebrow">Profile photo</span><h2>Choose a crop</h2></div><button class="icon-button" type="button" aria-label="Cancel photo crop" :disabled="saving" @click="emit('cancel')">×</button></div>
      <p id="avatar-crop-help" class="dialog-copy">Drag the photo to position it. Use arrow keys after focusing the crop area. Saved photo is a 128 × 128 square.</p>
      <div class="avatar-crop-controls">
        <div ref="frame" class="avatar-crop-frame" role="group" aria-label="Photo crop position" aria-describedby="avatar-crop-help" tabindex="0"
          @pointerdown="beginPan" @pointermove="pan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan" @keydown="panWithKeyboard">
          <img ref="image" class="avatar-crop-image" :src="sourceUrl" alt="" draggable="false" :style="previewStyle" @load="imageLoaded" @error="imageFailed()" />
          <span v-if="!loaded && !error" class="avatar-crop-loading">Loading photo…</span>
        </div>
        <label class="avatar-crop-zoom">Zoom
          <input type="range" min="1" :max="AVATAR_MAX_ZOOM" step="0.05" :value="zoom" :disabled="!loaded || saving" aria-label="Photo zoom" @input="setZoom" />
        </label>
        <button class="button" type="button" :disabled="!loaded || saving" @click="resetCrop">Reset crop</button>
      </div>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
      <p v-if="saving" class="dialog-copy" role="status">Preparing photo…</p>
      <div class="dialog-actions"><button class="button" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button><button class="button button-primary" type="button" :disabled="!loaded || saving" @click="saveCrop">Use photo</button></div>
    </section>
  </ModalLayer>
</template>

<style scoped>
.avatar-crop-dialog { width: min(520px, calc(100vw - 24px)); }
.avatar-crop-controls { display: grid; justify-items: center; gap: 16px; }
.avatar-crop-frame { position: relative; box-sizing: border-box; width: 256px; max-width: 76vw; aspect-ratio: 1; overflow: hidden; border: 2px solid var(--ink); border-radius: 50%; background: var(--panel); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.avatar-crop-frame:active { cursor: grabbing; }
.avatar-crop-frame:focus-visible { outline: 3px solid var(--yellow); outline-offset: 4px; }
.avatar-crop-image { position: absolute; max-width: none; max-height: none; user-select: none; -webkit-user-drag: none; -webkit-user-select: none; pointer-events: none; }
.avatar-crop-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font: 700 .8rem var(--site-font-sans); }
.avatar-crop-zoom { display: grid; width: min(320px, 100%); gap: 8px; font: 700 .8rem var(--site-font-sans); }
.avatar-crop-zoom input { width: 100%; accent-color: var(--ink); }
.avatar-crop-dialog .dialog-actions { display: flex; justify-content: end; gap: 10px; margin-top: 22px; }
.avatar-crop-dialog button:disabled { cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) { .avatar-crop-dialog * { scroll-behavior: auto; } }
</style>
