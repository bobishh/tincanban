<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { ZodError } from "zod"
import { validatePublicBoardProjection, type PublicBoardProjection } from "./publicSchema"
import { MarkdownContent } from "../ui/markdownContent"
import ModalLayer from "../components/ModalLayer.vue"
import { recordPublicBoardView } from "./publicAnalytics"

const props = defineProps<{ boardId: string }>()
const origin = (import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined)?.replace(/\/$/, "") ?? ""
const state = ref<"loading" | "ready" | "unavailable" | "malformed" | "error">("loading")
const projection = ref<PublicBoardProjection | null>(null)
const revision = ref(0)
const query = ref("")
const selectedCard = ref<string | null>(null)
const errorText = ref("")
const visibleCards = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return (projection.value?.cards ?? []).filter(card => !needle || `${card.title}\n${card.body}\n${Object.entries(card.values).map(([fieldId, value]) => fieldValue(fieldId, value)).join(" ")}`.toLocaleLowerCase().includes(needle))
})
const currentCard = computed(() => projection.value?.cards.find(card => card.id === selectedCard.value) ?? null)
const discussionsForCard = computed(() => groupThreads(projection.value?.discussions.filter(message => message.targets.some(target => target.type === "card" && target.id === selectedCard.value || target.cardId === selectedCard.value)) ?? []))
const boardDiscussions = computed(() => groupThreads(projection.value?.discussions.filter(message => message.targets.some(target => target.type === "board")) ?? []))
function groupThreads(messages: PublicBoardProjection["discussions"]) {
  const groups = new Map<string, typeof messages>()
  for (const message of messages) {
    const thread = groups.get(message.threadId) ?? []
    thread.push(message)
    groups.set(message.threadId, thread)
  }
  return [...groups.values()]
}
function fieldValue(fieldId: string, value: string | number | boolean | null) {
  if (value === null) return ""
  const field = projection.value?.fields.find(candidate => candidate.id === fieldId)
  return field?.valueType === "select" ? field.options.find(option => option.id === value)?.title ?? "" : String(value)
}

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
function openCard(id: string, event: MouseEvent) {
  (event.currentTarget as HTMLButtonElement).focus()
  selectedCard.value = id
}
function messageTime(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) }
onMounted(load)
</script>

<template>
  <main class="public-board">
    <p v-if="state === 'loading'" role="status">Loading public board…</p>
    <section v-else-if="state !== 'ready'" class="public-state" role="alert">
      <h1>{{ state === 'unavailable' ? 'Board unavailable' : state === 'malformed' ? 'Publication invalid' : 'Could not load board' }}</h1>
      <p>{{ state === 'unavailable' ? 'This board is unpublished or no longer available.' : errorText }}</p>
      <button type="button" @click="load">Try again</button>
    </section>
    <template v-else-if="projection">
      <header class="public-header"><div><p class="public-eyebrow">Public board</p><h1>{{ projection.board.title }}</h1></div><label>Search cards<input v-model="query" type="search" autocomplete="off" /></label></header>
      <div class="public-columns">
        <section v-for="column in projection.columns" :key="column.id" class="public-column">
          <h2>{{ column.title }}</h2>
          <p v-if="!visibleCards.some(card => card.columnId === column.id)" class="public-empty">No matching cards</p>
          <article v-for="card in visibleCards.filter(card => card.columnId === column.id)" :key="card.id" class="public-card" :class="{ 'public-card-child': card.parentId }">
            <h3>{{ card.title }}</h3><MarkdownContent v-if="card.body" class="public-card-body" :source="card.body" compact />
            <dl v-if="Object.keys(card.values).length"><template v-for="field in projection.fields.filter(field => card.values[field.id] != null)" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ fieldValue(field.id, card.values[field.id]) }}</dd></template></dl>
            <button type="button" @click="openCard(card.id, $event)">Read card</button>
          </article>
        </section>
      </div>
      <section v-if="boardDiscussions.length" class="public-discussions public-board-discussions"><h2>Board discussion</h2><section v-for="thread in boardDiscussions" :key="thread[0]?.threadId" class="public-thread"><article v-for="message in thread" :key="message.id" :class="{ 'public-reply': message.replyTo }"><p><strong>{{ message.author }}</strong><time :datetime="message.createdAt">{{ messageTime(message.createdAt) }}</time></p><MarkdownContent :source="message.body" /></article></section></section>
      <section v-if="projection.files.length" class="public-files"><h2>Attachments</h2><ul><li v-for="file in projection.files" :key="file.id"><a :href="fileUrl(file.sha256)" :download="file.fileName">{{ file.title }} — {{ file.fileName }}</a></li></ul></section>
      <ModalLayer v-if="currentCard" class="public-dialog-backdrop" @close="selectedCard = null">
        <section class="public-dialog" role="dialog" aria-modal="true" :aria-label="currentCard.title"><button class="public-close" type="button" @click="selectedCard = null">Close</button><h2>{{ currentCard.title }}</h2><MarkdownContent :source="currentCard.body" />
          <section v-if="discussionsForCard.length" class="public-discussions"><h3>Discussion</h3><section v-for="thread in discussionsForCard" :key="thread[0]?.threadId" class="public-thread"><article v-for="message in thread" :key="message.id" :class="{ 'public-reply': message.replyTo }"><p><strong>{{ message.author }}</strong><time :datetime="message.createdAt">{{ messageTime(message.createdAt) }}</time></p><MarkdownContent :source="message.body" /></article></section></section>
        </section>
      </ModalLayer>
    </template>
  </main>
</template>

<style scoped>
.public-card-body { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.public-board{max-width:1440px;min-height:100vh;margin:auto;padding:clamp(16px,4vw,48px);background:var(--paper);color:var(--ink);font-family:var(--site-font-sans)}
.public-header{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:28px}.public-eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}.public-header h1{font-size:clamp(1.8rem,5vw,3rem);margin:.25em 0}.public-header label{display:grid;gap:6px}.public-header input{min-width:220px;padding:10px;border:2px solid var(--line);border-radius:0;background:var(--panel);color:var(--ink)}
.public-columns{display:flex;gap:20px;align-items:stretch;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:20px}.public-column{position:relative;flex:1 0 250px;min-width:250px;min-height:220px;padding:14px;border:2px solid var(--line);overflow:hidden;background:var(--panel)}.public-column::before{position:absolute;inset:0;content:"";background:var(--yellow);mask:url("/assets/column-hatch.svg?v=1") repeat;mask-size:64px 64px;opacity:.14;pointer-events:none}.public-column h2{position:relative;font-size:1.1rem}.public-empty{position:relative;color:var(--muted)}
.public-card{position:relative;padding:14px;margin:12px 0;border:2px solid var(--line);background:var(--panel);overflow-wrap:anywhere}.public-card-child{margin-left:14px;border-left:6px solid var(--yellow)}.public-card h3{margin-top:0}.public-card dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px}.public-card dt{font-weight:700}.public-card dd{margin:0}.public-card button,.public-state button,.public-close{min-height:40px;padding:8px 12px;border:2px solid var(--line);border-radius:0;background:var(--paper);color:var(--ink);font:700 .8rem/1.2 var(--site-font-sans);cursor:pointer}
.public-state{max-width:600px;margin:10vh auto;text-align:center}.public-dialog-backdrop{position:fixed;inset:0;z-index:40;background:#171717aa;display:grid;place-items:center;padding:16px}.public-dialog{width:min(720px,100%);max-height:90vh;overflow:auto;padding:24px;border:3px solid var(--line);background:var(--panel)}.public-close{float:right}.public-discussions article{border-top:2px solid var(--line);padding:8px 0}.public-discussions .public-reply{margin-left:24px}.public-discussions time{margin-left:12px;font-size:.8rem;color:var(--muted)}
@media(max-width:600px){.public-header{display:block}.public-header label{margin-top:18px}.public-header input{width:100%;box-sizing:border-box}.public-column{flex-basis:min(82vw,300px);min-width:min(82vw,300px)}}
</style>
