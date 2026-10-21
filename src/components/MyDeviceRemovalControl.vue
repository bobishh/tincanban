<script setup lang="ts">
import { computed, ref, shallowRef } from "vue"
import { deviceDisplayName } from "../ui/deviceInfo"
import DialogWindow from "./DialogWindow.vue"
import { myDeviceRemovalComplete } from "../app/useMyDeviceRemoval"
import type { useMyDeviceRemoval, PreparedDeviceRemoval } from "../app/useMyDeviceRemoval"
const props = defineProps<{ deviceId: string; name: string; workspaceId?: string; controller: ReturnType<typeof useMyDeviceRemoval> }>()
const confirming = ref(false)
const failure = ref("")
const preparing = ref(false)
const prepared = shallowRef<PreparedDeviceRemoval | null>(null)
const abandoningOrigin = ref("")
const job = computed(() => props.controller.jobs.value.find(value => value.deviceId === props.deviceId))
const complete = computed(() => !!job.value && myDeviceRemovalComplete(job.value))
const additionalOrigins = computed(() => {
  if (!job.value) return []
  return [...new Set([...props.controller.origins.value])].filter(origin => !job.value!.origins[origin])
})
async function review() {
  confirming.value = true
  preparing.value = true
  prepared.value = null
  failure.value = ""
  try { prepared.value = await props.controller.prepare(props.deviceId, complete.value && additionalOrigins.value.length > 0) }
  catch (cause) { failure.value = cause instanceof Error ? cause.message : "Could not review device removal scope" }
  finally { preparing.value = false }
}
async function remove() {
  if (!prepared.value) return
  failure.value = ""
  try { await props.controller.remove(prepared.value); confirming.value = false }
  catch (cause) { failure.value = cause instanceof Error ? cause.message : "Device removal pending" }
}
async function reviewServerStop(origin: string) {
  abandoningOrigin.value = origin
  preparing.value = true
  prepared.value = null
  failure.value = ""
  try { prepared.value = await props.controller.prepare(props.deviceId) }
  catch (cause) { failure.value = cause instanceof Error ? cause.message : "Could not review server removal" }
  finally { preparing.value = false }
}
async function stopServerRemoval() {
  if (!prepared.value || !abandoningOrigin.value) return
  failure.value = ""
  try { await props.controller.abandonOrigin(prepared.value, abandoningOrigin.value); abandoningOrigin.value = "" }
  catch (cause) { failure.value = cause instanceof Error ? cause.message : "Could not stop server removal" }
}
</script>
<template>
  <div class="my-device-removal">
    <p v-if="complete" class="dialog-copy" role="status">{{ job?.abandonedOrigins?.length ? 'Removal finished for the remaining listed scopes. Server access is not confirmed revoked for stopped removals.' : 'Access revoked in listed workspaces and Rusty servers. Device record retained; existing copies cannot be erased.' }}</p>
    <template v-if="job">
      <p v-for="(error, id) in job.workspaceErrors" :key="id" class="sync-error" role="alert">Workspace {{ id }} requires action: {{ error }}</p>
      <ul aria-label="Device removal progress">
        <li v-for="(state, id) in job.workspaces" :key="id"><code>{{ id }}</code> · {{ state === 'removed' ? 'Workspace access revoked' : 'Workspace removal pending' }}</li>
        <li v-for="(state, origin) in job.origins" :key="origin"><span>{{ origin }}</span> · {{ state.status === 'removed' ? 'Rusty access revoked' : 'Rusty removal pending' }}<small v-if="state.error" role="alert">{{ state.error }}</small><button v-if="state.status === 'pending'" class="button button-quiet" type="button" :disabled="!!controller.pending.value" @click="reviewServerStop(String(origin))">Stop retrying this server</button></li>
        <li v-for="origin in job.abandonedOrigins" :key="`stopped:${origin}`">{{ origin }} · Removal stopped on this device</li>
      </ul>
    </template>
    <p v-if="additionalOrigins.length" class="sync-error" role="status">Servers outside this recorded removal: {{ additionalOrigins.join(', ') }}. {{ complete ? 'Confirm additional removal to include them.' : 'Finish the recorded removal first.' }}</p>
    <button v-if="!complete || additionalOrigins.length" class="button button-danger" type="button" :disabled="!!controller.pending.value" @click="review">{{ controller.pending.value === deviceId ? 'Removing my device…' : complete && additionalOrigins.length ? 'Remove additional device access' : job ? 'Retry device removal' : 'Remove my device' }}</button>
    <DialogWindow v-if="confirming" :window-id="`my-device-removal:${deviceId}`" :workspace-id="workspaceId ?? 'local'" :title="`Remove ${deviceDisplayName({ deviceId, name })}?`" aria-label="Remove my device confirmation" :busy="!!controller.pending.value" @close="confirming = false">
      <section class="dialog dialog-window-content">
        <p>The listed workspace and server scopes are frozen for this confirmation. This device loses access in those scopes. Rusty revocation requires ownership of its connected boards. Owner, key, or offline-server failures remain visible for action and retry.</p>
        <p>Your identity, other devices, and boards stay saved. Existing copies cannot be erased. Signed revocations and this device record are retained. Access outside the listed scopes is not confirmed revoked.</p>
        <code>{{ deviceId }}</code>
        <p v-if="preparing" role="status">Reviewing device removal scope…</p>
        <ul v-if="prepared" aria-label="Confirmed device removal scope">
          <li v-for="(_, id) in prepared.job.workspaces" :key="id">{{ prepared.job.workspaceTitles?.[id] || id }} · <code>{{ id }}</code></li>
          <li v-for="(_, origin) in prepared.job.origins" :key="origin">{{ origin }}</li>
        </ul>
        <div class="dialog-actions">
          <button class="button button-danger" type="button" :disabled="preparing || !prepared || !!controller.pending.value" @click="remove">{{ controller.pending.value ? 'Removing my device…' : 'Confirm removal of my device' }}</button>
          <button class="button" type="button" :disabled="!!controller.pending.value" @click="confirming = false">Cancel</button>
        </div>
        <p v-if="failure" class="sync-error" role="alert">{{ failure }}</p>
      </section>
    </DialogWindow>
    <DialogWindow v-if="abandoningOrigin" :window-id="`stop-device-removal:${deviceId}`" :workspace-id="workspaceId ?? 'local'" title="Stop server removal?" aria-label="Stop server removal confirmation" :busy="!!controller.pending.value" @close="abandoningOrigin = ''">
      <section class="dialog dialog-window-content">
        <p>{{ abandoningOrigin }}</p>
        <p>Stop this saved removal attempt on this device. Keep its history and your current Rusty connection. Server access is not confirmed revoked.</p>
        <div class="dialog-actions">
          <button class="button" type="button" :disabled="preparing || !prepared || !!controller.pending.value" @click="stopServerRemoval">Stop retrying</button>
          <button class="button button-quiet" type="button" :disabled="!!controller.pending.value" @click="abandoningOrigin = ''">Cancel</button>
        </div>
        <p v-if="failure" class="sync-error" role="alert">{{ failure }}</p>
      </section>
    </DialogWindow>
    <p v-if="failure && !confirming && !abandoningOrigin" class="sync-error" role="alert">{{ failure }}</p>
  </div>
</template>
<style scoped>
.my-device-removal { display: grid; gap: var(--space-2); }
.my-device-removal > .button { justify-self: start; }
p { margin: 0; }
ul { margin: 0; padding-inline-start: var(--space-4); }
li, code { overflow-wrap: anywhere; }
small { display: block; }
</style>
