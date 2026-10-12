<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { Board, WorkspaceDocumentV2 } from "../domain/model"

const props = defineProps<{ board: Board; workspaceId: string; document: WorkspaceDocumentV2; sourceVersion: number; owner: boolean }>()
const origin = ((import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined) ?? "").trim()
const open = ref(false)
const checked = ref(false)
const revision = ref(0)
const hash = ref("")
const published = ref(false)
const changed = ref<boolean | null>(null)
const busy = ref(false)
const pendingAction = ref<"publish" | "update" | "unpublish" | null>(null)
const disclosure = "Anyone with the link can read the saved cards, descriptions, fields, board and card discussions with author names, and attached files. Other boards, workspace chat and identity secrets remain private."
const error = ref("")
let operationGeneration = 0
const link = computed(() => `${window.location.origin}/boards/${encodeURIComponent(props.board.id)}`)
const sourceKey = computed(() => `${props.workspaceId}:${props.board.id}`)
async function togglePublication() {
  open.value = !open.value
  if (open.value && !checked.value && !busy.value) await refresh()
}
watch(sourceKey, () => {
  pendingAction.value = null
  operationGeneration++; checked.value = false; changed.value = null; busy.value = false; error.value = ""
  published.value = false; revision.value = 0; hash.value = ""
})
watch(() => props.sourceVersion, () => {
  pendingAction.value = null
  operationGeneration++; checked.value = false; changed.value = null; busy.value = false; error.value = ""
})

async function profile() {
  const { stateRuntime } = await import("../stateContext")
  const current = stateRuntime.currentProfile
  if (!current) throw new Error("Current device identity is unavailable")
  return current
}
async function refresh() {
  const generation = operationGeneration
  const boardId = props.board.id
  busy.value = true
  error.value = ""
  changed.value = null
  try {
    if (!origin) throw new Error("Public board publishing is not configured on this deployment.")
    const { readPublicBoardManagementState } = await import("../public/publicationClient")
    const state = await readPublicBoardManagementState({ origin, boardId, profile: await profile() })
    if (generation !== operationGeneration) return
    revision.value = state.revision
    published.value = state.published
    hash.value = state.hash ?? ""
    checked.value = true
  } catch (cause) {
    if (generation !== operationGeneration) return
    checked.value = false
    error.value = cause instanceof Error ? cause.message : "Keeper publication status unavailable"
  } finally { if (generation === operationGeneration) busy.value = false }
}
async function checkLocalChanges() {
  const generation = operationGeneration
  const source = { document: props.document, workspaceId: props.workspaceId, boardId: props.board.id, hash: hash.value }
  busy.value = true
  error.value = ""
  changed.value = null
  try {
    const { hasLocalPublicBoardChanges } = await import("../public/publicationClient")
    const result = await hasLocalPublicBoardChanges(source)
    if (generation === operationGeneration) changed.value = result
  } catch (cause) { if (generation === operationGeneration) error.value = cause instanceof Error ? cause.message : "Could not compare this board" }
  finally { if (generation === operationGeneration) busy.value = false }
}
async function publish(action: "publish" | "update") {
  const generation = operationGeneration
  const source = { boardId: props.board.id, workspaceId: props.workspaceId, document: props.document }
  busy.value = true
  error.value = ""
  try {
    const { publishBoardSnapshot } = await import("../public/publicationClient")
    const currentProfile = await profile()
    if (generation !== operationGeneration) return
    const result = await publishBoardSnapshot({ origin, ...source, profile: currentProfile, action, expectedRevision: revision.value })
    if (generation !== operationGeneration) return
    revision.value = result.revision
    published.value = true
    changed.value = false
    checked.value = true
    hash.value = result.hash
  } catch (cause) { if (generation === operationGeneration) error.value = cause instanceof Error ? cause.message : "Publication failed" }
  finally { if (generation === operationGeneration) busy.value = false }
}
async function unpublish() {
  const generation = operationGeneration
  const boardId = props.board.id
  busy.value = true
  error.value = ""
  try {
    const { withdrawPublicBoard } = await import("../public/publicationClient")
    const currentProfile = await profile()
    if (generation !== operationGeneration) return
    const result = await withdrawPublicBoard({ origin, boardId, profile: currentProfile, expectedRevision: revision.value })
    if (generation !== operationGeneration) return
    revision.value = result.revision
    published.value = false
    changed.value = null
    checked.value = true
  } catch (cause) { if (generation === operationGeneration) error.value = cause instanceof Error ? cause.message : "Unpublish failed" }
  finally { if (generation === operationGeneration) busy.value = false }
}
async function confirmPublication() {
  const action = pendingAction.value
  if (!action || busy.value) return
  pendingAction.value = null
  if (action === "unpublish") await unpublish()
  else await publish(action)
}
</script>

<template>
  <div v-if="owner" class="public-board-controls">
    <button type="button" class="button button-quiet button-small" :aria-expanded="open" @click="togglePublication">{{ published ? 'Public link' : 'Publish board' }}</button>
    <section v-if="open" class="publication-panel" aria-label="Public board publication">
      <p v-if="busy && !checked" role="status">Checking publication…</p>
      <button v-else-if="!checked" type="button" class="button button-quiet button-small" @click="refresh">{{ error ? 'Retry' : 'Check publication' }}</button>
      <template v-else>
        <p v-if="published">Public revision {{ revision }}<span v-if="changed === true"> · Local content has unpublished changes</span><span v-else-if="changed === false"> · Matched at last check</span></p>
        <p v-else>This board is not public.</p>
        <a v-if="published" :href="link" target="_blank" rel="noopener">Open public board</a>
        <button v-if="!published" type="button" class="button button-quiet button-small" :disabled="busy" @click="pendingAction = 'publish'">{{ busy ? 'Publishing…' : 'Publish' }}</button>
        <button v-if="published" type="button" class="button button-quiet button-small" :disabled="busy" @click="pendingAction = 'update'">{{ busy ? 'Updating…' : 'Update' }}</button>
        <button v-if="published" type="button" class="button button-quiet button-small" :disabled="busy" @click="pendingAction = 'unpublish'">Unpublish</button>
        <button v-if="published && changed === null" type="button" class="button button-quiet button-small" :disabled="busy" @click="checkLocalChanges">{{ busy ? 'Checking…' : 'Check for local changes' }}</button>
        <button type="button" class="button button-quiet button-small" :disabled="busy" @click="refresh">Refresh</button>
      </template>
      <section v-if="pendingAction" class="publication-confirmation" role="group" aria-label="Confirm public board change">
        <p v-if="pendingAction === 'unpublish'">Stop public access to this board and its files? Copies already downloaded cannot be recalled.</p>
        <p v-else>{{ disclosure }}</p>
        <button class="button button-primary button-small" type="button" @click="confirmPublication">{{ pendingAction === 'unpublish' ? 'Confirm withdrawal' : 'Confirm publication' }}</button>
        <button class="button button-quiet button-small" type="button" @click="pendingAction = null">Cancel</button>
      </section>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.publication-confirmation { flex-basis: 100%; display: grid; gap: 10px; }
.public-board-controls{display:grid;gap:12px}.public-board-controls>button{justify-self:start}.publication-panel{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 0;border-top:1px solid var(--soft);overflow-wrap:anywhere}.publication-panel p{flex-basis:100%;margin:0}.publication-panel a{color:var(--link,#245f9e)}
</style>
