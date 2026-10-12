<script setup lang="ts">
import { ref } from "vue"
import { automationTypes } from "../domain/automationContract"
import type { AutomationManagement } from "../app/useAutomations"
const props = defineProps<{ management: AutomationManagement; owner: boolean }>()
const adding = ref(false)
const name = ref("Job intake")
const address = ref("https://automation.meta-uber-engineer.dev")
const consent = ref(false)
const removing = ref("")
const stateLabel = { active: "Active", paused: "Paused", deleted: "Removed" }
async function connect() {
  try {
    await props.management.add(address.value, { name: name.value, type: "job-intake", typeVersion: 1, parameters: { sources: ["website"] } }, consent.value)
    adding.value = false; consent.value = false
  } catch { /* Application boundary exposes the failure without losing the form. */ }
}
async function setState(record: AutomationManagement["records"]["value"][number], state: "active" | "paused" | "deleted") {
  try { await props.management.setState(record, state); removing.value = "" } catch { /* Keep failed action visible. */ }
}
async function enableEmail(record: AutomationManagement["records"]["value"][number]) {
  try { await props.management.retry(record, { name: record.definition.name, type: "job-intake", typeVersion: 1,
    parameters: { sources: ["website", "email"] } }) } catch { /* Show activation failure. */ }
}
async function retry(record: AutomationManagement["records"]["value"][number]) {
  try { await props.management.retry(record) } catch { /* Keep failed activation visible. */ }
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
      <p class="dialog-copy">Worker receives reading access to this entire workspace and permission to create Leads and advance matched applications. Access expires after 30 days.</p>
      <label class="automation-consent"><input v-model="consent" type="checkbox" aria-label="Allow Worker to read this workspace" />Allow Worker to read this workspace</label>
      <p v-if="!management.storage.value.length" role="status">Connect Rusty storage first.</p>
      <div class="automation-actions"><button class="button" type="submit" :disabled="management.busy.value || !consent || !management.storage.value.length">Connect automation</button><button class="button button-quiet" type="button" :disabled="management.busy.value" @click="adding = false">Cancel</button></div>
    </form>
    <article v-for="record in management.records.value" :key="record.entity.id" :aria-label="record.definition.name" class="automation-record">
      <h4>{{ record.definition.name }}</h4>
      <p class="automation-state" :class="{ confirmed: management.confirmation(record) }">{{ stateLabel[record.control.state] }} · {{ management.confirmation(record) ? 'confirmed by Worker' : 'waiting for Worker' }}</p>
      <p class="dialog-copy">{{ automationTypes.find(value => value.type === record.definition.type)?.title }} · {{ record.entity.executor.origin }}</p>
      <p v-if="management.observationErrors.value[record.entity.id]" class="dialog-copy">{{ management.observationErrors.value[record.entity.id] }}</p>
      <section v-if="owner && management.email.value[record.entity.id]?.route" aria-label="Email forwarding" class="automation-record">
        <h4>Email forwarding</h4>
        <p class="dialog-copy">Forward copies of job emails from {{ management.email.value[record.entity.id]?.route?.mailbox }} to this private address. Keep originals in your inbox.</p>
        <input aria-label="Forwarding address" readonly :value="management.email.value[record.entity.id]?.route?.address" />
        <button v-if="!record.definition.parameters.sources.includes('email')" class="button button-small" type="button" :disabled="management.busy.value" @click="enableEmail(record)">Enable email and Applied</button>
        <p v-else role="status">Email enabled · {{ management.email.value[record.entity.id]?.receipt.events.length ? 'Mail received' : 'Waiting for first email' }}</p>
        <a v-if="management.email.value[record.entity.id]?.receipt.confirmation" :href="management.email.value[record.entity.id]?.receipt.confirmation?.url" target="_blank" rel="noopener noreferrer">Confirm Gmail forwarding</a>
      </section>
      <div v-if="owner && record.control.state !== 'deleted'" class="automation-actions">
        <button class="button button-small" type="button" :disabled="management.busy.value" @click="setState(record, record.control.state === 'active' ? 'paused' : 'active')">{{ record.control.state === 'active' ? 'Pause' : 'Resume' }}</button>
        <button v-if="!management.confirmation(record)" class="button button-small" type="button" :disabled="management.busy.value" @click="retry(record)">Retry connection</button>
        <button class="button button-small button-quiet" type="button" :disabled="management.busy.value" @click="removing = record.entity.id">Remove</button>
      </div>
      <div v-if="removing === record.entity.id" class="automation-actions"><p>Remove permanently? Pending events will stop.</p><button class="button button-danger" type="button" :disabled="management.busy.value" @click="setState(record, 'deleted')">Confirm removal</button><button class="button" type="button" @click="removing = ''">Cancel</button></div>
    </article>
    <p v-if="management.busy.value" role="status">Saving automation…</p>
    <p v-if="management.failure.value" role="alert">{{ management.failure.value }}</p>
  </section>
</template>
<style scoped>
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
