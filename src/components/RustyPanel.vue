<script setup lang="ts">
import { computed, ref } from "vue"
import type { BlindReplicationController, RustyRemovalProgress } from "../app/blindReplication"
import { profileDeliveryStates, replicaKey, replicaStatus, syncTime } from "../app/blindReplication"
import { deviceDisplayName } from "../ui/deviceInfo"
import RustyMark from "./RustyMark.vue"
import RustyCredentialConflictRecovery from "./RustyCredentialConflictRecovery.vue"
const props = defineProps<{ controller: BlindReplicationController; workspaceId: string; owner: boolean }>()
const address = ref("")
const adding = ref(false)
const failure = ref("")
const pending = ref(false)
const updatingOrigin = ref("")
const forgettingOrigin = ref("")
const busy = computed(() => pending.value || (props.controller.actionBusy?.value ?? props.controller.busy.value))
const savedOperations = computed(() => props.controller.pendingRustyOperations?.value ?? [])
const removalSteps: Record<RustyRemovalProgress["phase"], string> = {
  "checking-automations": "Check automations connected to this server",
  "pausing-automations": "Pause automation writes",
  "revoking-device": "Confirm removal of this device from the server",
  "updating-storage": "Update access for the saved boards and profile",
  "updating-automations": "Update automation access",
  "activating": "Activate the confirmed connection settings",
  "confirming-snapshots": "Confirm fresh board and profile copies",
}
const records = computed(() => props.controller.configs.value.filter(config => config.workspaceId === props.workspaceId))
const boardConflicts = computed(() => props.controller.preferenceConflicts.value.filter(conflict =>
  conflict.workspaceIds.includes(props.workspaceId)))
const profileConflicts = computed(() => {
  return [...new Map(props.controller.preferenceConflicts.value
    .filter(conflict => conflict.identityState)
    .map(conflict => [conflict.origin, conflict] as const)).values()]
})
const profileRecords = computed(() => profileDeliveryStates(props.controller.configs.value, props.controller.identityConfigs.value,
  props.controller.statuses.value, props.workspaceId, props.controller.now.value))
const resetOrigins = computed(() => [...new Set([...records.value, ...boardConflicts.value, ...profileConflicts.value,
  ...profileRecords.value, ...savedOperations.value].map(value => value.origin))])
async function run(action: () => Promise<void>) {
  pending.value = true
  failure.value = ""
  try { await action() } catch (cause) { failure.value = props.controller.error.value || (cause instanceof Error ? cause.message : "Rusty connection failed") }
  finally { pending.value = false }
}
async function connect() {
  await run(async () => { await props.controller.attach(address.value, props.workspaceId); address.value = ""; adding.value = false })
}
async function updateDeviceAccess(origin: string) {
  updatingOrigin.value = origin
  try { await run(() => props.controller.updateDeviceAccess(origin, props.workspaceId)) }
  finally { updatingOrigin.value = "" }
}
async function forget() {
  const origin = forgettingOrigin.value
  await run(async () => {
    await props.controller.forgetRusty(origin, props.workspaceId)
    forgettingOrigin.value = ""
    if (props.owner) { address.value = origin; adding.value = true }
  })
}
</script>
<template>
  <section class="rusty-panel" aria-label="Rusty">
    <div class="rusty-heading"><RustyMark compact /><h3>Persistent storage · Rusty</h3></div>
    <p class="dialog-copy">Rusty servers keep encrypted board copies available to board participants while the owner's devices are offline. Only the owner can add servers.</p>
    <p v-if="!owner && !records.length && !boardConflicts.length" class="dialog-copy">No Rusty connection has reached this device for this board yet. Connect to a board participant to receive shared storage access.</p>
    <div v-for="conflict in boardConflicts" :key="`board/${conflict.origin}`" class="rusty-conflict" role="alert" aria-label="Rusty settings conflict">
      <p>Rusty sync is paused for {{ conflict.origin }} because devices saved different connection settings. Your saved changes are retained.</p>
      <RustyCredentialConflictRecovery :origin="conflict.origin" :scope-id="conflict.scopeId" :workspace-id="workspaceId" :owner="owner" :disabled="busy" :recover="controller.recoverCredentialConflict" />
    </div>
    <section v-for="operation in owner ? savedOperations : []" :key="`operation/${operation.origin}`" class="rusty-conflict" aria-label="Saved Rusty operation">
      <p>{{ operation.origin }}: {{ operation.kind === 'device-revocation' ? 'Device removal is unfinished. Board and profile sync are paused on this server.' : 'Connection recovery is unfinished.' }} Saved data and the original operation are retained.</p>
      <p v-if="operation.kind === 'device-revocation'">Device: {{ deviceDisplayName({ deviceId: operation.deviceId, name: controller.registeredDevices?.value.find(device => device.deviceId === operation.deviceId)?.displayName }) }}</p>
      <p v-if="operation.progress">Next step: {{ removalSteps[operation.progress.phase] }}.</p>
      <details v-if="operation.progress"><summary>Recovery details</summary><p>{{ operation.progress.confirmedScopes }} / {{ operation.progress.scopeCount }} storage updates confirmed. {{ operation.progress.frozenWorkers }} / {{ operation.progress.workerCount }} automations paused; {{ operation.progress.rotatedWorkers }} updated. Device revocation confirmed: {{ operation.progress.personConfirmed ? 'yes' : 'no' }}.</p></details>
      <p v-if="operation.signerDeviceId !== controller.currentDeviceId.value">Continue on the device that started this operation.</p>
      <button class="button" type="button" :disabled="busy || operation.signerDeviceId !== controller.currentDeviceId.value" @click="run(() => controller.resumeRustyOperation(operation.origin))">Resume Rusty operation</button>
    </section>
    <ul v-if="records.length" class="rusty-connections">
      <li v-for="config in records" :key="`${config.origin}/${config.scopeId}`">
        <div class="rusty-connection"><strong class="technical-value">{{ config.origin }}</strong><span class="reading-explanation">{{ replicaStatus(config, controller.statuses.value[replicaKey(config)], controller.now.value) }}</span>
          <small v-if="config.boardAccess">{{ config.boardAccess.mode === 'read' ? 'Board access · read only' : 'Board access · read and write' }}</small>
          <small v-if="controller.statuses.value[replicaKey(config)]?.lastSyncedAt">Last sync: <time :datetime="new Date(controller.statuses.value[replicaKey(config)]!.lastSyncedAt!).toISOString()">{{ syncTime(controller.statuses.value[replicaKey(config)]!.lastSyncedAt!) }}</time></small>
          <small v-if="controller.statuses.value[replicaKey(config)]?.error" role="alert">{{ controller.statuses.value[replicaKey(config)]!.error }}</small>
        </div>
        <button v-if="owner" class="button button-quiet" type="button" :disabled="busy" @click="run(() => controller.remove(config))">{{ config.removalPending ? 'Retry removal' : 'Remove' }}</button>
      </li>
    </ul>
    <div v-if="profileRecords.length" class="rusty-profile-status" aria-label="Profile delivery">
      <h4>Profile delivery</h4>
      <p class="dialog-copy">Profile photo and private settings sync independently from board data.</p>
      <ul class="rusty-connections">
        <li v-for="profile in profileRecords" :key="profile.key" class="rusty-profile-connection">
          <div class="rusty-connection"><strong class="technical-value">{{ profile.origin }}</strong><span class="reading-explanation">{{ profile.status }}</span>
            <small v-if="profile.lastSyncedAt">Last sync: <time :datetime="new Date(profile.lastSyncedAt).toISOString()">{{ syncTime(profile.lastSyncedAt) }}</time></small>
            <small v-if="profile.error" role="alert">{{ profile.error }}</small>
            <small v-if="profile.status === 'Profile delivery not configured' && controller.profileSetupErrors.value[profile.origin]" role="alert">{{ controller.profileSetupErrors.value[profile.origin] }}</small>
          </div>
          <div v-if="owner && controller.profilePermissionUpdates?.value.includes(profile.origin)" class="rusty-access-update">
            <p class="dialog-copy">Allow your approved devices to manage this Rusty connection. Your boards and saved files stay unchanged.</p>
            <button class="button" type="button" :disabled="busy" @click="updateDeviceAccess(profile.origin)">{{ updatingOrigin === profile.origin ? 'Updating device access…' : 'Update device access' }}</button>
          </div>
        </li>
      </ul>
    </div>
    <div v-for="conflict in profileConflicts" :key="`profile/${conflict.origin}`" class="rusty-conflict" role="alert" aria-label="Rusty profile settings conflict">
      <p>Profile delivery is paused for {{ conflict.origin }} because devices saved different connection settings. Your saved changes are retained.</p>
      <RustyCredentialConflictRecovery :origin="conflict.origin" :scope-id="conflict.scopeId" :workspace-id="workspaceId" :owner="owner" :disabled="busy" :recover="controller.recoverCredentialConflict" />
    </div>
    <section v-for="origin in resetOrigins" :key="`forget/${origin}`" class="rusty-conflict" aria-label="Forget local Rusty access">
      <button v-if="forgettingOrigin !== origin" class="button button-quiet" type="button" :disabled="busy" @click="forgettingOrigin = origin">Forget Rusty on this device</button>
      <template v-else>
        <p>Forget {{ origin }} for all your boards and profile on this device? This abandons unfinished Rusty operations. Board data, profile, files, and an audit copy of old settings stay saved. Server data and other participants are unchanged.</p>
        <button class="button button-danger" type="button" :disabled="busy" @click="forget">Confirm forget Rusty</button>
        <button class="button button-quiet" type="button" :disabled="busy" @click="forgettingOrigin = ''">Cancel</button>
      </template>
    </section>
    <button v-if="owner && !adding" class="button" type="button" :disabled="busy" @click="adding = true">Add Rusty</button>
    <form v-if="owner && adding" @submit.prevent="connect">
      <label for="rusty-address">Address</label>
      <div class="rusty-connect"><input id="rusty-address" v-model="address" aria-label="Address" placeholder="rusty.example" autocomplete="url" required /><button class="button" type="submit" :disabled="busy">Connect</button></div>
      <button class="button button-quiet" type="button" :disabled="busy" @click="adding = false">Cancel</button>
    </form>
    <button v-if="records.some(config => !config.removalPending)" class="button button-quiet" type="button" :disabled="busy" @click="run(controller.syncNow)">Sync now</button>
    <p v-if="failure" class="reading-explanation" role="alert">{{ failure }}</p>

  </section>
</template>
<style src="../styles/design-system/reading-fonts.css"></style>
<style scoped>
.rusty-panel { display: grid; gap: var(--space-3); padding-block: var(--space-2); }
.rusty-panel > .button, form > .button { justify-self: start; }
.rusty-heading { display: flex; align-items: center; gap: var(--space-2); }
h3, p { margin: 0; }
form { display: grid; gap: var(--space-1); }
.rusty-connect { display: flex; gap: var(--space-2); }
input, textarea { min-width: 0; width: 100%; box-sizing: border-box; }
.rusty-connect input { flex: 1; }
textarea { min-height: 5rem; }
.rusty-connections { padding: 0; margin: 0; list-style: none; }
li { display: flex; gap: var(--space-3); align-items: center; justify-content: space-between; padding-block: var(--space-2); }
.rusty-connection { display: grid; gap: var(--space-1); min-width: 0; }
.rusty-connection strong { overflow-wrap: anywhere; }
.rusty-connection span { color: var(--muted); font-size: .85rem; }
.rusty-profile-connection, .rusty-access-update { display: grid; gap: var(--space-2); }
.rusty-conflict { border: 1px solid var(--warning, #b45309); border-radius: 8px; padding: var(--space-2); }
.rusty-conflict p { margin: 0; }
.rusty-access-update > .button { justify-self: start; }
@media (max-width: 480px) { .rusty-connect { flex-direction: column; } }
</style>
