<script setup lang="ts">
import { computed, ref } from "vue"
import type { BlindReplicationController } from "../app/blindReplication"
import { profileDeliveryStates, replicaKey, replicaStatus, syncTime } from "../app/blindReplication"
import RustyMark from "./RustyMark.vue"
const props = defineProps<{ controller: BlindReplicationController; workspaceId: string; owner: boolean }>()
const address = ref("")
const adding = ref(false)
const failure = ref("")
const pending = ref(false)
const records = computed(() => props.controller.configs.value.filter(config => config.workspaceId === props.workspaceId))
const profileRecords = computed(() => profileDeliveryStates(props.controller.configs.value, props.controller.identityConfigs.value,
  props.controller.statuses.value, props.workspaceId, props.controller.now.value))
async function run(action: () => Promise<void>) {
  pending.value = true
  failure.value = ""
  try { await action() } catch (cause) { failure.value = props.controller.error.value || (cause instanceof Error ? cause.message : "Rusty connection failed") }
  finally { pending.value = false }
}
async function connect() {
  await run(async () => { await props.controller.attach(address.value, props.workspaceId); address.value = ""; adding.value = false })
}
</script>
<template>
  <section class="rusty-panel" aria-label="Rusty">
    <div class="rusty-heading"><RustyMark compact /><h3>Rusty</h3></div>
    <p class="dialog-copy">Keeps a copy of this board while your devices are offline.</p>
    <ul v-if="records.length" class="rusty-connections">
      <li v-for="config in records" :key="`${config.origin}/${config.scopeId}`">
        <div class="rusty-connection"><strong>{{ config.origin }}</strong><span>{{ replicaStatus(config, controller.statuses.value[replicaKey(config)], controller.now.value) }}</span>
          <small v-if="controller.statuses.value[replicaKey(config)]?.lastSyncedAt">Last sync: <time :datetime="new Date(controller.statuses.value[replicaKey(config)]!.lastSyncedAt!).toISOString()">{{ syncTime(controller.statuses.value[replicaKey(config)]!.lastSyncedAt!) }}</time></small>
          <small v-if="controller.statuses.value[replicaKey(config)]?.error" role="alert">{{ controller.statuses.value[replicaKey(config)]!.error }}</small>
        </div>
        <button v-if="owner" class="button button-quiet" type="button" :disabled="pending || controller.busy.value" @click="run(() => controller.remove(config))">{{ config.removalPending ? 'Retry removal' : 'Remove' }}</button>
      </li>
    </ul>
    <div v-if="profileRecords.length" class="rusty-profile-status" aria-label="Profile delivery">
      <h4>Profile delivery</h4>
      <p class="dialog-copy">Profile photo and private settings sync independently from board data.</p>
      <ul class="rusty-connections">
        <li v-for="profile in profileRecords" :key="profile.key">
          <div class="rusty-connection"><strong>{{ profile.origin }}</strong><span>{{ profile.status }}</span>
            <small v-if="profile.lastSyncedAt">Last sync: <time :datetime="new Date(profile.lastSyncedAt).toISOString()">{{ syncTime(profile.lastSyncedAt) }}</time></small>
            <small v-if="profile.error" role="alert">{{ profile.error }}</small>
            <small v-if="profile.status === 'Profile delivery not configured' && controller.profileSetupErrors.value[profile.origin]" role="alert">{{ controller.profileSetupErrors.value[profile.origin] }}</small>
          </div>
        </li>
      </ul>
    </div>
    <button v-if="owner && !adding" class="button" type="button" :disabled="pending || controller.busy.value" @click="adding = true">Add Rusty</button>
    <form v-if="owner && adding" @submit.prevent="connect">
      <label for="rusty-address">Address</label>
      <div class="rusty-connect"><input id="rusty-address" v-model="address" aria-label="Address" placeholder="rusty.example" autocomplete="url" required /><button class="button" type="submit" :disabled="pending || controller.busy.value">Connect</button></div>
      <button class="button button-quiet" type="button" :disabled="pending || controller.busy.value" @click="adding = false">Cancel</button>
    </form>
    <button v-if="records.some(config => !config.removalPending)" class="button button-quiet" type="button" :disabled="pending || controller.busy.value" @click="run(controller.syncNow)">Sync now</button>
    <p v-if="failure" role="alert">{{ failure }}</p>

  </section>
</template>
<style scoped>
.rusty-panel { display: grid; gap: 12px; padding-block: 8px; }
.rusty-panel > .button, form > .button { justify-self: start; }
.rusty-heading { display: flex; align-items: center; gap: 10px; }
h3, p { margin: 0; }
form { display: grid; gap: 6px; }
.rusty-connect { display: flex; gap: 8px; }
input, textarea { min-width: 0; width: 100%; box-sizing: border-box; }
.rusty-connect input { flex: 1; }
textarea { min-height: 5rem; }
.rusty-connections { padding: 0; margin: 0; list-style: none; }
li { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding-block: 10px; }
.rusty-connection { display: grid; gap: 4px; min-width: 0; }
.rusty-connection strong { overflow-wrap: anywhere; }
.rusty-connection span { color: var(--muted); font-size: .85rem; }
@media (max-width: 480px) { .rusty-connect { flex-direction: column; } }
</style>
