<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { useAppPublicBoards } from "../app/useAppPublicBoards"

const props = defineProps<{ access: ReturnType<typeof useAppPublicBoards>["publicAccess"] }>()
const emit = defineEmits<{ connect: [] }>()
const selecting = ref(false)
const pendingVisibility = ref<boolean | null>(null)
const actionError = ref("")
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  watch(() => props.access.busy.value, busy => {
    if (clock) clearInterval(clock)
    clock = undefined
    now.value = Date.now()
    if (busy) clock = setInterval(() => { now.value = Date.now() }, 1000)
  }, { immediate: true })
})
onBeforeUnmount(() => { if (clock) clearInterval(clock) })
const elapsed = computed(() => Math.max(0, Math.floor((now.value - (props.access.progress.value?.startedAt ?? now.value)) / 1000)))
const progressLabel = computed(() => {
  const progress = props.access.progress.value
  if (!progress) return ""
  if (progress.phase === "uploading") return `Uploading files: ${progress.completedFiles ?? 0} of ${progress.totalFiles ?? 0}`
  return { checking: "Checking access on Rusty", connecting: "Connecting to Rusty", preparing: "Preparing board and attached files",
    saving: "Waiting for Rusty to confirm publication", withdrawing: "Waiting for Rusty to disable public access" }[progress.phase]
})
const confirmedTime = computed(() => props.access.lastConfirmedAt.value === null ? "" : new Date(props.access.lastConfirmedAt.value).toLocaleTimeString())
const deliveryLabel = computed(() => {
  const delivery = props.access.lastDelivery.value
  return delivery ? `Last update confirmed at ${new Date(delivery.at).toLocaleTimeString()} · ${(delivery.durationMs / 1000).toFixed(1)}s to publish` : ""
})
const disclosure = "Anyone with this link can read the board’s visitor-visible cards, descriptions, fields, discussions, and attached files. Other boards, workspace chat, and identity secrets stay private."
function requestVisibility() {
  if (!props.access.checked.value || pendingVisibility.value !== null) return
  pendingVisibility.value = !props.access.published.value
}
async function confirmVisibility() {
  const enabled = pendingVisibility.value
  if (enabled === null || props.access.busy.value) return
  pendingVisibility.value = null
  actionError.value = ""
  try { await props.access.setPublic(enabled) }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : "Could not change public access" }
}
async function selectServer(event: Event) {
  selecting.value = true
  actionError.value = ""
  try { await props.access.selectOrigin((event.target as HTMLSelectElement).value) }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : "Could not select Rusty" }
  finally { selecting.value = false }
}
watch(() => props.access.checked.value, checked => { if (!checked) { pendingVisibility.value = null; actionError.value = "" } })
async function retry() {
  if (props.access.checked.value && props.access.published.value) await props.access.retry()
  else await props.access.refresh()
}
</script>

<template>
  <section v-if="access.owner.value" class="publication-panel" aria-label="Public board access" :aria-busy="access.busy.value" :data-public-revision="access.revision.value" :data-public-sync-pending="access.syncPending.value">
    <label class="publication-toggle"><input type="checkbox" role="switch" :checked="access.published.value" :disabled="!access.checked.value || access.busy.value || selecting || pendingVisibility !== null || !access.published.value && !access.connected.value" @click.prevent="requestVisibility" />Public board</label>
    <label v-if="access.origins.value.length > 1" class="publication-server">Publication server
      <select :value="access.origin.value" :disabled="selecting || access.busy.value || access.published.value || Boolean(access.origin.value) && !access.privateConfirmed.value" @change="selectServer">
        <option v-if="!access.origin.value" value="" disabled>Choose Rusty</option>
        <option v-for="origin in access.origins.value" :key="origin" :value="origin">{{ origin }}</option>
      </select>
    </label>
    <div class="publication-status">
      <p v-if="!access.origin.value" class="dialog-copy">{{ access.origins.value.length > 1 ? 'Choose a connected Rusty to publish this board.' : 'Connect Rusty to this board to enable public access.' }}</p>
      <template v-else-if="access.checked.value">
        <p v-if="access.published.value" role="status">{{ access.connected.value ? 'Public · Changes sync automatically.' : 'Public · Updates paused.' }}</p>
        <p v-else-if="access.busy.value && access.progress.value?.phase !== 'checking'" role="status">Publication awaiting confirmation.</p>
        <p v-else role="status">{{ access.privateConfirmed.value ? 'Private · Access requires an invitation.' : 'Public · Withdrawal pending.' }}</p>
      </template>
      <p v-else-if="access.busy.value" role="status">Public access not yet confirmed.</p>
      <p v-else class="dialog-copy">Public access status is unavailable. Retry to check this board.</p>
      <p v-if="deliveryLabel" class="publication-detail">{{ deliveryLabel }}</p>
      <p v-else-if="confirmedTime" class="publication-detail">Access checked at {{ confirmedTime }}</p>
    </div>
    <div class="publication-progress" aria-live="polite" :aria-busy="access.busy.value">
      <template v-if="access.busy.value && progressLabel">
        <p>{{ progressLabel }}… <span>{{ elapsed }}s elapsed</span></p>
        <progress v-if="access.progress.value?.phase === 'uploading'" :value="access.progress.value.completedFiles" :max="access.progress.value.totalFiles" aria-label="Files uploaded" />
        <p v-else-if="elapsed >= 15" class="publication-detail">This step is taking longer than usual. Keep this tab open.</p>
      </template>
    </div>
    <template v-if="!access.connected.value">
      <p v-if="access.origin.value" class="dialog-copy">{{ access.published.value ? 'The last published copy is still public. Reconnect this board to its Rusty to sync changes, or disable public access.' : 'Reconnect this board to its Rusty before publishing.' }}</p>
      <button v-if="access.origins.value.length < 2" type="button" class="button button-quiet button-small" @click="emit('connect')">Open Sync</button>
    </template>
    <div class="publication-link"><a v-if="access.published.value && access.link.value" :href="access.link.value" target="_blank" rel="noopener">Open public board</a></div>
    <section v-if="pendingVisibility !== null" class="publication-confirmation" role="group" aria-label="Confirm public board change">
      <p v-if="pendingVisibility">{{ disclosure }}</p>
      <p v-else>Stop public access to this board and its files? Copies already downloaded cannot be recalled.</p>
      <div class="publication-actions">
        <button class="button button-primary button-small" type="button" :disabled="access.busy.value" @click="confirmVisibility">{{ pendingVisibility ? 'Enable public access' : 'Disable public access' }}</button>
        <button class="button button-quiet button-small" type="button" @click="pendingVisibility = null">Cancel</button>
      </div>
    </section>
    <p v-if="access.error.value" class="sync-error reading-explanation" role="alert">{{ access.error.value }}</p>
    <p v-if="actionError" class="sync-error reading-explanation" role="alert">{{ actionError }}</p>
    <button v-if="access.error.value && !access.busy.value" type="button" class="button button-quiet button-small" @click="retry">Retry</button>
  </section>
  <p v-else class="dialog-copy">Only the board owner can change public access.</p>
</template>

<style scoped>
.publication-panel { display: grid; gap: var(--space-2); overflow-wrap: anywhere; }
.publication-status { min-block-size: 2lh; }
.publication-progress { min-block-size: 3lh; }
.publication-progress progress { inline-size: 100%; }
.publication-detail { color: var(--muted); font-size: 0.875em; }
.publication-link { min-block-size: 1.5lh; }
.publication-server { display: grid; gap: var(--space-1); }
.publication-panel p { margin: 0; }
.publication-toggle { display: flex; align-items: center; gap: var(--space-2); font-weight: 700; }
.publication-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.publication-confirmation { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--line); }
.publication-panel a { color: var(--link, #245f9e); }
.publication-panel > button { justify-self: start; }
</style>
