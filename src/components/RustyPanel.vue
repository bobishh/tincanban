<script setup lang="ts">
import { computed, ref } from "vue"
import type { BlindReplicationController, RustyRemovalProgress } from "../app/blindReplication"
import { syncTime } from "../app/blindReplication"
import { rustyConnectionStates } from "../app/rustyConnectionStatus"
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
const connections = computed(() => rustyConnectionStates(props.controller.configs.value, props.controller.identityConfigs.value,
  props.controller.statuses.value, props.workspaceId, props.owner, props.controller.now.value))
const servers = computed(() => {
  const rows = new Map(connections.value.map(connection => [connection.origin, connection]))
  for (const value of [...boardConflicts.value, ...profileConflicts.value, ...savedOperations.value]) {
    if (!rows.has(value.origin)) rows.set(value.origin, { origin: value.origin, status: "Not checked", errors: [] })
  }
  return [...rows.values()].map(row => ({ ...row,
    status: conflictsFor(row.origin).length ? "Settings conflict"
      : savedOperations.value.some(operation => operation.origin === row.origin) ? "Recovery pending"
      : props.controller.profilePermissionUpdates?.value.includes(row.origin) ? "Access required" : row.status,
    name: rows.size === 1 ? "Rusty" : new URL(row.origin).host,
  }))
})
function configsFor(origin: string) { return records.value.filter(config => config.origin === origin) }
function conflictsFor(origin: string) {
  return [...new Map([...boardConflicts.value, ...profileConflicts.value]
    .filter(conflict => conflict.origin === origin).map(conflict => [conflict.scopeId, conflict])).values()]
}
async function run(action: () => Promise<void>) {
  pending.value = true
  failure.value = ""
  try { await action() } catch (cause) { failure.value = props.controller.error.value || (cause instanceof Error ? cause.message : "Rusty connection failed") }
  finally { pending.value = false }
}
async function connect() {
  await run(async () => {
    const result = await props.controller.addRustyConnection(address.value, props.workspaceId)
    if (result.kind === "identity-consent") { window.location.assign(result.portalUrl); return }
    address.value = ""
    adding.value = false
  })
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
    <ul v-if="servers.length" class="rusty-connections">
      <li v-for="server in servers" :key="server.origin">
        <details class="rusty-server">
          <summary class="rusty-connection">
            <RustyMark compact /><strong>{{ server.name }}</strong>
            <span class="rusty-status" :class="{ 'is-synced': server.status === 'Synced' }" role="status">{{ server.status }}</span>
            <span class="rusty-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="rusty-server-details">
            <code class="technical-value">{{ server.origin }}</code>
            <time v-if="server.lastSyncedAt" :datetime="new Date(server.lastSyncedAt).toISOString()">{{ syncTime(server.lastSyncedAt) }}</time>
            <p v-for="config in owner ? [] : configsFor(server.origin).filter(value => value.boardAccess)" :key="config.scopeId">{{ config.boardAccess?.mode === 'write' ? 'Board access · read and write' : 'Board access · read only' }}</p>
            <p v-for="message in server.errors" :key="message" role="alert">{{ message }}</p>
            <p v-if="controller.profileSetupErrors.value[server.origin]" role="alert">{{ controller.profileSetupErrors.value[server.origin] }}</p>
            <div v-for="conflict in conflictsFor(server.origin)" :key="conflict.scopeId" class="rusty-conflict" role="alert" aria-label="Rusty settings conflict">
              <p>Connection paused. Saved changes are retained. Every previous key and saved upload stays available.</p>
              <RustyCredentialConflictRecovery :origin="server.origin" :scope-id="conflict.scopeId" :workspace-id="workspaceId" :owner="owner" :disabled="busy" :recover="controller.recoverCredentialConflict" />
            </div>
            <section v-for="operation in owner ? savedOperations.filter(value => value.origin === server.origin) : []" :key="operation.origin" class="rusty-conflict" aria-label="Saved Rusty operation">
              <p>{{ operation.kind === 'device-revocation' ? 'Device removal pending' : 'Connection recovery pending' }}</p>
              <p v-if="operation.kind === 'device-revocation'">{{ deviceDisplayName({ deviceId: operation.deviceId, name: controller.registeredDevices?.value.find(device => device.deviceId === operation.deviceId)?.displayName }) }}</p>
              <p v-if="operation.progress">{{ removalSteps[operation.progress.phase] }}</p>
              <details v-if="operation.progress"><summary>Recovery details</summary><p>{{ operation.progress.confirmedScopes }} / {{ operation.progress.scopeCount }} storage updates confirmed. {{ operation.progress.frozenWorkers }} / {{ operation.progress.workerCount }} automations paused; {{ operation.progress.rotatedWorkers }} updated. Device revocation confirmed: {{ operation.progress.personConfirmed ? 'yes' : 'no' }}.</p></details>
              <p v-if="operation.signerDeviceId !== controller.currentDeviceId.value">Continue on the device that started this operation.</p>
              <button class="button" type="button" :disabled="busy || operation.signerDeviceId !== controller.currentDeviceId.value" @click="run(() => controller.resumeRustyOperation(operation.origin))">Resume</button>
            </section>
            <button v-if="owner && controller.profilePermissionUpdates?.value.includes(server.origin)" class="button" type="button" :disabled="busy" @click="updateDeviceAccess(server.origin)">{{ updatingOrigin === server.origin ? 'Updating…' : 'Update access' }}</button>
            <button v-if="owner && (!configsFor(server.origin).length || server.status === 'Setup required')" class="button" type="button" :disabled="busy" @click="address = server.origin; connect()">Connect</button>
            <button v-for="config in owner ? configsFor(server.origin) : []" :key="config.scopeId" class="button button-quiet" type="button" :disabled="busy" @click="run(() => controller.remove(config))">{{ config.removalPending ? 'Retry removal' : 'Disconnect this board' }}</button>
            <section v-if="forgettingOrigin === server.origin" class="rusty-local-access" aria-label="Forget local Rusty access">
              <p>Forget {{ server.origin }} for all your boards on this device? Saved data and an audit copy of old settings stay saved. Server data and other participants are unchanged.</p>
              <button class="button button-danger" type="button" :disabled="busy" @click="forget">Confirm forget Rusty</button>
              <button class="button button-quiet" type="button" :disabled="busy" @click="forgettingOrigin = ''">Cancel</button>
            </section>
            <button v-else class="button button-quiet" type="button" :disabled="busy" @click="forgettingOrigin = server.origin">Forget Rusty on this device</button>
          </div>
        </details>
      </li>
    </ul>
    <div v-else class="rusty-empty"><RustyMark compact /><strong>Rusty</strong><span>P2P only</span></div>
    <div class="rusty-actions">
      <button v-if="records.some(config => !config.removalPending)" class="button button-quiet" type="button" :disabled="busy" @click="run(controller.syncNow)">Sync now</button>
      <button v-if="owner && !adding && !servers.length" class="button" type="button" :disabled="busy" @click="adding = true">Add Rusty</button>
      <details v-if="owner && servers.length && !adding" class="rusty-additional"><summary>Connection settings</summary><button class="button" type="button" :disabled="busy" @click="adding = true">Add Rusty</button></details>
      <form v-if="owner && adding" @submit.prevent="connect">
        <label for="rusty-address">Address</label>
        <div class="rusty-connect"><input id="rusty-address" v-model="address" aria-label="Address" placeholder="rusty.example" autocomplete="url" required /><button class="button" type="submit" :disabled="busy">Connect</button></div>
        <button class="button button-quiet" type="button" :disabled="busy" @click="adding = false">Cancel</button>
      </form>
    </div>
    <p v-if="failure" role="alert">{{ failure }}</p>
  </section>
</template>
<style scoped>
.rusty-panel { display: grid; align-content: start; gap: var(--space-2); }
.rusty-connections { padding: 0; margin: 0; list-style: none; }
.rusty-connections > li + li { margin-top: var(--space-2); }
.rusty-server { border: 1px solid var(--line); }
.rusty-connection { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-2); min-block-size: var(--control-size); padding: var(--space-2); cursor: pointer; list-style: none; }
.rusty-connection::-webkit-details-marker { display: none; }
.rusty-status { min-inline-size: 10ch; text-align: end; }
.rusty-status.is-synced { color: var(--success, #166534); }
.rusty-chevron { transition: transform .15s; }
.rusty-server[open] > summary .rusty-chevron { transform: rotate(180deg); }
.rusty-server-details { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2); border-top: 1px solid var(--line); }
.rusty-server-details > code, .rusty-server-details > p, .rusty-conflict, .rusty-local-access { flex-basis: 100%; }
.technical-value { overflow-wrap: anywhere; min-width: 0; }
.rusty-actions, .rusty-empty { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.rusty-actions > form { flex-basis: 100%; }
.rusty-additional > .button { margin-top: var(--space-2); }
p { margin: 0; }
form { display: grid; gap: var(--space-1); }
.rusty-connect { display: flex; gap: var(--space-2); }
input { min-width: 0; width: 100%; box-sizing: border-box; flex: 1; }
.rusty-panel .button { min-height: var(--control-size-compact); padding: var(--space-1) var(--space-3); }
.rusty-conflict { border: 1px solid var(--warning, #b45309); padding: var(--space-2); }
@media (max-width: 480px) { .rusty-connect { flex-direction: column; } }
</style>
