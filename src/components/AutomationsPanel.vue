<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, ref, shallowRef, type Component } from "vue"
import type { ApplicationReviewManagement } from "../app/applicationReviewManagement"
import { automationTypes } from "../domain/automationContract"
import type { AutomationManagement } from "../app/useAutomations"
const props = defineProps<{ management: AutomationManagement; owner: boolean }>()
const ApplicationReviewDialog = defineAsyncComponent<Component>(() => import("./ApplicationReviewDialog.vue"))
const applicationReview = shallowRef<ApplicationReviewManagement | null>(null)
const reviewFailure = ref("")
let reviewGeneration = 0
function closeReview() { reviewGeneration += 1; applicationReview.value?.close(); applicationReview.value = null }
onBeforeUnmount(closeReview)
async function reviewEmail(record: AutomationManagement["records"]["value"][number], eventId: string) {
  closeReview(); const generation = reviewGeneration; reviewFailure.value = ""
  try {
    const review = await props.management.reviewEmail(record, eventId)
    if (generation !== reviewGeneration) { review.close(); return }
    applicationReview.value = review
  } catch (error) { if (generation === reviewGeneration) reviewFailure.value = error instanceof Error ? error.message : "Application review unavailable" }
}
const adding = ref(false)
const name = ref("Job intake")
const address = ref("https://automation.meta-uber-engineer.dev")
const consent = ref(false)
const removing = ref("")
const approving = ref("")
const approvalMode = ref<"renew" | "adopt" | "email" | "evidence">("renew")
const approvalConsent = ref(false)
const stateLabel = { active: "Active", paused: "Paused", deleted: "Removed" }
const emailStateLabel: Record<string, string> = { pending: "Queued", processing: "Processing", applied: "Applied", review: "Needs review", failed: "Failed" }
async function connect() {
  try {
    await props.management.add(address.value, { name: name.value, type: "job-intake", typeVersion: 2, parameters: { sources: ["website"] } }, consent.value)
    adding.value = false; consent.value = false
  } catch { /* Application boundary exposes the failure without losing the form. */ }
}
async function setState(record: AutomationManagement["records"]["value"][number], state: "active" | "paused" | "deleted") {
  try { await props.management.setState(record, state); removing.value = "" } catch { /* Keep failed action visible. */ }
}
async function enableEmail(record: AutomationManagement["records"]["value"][number]) {
  requestApproval(record, "email")
}
async function enableEvidence(record: AutomationManagement["records"]["value"][number]) {
  requestApproval(record, "evidence")
}
function requestApproval(record: AutomationManagement["records"]["value"][number], mode: typeof approvalMode.value) {
  approving.value = record.entity.id; approvalMode.value = mode; approvalConsent.value = false
}
function needsApproval(record: AutomationManagement["records"]["value"][number]) {
  const description = props.management.instanceDescription(record)
  return description?.adoptionRequired || Boolean(description && description.expiresAt <= Date.now())
}
function approvalStatus(record: AutomationManagement["records"]["value"][number]) {
  const description = props.management.instanceDescription(record)
  if (description?.adoptionRequired) return "Existing Worker · approval required"
  return description && description.expiresAt <= Date.now() ? "Approval expired" : ""
}
async function confirmApproval(record: AutomationManagement["records"]["value"][number]) {
  if (!approvalConsent.value) return
  try {
    await props.management.retry(record, { name: record.definition.name, type: "job-intake",
      typeVersion: approvalMode.value === "evidence" ? 2 : record.definition.typeVersion,
      parameters: approvalMode.value === "email" ? { sources: ["website", "email"] } : record.definition.parameters })
    approving.value = ""; approvalConsent.value = false
  } catch { /* Keep the consent and failed approval visible. */ }
}
async function retry(record: AutomationManagement["records"]["value"][number]) {
  try { await props.management.retry(record) } catch { /* Keep failed activation visible. */ }
}
async function retryEmail(record: AutomationManagement["records"]["value"][number], eventId: string) {
  try { await props.management.retryEmail(record, eventId) } catch { /* Keep failed processing retry visible. */ }
}
</script>
<template>
  <section class="automations" aria-label="Automations">
    <div class="automation-heading"><h3>Automations</h3><button v-if="owner && !adding" class="button button-small" type="button" :disabled="management.busy.value" @click="adding = true">Add automation</button></div>
    <p v-if="!management.records.value.length && !adding" class="dialog-copy">No automations connected.</p>
    <p v-if="!owner" class="dialog-copy">The workspace owner manages automations.</p>
    <form v-if="adding && owner" class="automation-form" @submit.prevent="connect">
      <label>Automation name<input v-model="name" aria-label="Automation name" required maxlength="100" /></label>
      <p>Type: {{ automationTypes[0].title }}</p>
      <label>Worker address<input v-model="address" aria-label="Worker address" required placeholder="https://automation.example" /></label>
      <p class="dialog-copy">Job intake creates Leads from website submissions. Email forwarding requires a configured receiving route.</p>
      <p class="dialog-copy">Worker receives reading access to this entire workspace and permission to create Leads, retain vacancy evidence and advance matched applications. Access expires after 30 days.</p>
      <label class="automation-consent"><input v-model="consent" type="checkbox" aria-label="Allow Worker to read this workspace" />Allow Worker to read this workspace</label>
      <p v-if="!management.storage.value.length" role="status">Connect Rusty storage first.</p>
      <div class="automation-actions"><button class="button" type="submit" :disabled="management.busy.value || !consent || !management.storage.value.length">Connect automation</button><button class="button button-quiet" type="button" :disabled="management.busy.value" @click="adding = false">Cancel</button></div>
    </form>
    <article v-for="record in management.records.value" :key="record.entity.id" :aria-label="record.definition.name" class="automation-record">
      <h4>{{ record.definition.name }}</h4>
      <p class="automation-state" :class="{ confirmed: management.confirmation(record) }">{{ approvalStatus(record) || `${stateLabel[record.control.state]} · ${management.confirmation(record) ? 'confirmed by Worker' : 'waiting for Worker'}` }}</p>
      <p class="dialog-copy">{{ automationTypes.find(value => value.type === record.definition.type)?.title }} · {{ record.entity.executor.origin }}</p>
      <p v-if="management.observationErrors.value[record.entity.id]" class="dialog-copy">{{ management.observationErrors.value[record.entity.id] }}</p>
      <template v-if="owner && record.control.state !== 'deleted' && record.definition.typeVersion === 1">
        <p class="dialog-copy">Allow this automation to keep original vacancy evidence with new cards.</p>
        <button class="button button-small" type="button" :disabled="management.busy.value" @click="enableEvidence(record)">Enable vacancy evidence</button>
      </template>
      <section v-if="owner && (management.email.value[record.entity.id]?.route || management.email.value[record.entity.id]?.receipt.events.length)" aria-label="Email forwarding" class="automation-record">
        <h4>Email forwarding</h4>
        <p v-if="management.email.value[record.entity.id]?.route" class="dialog-copy">Forward copies of job emails from {{ management.email.value[record.entity.id]?.route?.mailbox }} to this private address. Keep originals in your inbox.</p>
        <input v-if="management.email.value[record.entity.id]?.route" aria-label="Forwarding address" readonly :value="management.email.value[record.entity.id]?.route?.address" />
        <button v-if="!record.definition.parameters.sources.includes('email')" class="button button-small" type="button" :disabled="management.busy.value" @click="enableEmail(record)">Enable email and Applied</button>
        <p v-else-if="!management.confirmation(record)" role="status">Email activation pending</p>
        <p v-else role="status">Email enabled · {{ management.email.value[record.entity.id]?.receipt.events.length ? 'Mail received' : 'Waiting for first email' }}</p>
        <ul v-if="management.email.value[record.entity.id]?.receipt.events.length" aria-label="Recent email processing" class="automation-email-events">
          <li v-for="event in management.email.value[record.entity.id]?.receipt.events" :key="event.eventId">
            <strong>{{ event.subject || 'Forwarded email' }}</strong>
            <span>{{ emailStateLabel[event.status] || event.status }} · {{ new Date(event.createdAt).toLocaleString() }}</span>
            <p v-if="event.result?.reason"><template v-if="event.status === 'pending' || event.status === 'processing'">Last attempt: </template>{{ event.result.reason }}</p>
            <p v-if="event.bindingId" role="status">Owner binding saved</p>
            <button v-if="event.status === 'review' || event.status === 'failed' || event.bindingId" class="button button-small" type="button"
              :disabled="management.busy.value" @click="reviewEmail(record, event.eventId)">Bind application</button>
            <button v-if="event.status === 'review' || event.status === 'failed'" class="button button-small" type="button"
              :disabled="management.busy.value || record.control.state !== 'active' || !management.confirmation(record)" @click="retryEmail(record, event.eventId)">Retry processing</button>
          </li>
        </ul>
        <a v-if="management.email.value[record.entity.id]?.receipt.confirmation" :href="management.email.value[record.entity.id]?.receipt.confirmation?.url" target="_blank" rel="noopener noreferrer">Confirm Gmail forwarding</a>
      </section>
      <div v-if="owner && record.control.state !== 'deleted'" class="automation-actions">
        <button class="button button-small" type="button" :disabled="management.busy.value" @click="setState(record, record.control.state === 'active' ? 'paused' : 'active')">{{ record.control.state === 'active' ? 'Pause' : 'Resume' }}</button>
        <button v-if="needsApproval(record)" class="button button-small" type="button" :disabled="management.busy.value"
          @click="requestApproval(record, management.instanceDescription(record)?.adoptionRequired ? 'adopt' : 'renew')">{{ management.instanceDescription(record)?.adoptionRequired ? 'Adopt existing Worker' : 'Renew approval' }}</button>
        <button v-else-if="!management.confirmation(record)" class="button button-small" type="button" :disabled="management.busy.value" @click="retry(record)">Retry connection</button>
        <button class="button button-small button-quiet" type="button" :disabled="management.busy.value" @click="removing = record.entity.id">Remove</button>
      </div>
      <form v-if="approving === record.entity.id" aria-label="Confirm automation approval" class="automation-form" @submit.prevent="confirmApproval(record)">
        <p class="dialog-copy">This Worker receives reading access to this entire workspace and permission to create Leads{{ approvalMode === 'email' || record.definition.parameters.sources.includes('email') ? ' and advance matched applications' : '' }}{{ approvalMode === 'evidence' || record.definition.typeVersion === 2 ? ', retaining original vacancy evidence' : '' }}. Access expires after 30 days.</p>
        <p v-if="approvalMode === 'adopt'" class="dialog-copy">Keep this existing Worker and its saved events. Confirm its new automation approval.</p>
        <label class="automation-consent"><input v-model="approvalConsent" type="checkbox" aria-label="Allow Worker to read this workspace" />Allow Worker to read this workspace</label>
        <div class="automation-actions"><button class="button button-small" type="submit" :disabled="management.busy.value || !approvalConsent">Confirm approval</button><button class="button button-small button-quiet" type="button" :disabled="management.busy.value" @click="approving = ''; approvalConsent = false">Cancel</button></div>
      </form>
      <div v-if="removing === record.entity.id" class="automation-actions"><p>Remove permanently? Pending events will stop.</p><button class="button button-danger" type="button" :disabled="management.busy.value" @click="setState(record, 'deleted')">Confirm removal</button><button class="button" type="button" @click="removing = ''">Cancel</button></div>
    </article>
    <p v-if="management.busy.value" role="status">Saving automation…</p>
    <p v-if="management.failure.value" role="alert">{{ management.failure.value }}</p>
    <p v-if="reviewFailure" role="alert">{{ reviewFailure }}</p>
    <ApplicationReviewDialog v-if="applicationReview" :review="applicationReview.review.value" :busy="applicationReview.busy.value"
      :failure="applicationReview.failure.value" :saved="applicationReview.saved.value" @close="closeReview"
      @select="applicationReview.select" @page="applicationReview.page" @save="applicationReview.save" @retry="applicationReview.retry" />
  </section>
</template>
<style scoped>
.automation-email-events { display: grid; gap: 12px; margin: 0; padding-left: 20px; }
.automation-email-events li > span { display: block; color: var(--muted); }
.automation-email-events p { margin: 4px 0 0; }
.automations { display: grid; gap: 14px; margin-top: 24px; }
.automation-heading, .automation-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
h3, h4, p { margin: 0; }
.automation-heading { justify-content: space-between; }
.automation-form, .automation-record { display: grid; gap: 12px; border-top: 1px solid var(--ink, #333); padding-top: 16px; }
label { display: grid; gap: 6px; }
input { min-width: 0; }
.automation-consent { display: flex; align-items: center; gap: 10px; }
.automation-state { color: var(--muted, #666); }
.automation-state.confirmed { color: var(--green, #176b50); }
</style>
