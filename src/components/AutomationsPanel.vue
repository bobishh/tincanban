<script setup lang="ts">
import { computed, ref } from "vue"
import type { AutomationManagement } from "../app/useAutomations"
const props = defineProps<{ management: AutomationManagement; owner: boolean }>()
const adding = ref(false)
const selectedType = ref("")
const template = computed(() => props.management.types.value.find(type => `${type.type}:${type.version}` === selectedType.value) ?? props.management.types.value.at(-1))
const name = ref(template.value?.title ?? "")
const address = ref("https://automation.meta-uber-engineer.dev")
const consent = ref(false)
const removing = ref("")
const approving = ref("")
const approvalMode = ref<"renew" | "adopt">("renew")
const approvalConsent = ref(false)
const stateLabel = { active: "Active", paused: "Paused", deleted: "Removed" }
async function connect() {
  try {
    if (!template.value) throw new Error("Configure an automation on this board")
    await props.management.add(address.value, { name: name.value || template.value.title, type: template.value.type, typeVersion: template.value.version, parameters: template.value.defaults }, consent.value)
    adding.value = false; consent.value = false
  } catch { /* Application boundary exposes the failure without losing the form. */ }
}
async function setState(record: AutomationManagement["records"]["value"][number], state: "active" | "paused" | "deleted") {
  try { await props.management.setState(record, state); removing.value = "" } catch { /* Keep failed action visible. */ }
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
    await props.management.retry(record, { name: record.definition.name, type: record.definition.type,
      typeVersion: record.definition.typeVersion,
      parameters: record.definition.parameters })
    approving.value = ""; approvalConsent.value = false
  } catch { /* Keep the consent and failed approval visible. */ }
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
      <label><span>Type</span><select v-model="selectedType"><option v-for="type in management.types.value" :key="`${type.type}:${type.version}`" :value="`${type.type}:${type.version}`">{{ type.title }} · {{ type.version }}</option></select></label>
      <label>Worker address<input v-model="address" aria-label="Worker address" required placeholder="https://automation.example" /></label>
      <p class="dialog-copy">Available workflows and their settings come from this board configuration.</p>
      <p class="dialog-copy">Worker can read this workspace and perform the listed configured actions. Access expires after 30 days.</p>
      <label class="automation-consent"><input v-model="consent" type="checkbox" aria-label="Allow Worker to read this workspace" />Allow Worker to read this workspace</label>
      <p v-if="!management.storage.value.length" role="status">Connect Rusty storage first.</p>
      <div class="automation-actions"><button class="button" type="submit" :disabled="management.busy.value || !consent || !management.storage.value.length">Connect automation</button><button class="button button-quiet" type="button" :disabled="management.busy.value" @click="adding = false">Cancel</button></div>
    </form>
    <article v-for="record in management.records.value" :key="record.entity.id" :aria-label="record.definition.name" class="automation-record">
      <h4>{{ record.definition.name }}</h4>
      <p class="automation-state" :class="{ confirmed: management.confirmation(record) }">{{ approvalStatus(record) || `${stateLabel[record.control.state]} · ${management.confirmation(record) ? 'confirmed by Worker' : 'waiting for Worker'}` }}</p>
      <p class="dialog-copy">{{ management.types.value.find(value => value.type === record.definition.type)?.title }} · {{ record.entity.executor.origin }}</p>
      <p v-if="management.observationErrors.value[record.entity.id]" class="dialog-copy">{{ management.observationErrors.value[record.entity.id] }}</p>
      <section v-if="owner && management.email.value[record.entity.id]?.route" aria-label="Email forwarding" class="automation-record">
        <h4>Email forwarding</h4>
        <p v-if="management.email.value[record.entity.id]?.route" class="dialog-copy">Forward copies of emails from {{ management.email.value[record.entity.id]?.route?.mailbox }} to this private address. Keep originals in your inbox.</p>
        <input v-if="management.email.value[record.entity.id]?.route" aria-label="Forwarding address" readonly :value="management.email.value[record.entity.id]?.route?.address" />
        <p v-else-if="!management.confirmation(record)" role="status">Email activation pending</p>
        <p v-else role="status">Email enabled</p>
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
        <p class="dialog-copy">Worker can read this workspace and perform the listed configured actions. Access expires after 30 days.</p>
        <p v-if="approvalMode === 'adopt'" class="dialog-copy">Keep this existing Worker and its saved events. Confirm its new automation approval.</p>
        <label class="automation-consent"><input v-model="approvalConsent" type="checkbox" aria-label="Allow Worker to read this workspace" />Allow Worker to read this workspace</label>
        <div class="automation-actions"><button class="button button-small" type="submit" :disabled="management.busy.value || !approvalConsent">Confirm approval</button><button class="button button-small button-quiet" type="button" :disabled="management.busy.value" @click="approving = ''; approvalConsent = false">Cancel</button></div>
      </form>
      <div v-if="removing === record.entity.id" class="automation-actions"><p>Remove permanently? Pending events will stop.</p><button class="button button-danger" type="button" :disabled="management.busy.value" @click="setState(record, 'deleted')">Confirm removal</button><button class="button" type="button" @click="removing = ''">Cancel</button></div>
    </article>
    <p v-if="management.busy.value" role="status">Saving automation…</p>
    <p v-if="management.failure.value" role="alert">{{ management.failure.value }}</p>
  </section>
</template>
<style scoped>
.automations { display: grid; gap: var(--space-3); margin-top: var(--space-5); }
.automation-heading, .automation-actions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
h3, h4, p { margin: 0; }
.automation-heading { justify-content: space-between; }
.automation-form, .automation-record { display: grid; gap: var(--space-3); border-top: 1px solid var(--ink, #333); padding-top: var(--space-4); }
label { display: grid; gap: var(--space-1); }
input { min-width: 0; }
.automation-consent { display: flex; align-items: center; gap: var(--space-2); }
.automation-state { color: var(--muted, #666); }
.automation-state.confirmed { color: var(--green, #176b50); }
</style>
