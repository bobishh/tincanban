<script setup lang="ts">
import { computed, ref, watch } from "vue"

type ReviewChange = {
  hash: string
  status: { type: "quarantined" | "pending"; reason: string }
  preview: string[]
  actor: string
  time: number
  action: string
  dismissed?: boolean
  resolved?: boolean
  personId?: string
  deviceId?: string
}

const props = defineProps<{
  changes: ReviewChange[]
  error: string
  canReview: boolean
  reviewChange: (hash: string) => Promise<void>
  dismissChange: (hash: string) => Promise<void>
  restoreChange: (hash: string) => Promise<void>
}>()

const busyHash = ref("")
const actionError = ref("")
const dismissedExternalError = ref("")
const actionErrorDismissed = ref(false)
const temporaryDismissed = ref(new Set<string>())
const activeChanges = computed(() => props.changes.filter(change => !change.dismissed && !temporaryDismissed.value.has(change.hash)))
const historyChanges = computed(() => props.changes.filter(change => change.dismissed || temporaryDismissed.value.has(change.hash)))
const showExternalError = computed(() => Boolean(props.error && dismissedExternalError.value !== props.error))

watch(() => props.error, (error, previous) => {
  if (error && error !== previous) dismissedExternalError.value = ""
})

function reviewTime(seconds: number): string {
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) && Math.abs(date.getFullYear()) < 100_000
    ? date.toLocaleString()
    : "Time unavailable"
}

async function review(hash: string) {
  busyHash.value = hash
  actionError.value = ""
  actionErrorDismissed.value = false
  try { await props.reviewChange(hash) }
  catch (error) { actionError.value = error instanceof Error ? error.message : String(error) }
  finally { busyHash.value = "" }
}

async function dismiss(hash: string) {
  busyHash.value = hash
  actionError.value = ""
  actionErrorDismissed.value = false
  temporaryDismissed.value = new Set(temporaryDismissed.value).add(hash)
  try {
    await props.dismissChange(hash)
    const next = new Set(temporaryDismissed.value)
    next.delete(hash)
    temporaryDismissed.value = next
  } catch (error) {
    actionError.value = `Dismissal could not be saved. Retry or reload. ${error instanceof Error ? error.message : String(error)}`
  }
  finally { busyHash.value = "" }
}

async function restore(hash: string) {
  busyHash.value = hash
  actionError.value = ""
  actionErrorDismissed.value = false
  try {
    await props.restoreChange(hash)
    const next = new Set(temporaryDismissed.value)
    next.delete(hash)
    temporaryDismissed.value = next
  }
  catch (error) { actionError.value = error instanceof Error ? error.message : String(error) }
  finally { busyHash.value = "" }
}
</script>

<template>
  <section v-if="activeChanges.length || showExternalError" class="causal-review-banner" aria-label="Workspace change review">
    <p v-if="showExternalError" class="causal-review-error" role="alert">{{ error }}</p>
    <button v-if="showExternalError" class="button button-small" type="button"
      aria-label="Dismiss review error" @click="dismissedExternalError = error">Dismiss</button>
    <details :open="Boolean(showExternalError)">
      <summary>{{ activeChanges.length ? `${activeChanges.length} workspace changes need review` : 'Workspace access update needs retry' }}</summary>
      <ul class="causal-review-list">
        <li v-for="change in activeChanges" :key="change.hash">
          <div><strong>{{ change.action }}</strong><span>{{ change.resolved ? 'Authorized change saved' : change.status.type === 'pending' ? 'Waiting for dependency' : 'Quarantined' }}</span></div>
          <small>{{ change.personId ?? change.actor }} · {{ change.deviceId ?? 'Unknown device' }} · {{ reviewTime(change.time) }}</small>
          <code>{{ change.hash }}</code>
          <p>{{ change.status.reason }}</p>
          <ul v-if="change.preview.length" class="causal-review-preview" aria-label="Draft field changes">
            <li v-for="(line, index) in change.preview" :key="index">{{ line }}</li>
          </ul>
          <p v-else-if="change.status.type === 'pending'">Waiting for dependencies to be available and authorized.</p>
          <button v-if="canReview && change.status.type === 'quarantined'" class="button button-small" type="button"
            :disabled="Boolean(busyHash) || showExternalError" @click="review(change.hash)">
            {{ busyHash === change.hash ? 'Creating authorized change…' : 'Create authorized change from this review' }}
          </button>
          <button class="button button-small" type="button" :disabled="Boolean(busyHash)" @click="dismiss(change.hash)">
            Dismiss review
          </button>
        </li>
      </ul>
    </details>
  </section>
  <div v-if="actionError && !actionErrorDismissed" class="causal-review-save-error">
    <p role="alert" class="causal-review-error">{{ actionError }}</p>
    <button class="button button-small" type="button" aria-label="Dismiss review error" @click="actionErrorDismissed = true">Dismiss error</button>
  </div>
  <section v-if="historyChanges.length" class="causal-review-history" aria-label="Workspace review history">
    <details>
      <summary>{{ historyChanges.length }} change{{ historyChanges.length === 1 ? '' : 's' }} in review history</summary>
      <ul class="causal-review-list">
        <li v-for="change in historyChanges" :key="change.hash">
          <div><strong>{{ change.action }}</strong><span>{{ change.resolved ? 'Authorized change saved' : change.status.type === 'pending' ? 'Waiting for dependency' : 'Quarantined' }}</span></div>
          <small>{{ change.personId ?? change.actor }} · {{ change.deviceId ?? 'Unknown device' }} · {{ reviewTime(change.time) }}</small>
          <code>{{ change.hash }}</code>
          <p>{{ change.status.reason }}</p>
          <ul v-if="change.preview.length" class="causal-review-preview" aria-label="Draft field changes">
            <li v-for="(line, index) in change.preview" :key="index">{{ line }}</li>
          </ul>
          <button v-if="!change.resolved" class="button button-small" type="button" :disabled="Boolean(busyHash)" @click="restore(change.hash)">Restore review</button>
          <button v-if="temporaryDismissed.has(change.hash) && !change.resolved" class="button button-small" type="button"
            :disabled="Boolean(busyHash)" @click="dismiss(change.hash)">Retry save dismissal</button>
          <button v-if="canReview && change.status.type === 'quarantined' && !change.resolved" class="button button-small" type="button"
            :disabled="Boolean(busyHash) || showExternalError" @click="review(change.hash)">
            {{ busyHash === change.hash ? 'Creating authorized change…' : 'Create authorized change from this review' }}
          </button>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.causal-review-banner { margin: 0 var(--space-4) var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--warning, #9a6b12); border-radius: 10px; background: var(--surface, white); }
.causal-review-history { margin: 0 var(--space-4) var(--space-3); }
.causal-review-save-error { margin: 0 var(--space-4) var(--space-3); padding: var(--space-2) var(--space-3); border-left: 3px solid var(--danger, #9b2c2c); }
.causal-review-banner summary { cursor: pointer; font-weight: 700; }
.causal-review-list { display: grid; gap: var(--space-3); padding-left: var(--space-4); }
.causal-review-list li { display: grid; gap: var(--space-1); }
.causal-review-list li > div { display: flex; gap: var(--space-3); align-items: baseline; }
.causal-review-list small, .causal-review-list code { color: var(--muted); overflow-wrap: anywhere; }
.causal-review-list p, .causal-review-error { margin: 0; }
.causal-review-error { color: var(--danger, #9b2c2c); }
</style>
