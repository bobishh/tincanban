<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import type { Board, WorkspaceDocumentV2 } from "../domain/model"

const props = defineProps<{ board: Board; workspaceId: string; document: WorkspaceDocumentV2; sourceVersion: number; owner: boolean }>()
const origin = ((import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined) ?? "").trim()
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
function requestVisibility(event: Event) {
  const input = event.target as HTMLInputElement
  pendingAction.value = input.checked ? "publish" : "unpublish"
  input.checked = published.value
}
onMounted(() => { if (props.owner) void refresh() })
watch(sourceKey, () => {
  pendingAction.value = null
  operationGeneration++; checked.value = false; changed.value = null; busy.value = false; error.value = ""
  published.value = false; revision.value = 0; hash.value = ""
  if (props.owner) void refresh()
})
watch(() => props.sourceVersion, () => {
  pendingAction.value = null
  operationGeneration++; checked.value = false; changed.value = null; busy.value = false; error.value = ""
  if (props.owner) void refresh()
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
  <section v-if="owner" class="publication-panel" aria-label="Public board publication" :data-public-revision="revision">
    <label class="publication-toggle"><input type="checkbox" role="switch" :checked="published" :disabled="busy || !checked || !!pendingAction" @change="requestVisibility" />Public board</label>
    <p v-if="busy" role="status">{{ checked ? 'Saving public board…' : 'Checking publication…' }}</p>
    <template v-else-if="checked">
      <p v-if="published" role="status">Public · Saved copy available to anyone with the link.</p>
      <p v-else role="status">Private · Access requires an invitation.</p>
    </template>
    <p v-else class="dialog-copy">Publication status unavailable. Retry to check this board.</p>
    <template v-if="checked && published">
      <a :href="link" target="_blank" rel="noopener">Open public board</a>
      <p class="dialog-copy">Edits stay private until you update the public copy.<span v-if="changed === true"> There are unpublished changes.</span><span v-else-if="changed === false"> Copy matched at last check.</span></p>
      <div class="publication-actions">
        <button type="button" class="button button-quiet button-small" :disabled="busy || !!pendingAction" @click="pendingAction = 'update'">Update public copy</button>
        <button v-if="changed === null" type="button" class="button button-quiet button-small" :disabled="busy" @click="checkLocalChanges">Check for local changes</button>
      </div>
    </template>
    <section v-if="pendingAction" class="publication-confirmation" role="group" aria-label="Confirm public board change">
      <p v-if="pendingAction === 'unpublish'">Stop public access to this board and its files? Copies already downloaded cannot be recalled.</p>
      <p v-else>{{ disclosure }}</p>
      <div class="publication-actions">
        <button class="button button-primary button-small" type="button" @click="confirmPublication">{{ pendingAction === 'unpublish' ? 'Confirm withdrawal' : 'Confirm publication' }}</button>
        <button class="button button-quiet button-small" type="button" @click="pendingAction = null">Cancel</button>
      </div>
    </section>
    <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    <button v-if="!checked && !busy" type="button" class="button button-quiet button-small" @click="refresh">Retry publication status</button>
    <button v-else-if="checked" type="button" class="button button-quiet button-small" :disabled="busy || !!pendingAction" @click="refresh">Refresh publication status</button>
  </section>
  <p v-else class="dialog-copy">Only the board owner can change public access.</p>
</template>

<style scoped>
.publication-panel { display: grid; gap: 10px; overflow-wrap: anywhere; }
.publication-panel p { margin: 0; }
.publication-toggle { display: flex; align-items: center; gap: 8px; font-weight: 700; }
.publication-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.publication-confirmation { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); }
.publication-panel a { color: var(--link, #245f9e); }
.publication-panel > button { justify-self: start; }
</style>
