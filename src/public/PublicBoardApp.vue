<script setup lang="ts">
import { onMounted, ref } from "vue"
import { ZodError } from "zod"
import { validatePublicBoardProjection, type PublicBoardProjection } from "./publicSchema"
import PublicBoardContent from "./PublicBoardContent.vue"
import { recordPublicBoardView } from "./publicAnalytics"

const props = defineProps<{ boardId: string }>()
const origin = (import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined)?.replace(/\/$/, "") ?? ""
const state = ref<"loading" | "ready" | "unavailable" | "malformed" | "error">("loading")
const projection = ref<PublicBoardProjection | null>(null)
const revision = ref(0)
const errorText = ref("")

async function readPublicSnapshot(): Promise<{ projection: PublicBoardProjection; revision: number } | null> {
  const response = await fetch(`${origin}/v1/public/boards/${encodeURIComponent(props.boardId)}`, { cache: "no-store" })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Public service returned ${response.status}`)
  const value: unknown = await response.json()
  if (!isPublicationEnvelope(value)) throw new Error("Invalid publication envelope")
  const checked = validatePublicBoardProjection(value.projection)
  if (checked.board.id !== props.boardId) throw new Error("Publication board ID does not match its URL")
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
async function load() {
  projection.value = null
  state.value = "loading"
  errorText.value = ""
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(props.boardId)) { state.value = "malformed"; errorText.value = "This board link is invalid."; return }
  if (!origin) { state.value = "error"; errorText.value = "Public board service is not configured."; return }
  try {
    const result = await readPublicSnapshot()
    if (!result) { state.value = "unavailable"; return }
    projection.value = result.projection
    revision.value = result.revision
    state.value = "ready"
    recordPublicBoardView(props.boardId)
  } catch (error) { setReadError(error) }
}
function fileUrl(sha256: string) { return `${origin}/v1/public/boards/${encodeURIComponent(props.boardId)}/files/${revision.value}/${sha256}` }
onMounted(load)
</script>

<template>
  <p v-if="state === 'loading'" class="board-state" role="status">Loading board…</p>
  <section v-else-if="state !== 'ready'" class="board-state ui-stack" role="alert">
    <h1>{{ state === 'unavailable' ? 'Board unavailable' : state === 'malformed' ? 'Publication invalid' : 'Could not load board' }}</h1>
    <p>{{ state === 'unavailable' ? 'This board is unpublished or no longer available.' : errorText }}</p>
    <button class="button button-small" type="button" @click="load">Try again</button>
  </section>
  <PublicBoardContent v-else-if="projection" :projection="projection" :file-url="fileUrl" />
</template>
<style scoped>
.board-state { max-width: 600px; margin: 10vh auto; padding: var(--space-4); text-align: center; }
</style>
