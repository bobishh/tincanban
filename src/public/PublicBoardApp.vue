<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ZodError } from "zod"
import { validatePublicBoardProjection, type PublicBoardProjection } from "./publicSchema"
import { PublicBoardRequestTimeoutError, publicSnapshotDecision, readWithTimeout } from "./publicBoardReader"
import PublicBoardContent from "./PublicBoardContent.vue"
import { recordPublicBoardView } from "./publicAnalytics"

const props = defineProps<{ boardId: string; boardSlug?: string; canonicalizeBoardRoute?: (title: string) => void; origin: string }>()
const emit = defineEmits<{ availability: [readable: boolean | null] }>()
const state = ref<"loading" | "ready" | "unavailable" | "malformed" | "error">("loading")
watch(state, value => emit("availability", value === "loading" ? null : value === "ready"), { immediate: true })
const projection = ref<PublicBoardProjection | null>(null)
const revision = ref(0)
const errorText = ref("")
const refreshError = ref("")
let activeRequest: AbortController | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let requestGeneration = 0
let loadedOnce = false
let recordedView = false

async function readPublicSnapshot(boardId: string, signal: AbortSignal): Promise<{ projection: PublicBoardProjection; revision: number } | null> {
  const response = await fetch(`${props.origin}/v1/public/boards/${encodeURIComponent(boardId)}`, { cache: "no-store", credentials: "omit", signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Public service returned ${response.status}`)
  const value: unknown = await response.json()
  if (!isPublicationEnvelope(value)) throw new Error("Invalid publication envelope")
  const checked = validatePublicBoardProjection(value.projection)
  if (checked.board.id !== boardId) throw new Error("Publication board ID does not match its URL")
  return { projection: checked, revision: value.revision }
}
function isPublicationEnvelope(value: unknown): value is { projection: unknown; revision: number } {
  return !!value && typeof value === "object" && "projection" in value && "revision" in value && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision > 0
}
function setReadError(error: unknown) {
  const text = error instanceof Error ? error.message : "Unknown public board error"
  if (error instanceof ZodError || error instanceof Error && /Invalid publication envelope|does not match|Public board exceeds/i.test(text)) {
    state.value = "malformed"
    errorText.value = "This publication could not be validated."
  } else {
    state.value = "error"
    errorText.value = "Public board service is unavailable. Try again."
  }
}
function applySnapshot(result: Awaited<ReturnType<typeof readPublicSnapshot>>, boardId: string) {
  loadedOnce = true
  if (!result) {
    projection.value = null
    revision.value = 0
    state.value = "unavailable"
    refreshError.value = ""
    return
  }
  const decision = publicSnapshotDecision(projection.value ? { boardId, revision: revision.value } : null,
    { boardId: result.projection.board.id, revision: result.revision })
  if (decision === "rollback" || decision === "different-board") {
    refreshError.value = "Public board returned an older version. Showing the last confirmed view. Try again."
    state.value = "ready"
    return
  }
  if (decision === "unchanged") {
    state.value = "ready"
    refreshError.value = ""
    return
  }
  projection.value = result.projection
  revision.value = result.revision
  state.value = "ready"
  refreshError.value = ""
  props.canonicalizeBoardRoute?.(result.projection.board.title)
  if (!recordedView) { recordPublicBoardView(boardId); recordedView = true }
}
function applyRefreshError(error: unknown) {
  if (projection.value) refreshError.value = "Public board could not refresh. Showing the last confirmed view. Try again."
  else setReadError(error)
}
async function refresh() {
  if (activeRequest) return
  const currentGeneration = requestGeneration
  const requestedBoardId = props.boardId
  const controller = new AbortController()
  activeRequest = controller
  const firstRead = !loadedOnce
  if (firstRead) state.value = "loading"
  refreshError.value = ""
  errorText.value = ""
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestedBoardId)) { state.value = "malformed"; errorText.value = "This board link is invalid."; activeRequest = undefined; return }
  if (!props.origin) { state.value = "malformed"; errorText.value = "Ask the board owner for its public link, including the Rusty address."; activeRequest = undefined; return }
  try {
    const result = await readWithTimeout(signal => readPublicSnapshot(requestedBoardId, signal), controller)
    if (controller.signal.aborted || currentGeneration !== requestGeneration) return
    applySnapshot(result, requestedBoardId)
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof PublicBoardRequestTimeoutError) || currentGeneration !== requestGeneration) return
    applyRefreshError(error)
  } finally {
    // Abort the losing timeout timer or network request once either side settles.
    controller.abort()
    if (activeRequest === controller) activeRequest = undefined
  }
}
function fileUrl(sha256: string) { return `${props.origin}/v1/public/boards/${encodeURIComponent(props.boardId)}/files/${revision.value}/${sha256}` }
function onVisible() { if (document.visibilityState !== "hidden") void refresh() }
function startReader() {
  requestGeneration++
  const previousRequest = activeRequest
  activeRequest = undefined
  previousRequest?.abort()
  projection.value = null
  revision.value = 0
  state.value = "loading"
  errorText.value = ""
  refreshError.value = ""
  loadedOnce = false
  recordedView = false
  void refresh()
}
onMounted(() => {
  startReader()
  if (props.origin) pollTimer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh() }, 5000)
  window.addEventListener("focus", onVisible)
  window.addEventListener("online", onVisible)
})
watch(() => [props.boardId, props.origin], startReader)
onBeforeUnmount(() => {
  requestGeneration++
  activeRequest?.abort()
  if (pollTimer) clearInterval(pollTimer)
  window.removeEventListener("focus", onVisible)
  window.removeEventListener("online", onVisible)
})
</script>

<template>
  <p v-if="state === 'loading'" class="board-state" role="status">Loading board…</p>
  <section v-else-if="state !== 'ready'" class="board-state ui-stack" role="alert">
    <h1>{{ state === 'unavailable' ? 'Board unavailable' : state === 'malformed' ? 'Publication invalid' : 'Could not load board' }}</h1>
    <p>{{ state === 'unavailable' ? 'This link cannot open the board. Ask its owner for an invitation or a new link.' : errorText }}</p>
    <button v-if="origin" class="button button-small" type="button" @click="refresh">Try again</button>
  </section>
  <template v-else-if="projection">
    <p v-if="refreshError" class="board-refresh-error" role="status">{{ refreshError }} <button class="button button-small" type="button" @click="refresh">Retry</button></p>
    <PublicBoardContent :projection="projection" :file-url="fileUrl" />
  </template>
</template>
<style scoped>
.board-state { max-width: 600px; margin: 10vh auto; padding: var(--space-4); text-align: center; }
.board-refresh-error { display: flex; align-items: center; justify-content: center; gap: var(--space-3); margin: 0; padding: var(--space-2) var(--space-3); color: var(--red); font-weight: 400; font-size: var(--site-font-secondary-size, 14px); line-height: var(--site-font-reading-line, 1.65); font-family: var(--site-font-reading); }
</style>
