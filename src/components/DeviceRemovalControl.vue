<script setup lang="ts">
import DialogWindow from "./DialogWindow.vue"
import { computed, ref } from "vue"
const props = defineProps<{
  personId: string; deviceId: string; name: string; activeWorkspaceId?: string
  removableDeviceWorkspaces?: (personId: string, deviceId: string) => Promise<{ id: string; title: string }[]>
  removeDevice?: (personId: string, deviceId: string, workspaceIds: string[]) => Promise<void>
}>()
const deviceRemoval = ref<{ personId: string; deviceId: string; name: string; workspaceId?: string; workspaces: { id: string; title: string }[] } | null>(null)
const removalScope = ref("current")
const deviceRemovalError = ref("")
const removingDevice = ref(false)
const removalWorkspaces = computed(() => deviceRemoval.value?.workspaces.filter(workspace => removalScope.value === "all" || workspace.id === deviceRemoval.value?.workspaceId) ?? [])
async function prepareDeviceRemoval(personId: string, deviceId: string, name: string) {
  deviceRemovalError.value = ""
  try {
    const workspaces = await props.removableDeviceWorkspaces?.(personId, deviceId) ?? []
    deviceRemoval.value = { personId, deviceId, name, workspaceId: props.activeWorkspaceId, workspaces }
    removalScope.value = "current"
  } catch (error) { deviceRemovalError.value = error instanceof Error ? error.message : String(error) }
}
async function confirmDeviceRemoval() {
  const removal = deviceRemoval.value
  if (!removal || !props.removeDevice || removingDevice.value) return
  removingDevice.value = true
  try {
    await props.removeDevice(removal.personId, removal.deviceId, removalWorkspaces.value.map(workspace => workspace.id))
    deviceRemoval.value = null
  } catch (error) { deviceRemovalError.value = error instanceof Error ? error.message : String(error) }
  finally { removingDevice.value = false }
}

</script>
<template>
  <div>
    <button class="button button-danger" type="button" @click="prepareDeviceRemoval(personId, deviceId, name)">Remove device</button>
        <DialogWindow v-if="deviceRemoval" :window-id="`device-removal:${deviceRemoval.personId}:${deviceRemoval.deviceId}`" :workspace-id="activeWorkspaceId ?? 'local'" :title="`Remove ${deviceRemoval.name}?`" aria-label="Confirm device removal" :busy="removingDevice" @close="deviceRemoval = null">
            <section class="dialog dialog-window-content">
          <p class="dialog-copy">This device loses access. Your identity, other devices, and their memberships stay intact. Existing copies cannot be erased remotely. To reconnect this device, enroll it with a new device identity.</p>
          <label><input v-model="removalScope" type="radio" value="current" :disabled="removingDevice"> Only this workspace</label>
          <label><input v-model="removalScope" type="radio" value="all" :disabled="removingDevice"> All workspaces I can manage for this device</label>
          <ul><li v-for="workspace in removalWorkspaces" :key="workspace.id">{{ workspace.title }}</li></ul>
          <p v-if="!removalWorkspaces.length">No eligible workspaces in this scope.</p>
          <button class="button button-danger" type="button" :disabled="removingDevice || !removalWorkspaces.length" @click="confirmDeviceRemoval">{{ removingDevice ? 'Removing…' : 'Confirm removal' }}</button>
          <button class="button" type="button" :disabled="removingDevice" @click="deviceRemoval = null">Cancel</button>
          <p v-if="deviceRemovalError" class="sync-error" role="alert">{{ deviceRemovalError }}</p>
            </section>
        </DialogWindow>
        <p v-if="deviceRemovalError && !deviceRemoval" class="sync-error" role="alert">{{ deviceRemovalError }}</p>
  </div>
</template>
<style scoped>
h2 { margin: 0 0 var(--space-4); }
label { display: block; margin: var(--space-3) 0; }
p { margin: var(--space-3) 0; line-height: 1.5; }
ul { margin: var(--space-3) 0; padding-left: var(--space-4); }
.button { margin: var(--space-1) var(--space-2) var(--space-1) 0; }
[role="alert"] { color: var(--accent); }
</style>
