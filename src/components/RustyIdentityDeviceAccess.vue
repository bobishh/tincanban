<script setup lang="ts">
import { computed, ref } from "vue"
import type { BlindReplicationController } from "../app/blindReplication"
const props = defineProps<{ controller: BlindReplicationController; owner: boolean }>()
const pending = ref("")
const failure = ref("")
const failedKeys = ref<string[]>([])
const origins = computed(() => [...new Set([...props.controller.configs.value, ...props.controller.identityConfigs.value]
  .map(config => config.origin))].sort())
const devices = computed(() => props.controller.registeredDevices.value.filter(device =>
  device.deviceId !== props.controller.currentDeviceId.value))
const key = (origin: string, deviceId: string) => `${origin}|${deviceId}`
function revoked(origin: string, deviceId: string) {
  return props.controller.revokedDeviceAccess.value.includes(key(origin, deviceId))
}
function resuming(origin: string, deviceId: string) {
  return props.controller.pendingDeviceRevocations.value.includes(key(origin, deviceId)) || failedKeys.value.includes(key(origin, deviceId))
}
async function remove(origin: string, deviceId: string) {
  const item = key(origin, deviceId)
  if (pending.value || !props.owner || revoked(origin, deviceId)) return
  pending.value = item
  failure.value = ""
  try {
    await props.controller.revokeIdentityDevice(origin, deviceId)
    failedKeys.value = failedKeys.value.filter(value => value !== item)
  } catch (cause) {
    failedKeys.value = [...new Set([...failedKeys.value, item])]
    failure.value = cause instanceof Error ? cause.message : "Rusty access removal is pending"
  } finally { pending.value = "" }
}
</script>
<template>
  <section v-if="owner && origins.length && devices.length" class="rusty-device-access" aria-label="Rusty device access">
    <h4>Approved devices</h4>
    <p class="dialog-copy">Removing a device revokes its identity-wide access to every Rusty connection at that origin. You must own every connected board. Saved boards stay unchanged. Interrupted removals can resume.</p>
    <div v-for="origin in origins" :key="origin" class="rusty-device-origin">
      <strong>{{ origin }}</strong>
      <ul>
        <li v-for="device in devices" :key="device.deviceId">
          <span>{{ device.displayName || 'Unnamed device' }}<small>Added {{ new Date(device.addedAt).toLocaleDateString() }}</small></span>
          <span v-if="revoked(origin, device.deviceId)" class="dialog-copy">Access removed</span>
          <button v-else class="button button-quiet" type="button"
            :aria-label="pending === key(origin, device.deviceId) ? `Removing ${device.displayName || 'unnamed device'} access at ${origin}` : resuming(origin, device.deviceId) ? `Resume ${device.displayName || 'unnamed device'} access removal at ${origin}` : `Remove ${device.displayName || 'unnamed device'} access from all Rusty connections at ${origin}`"
            :disabled="!!pending || controller.busy.value"
            @click="remove(origin, device.deviceId)">{{ pending === key(origin, device.deviceId) ? 'Removing device access…' : resuming(origin, device.deviceId) ? 'Resume removal' : 'Remove device access' }}</button>
        </li>
      </ul>
    </div>
    <p v-if="failure" role="alert">{{ failure }}</p>
  </section>
</template>
<style scoped>
.rusty-device-access { display: grid; gap: var(--space-2); }
.rusty-device-access h4, .rusty-device-access p { margin: 0; }
.rusty-device-origin { display: grid; gap: var(--space-1); }
.rusty-device-origin > strong { overflow-wrap: anywhere; }
.rusty-device-origin ul { padding: 0; margin: 0; list-style: none; }
.rusty-device-origin li { display: flex; gap: var(--space-3); align-items: center; justify-content: space-between; padding-block: var(--space-1); }
.rusty-device-origin li > span:first-child { display: grid; gap: var(--space-1); }
.rusty-device-origin small { color: var(--muted); }
</style>
