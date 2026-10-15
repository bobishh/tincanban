<script setup lang="ts">
import { defineAsyncComponent, computed, type Component } from "vue"
import { useAutomations, type AutomationWorkspace } from "../app/useAutomations"
import { telemetryConfig } from "../app/diagnostics"
import { serviceLogsUrl } from "../app/serviceLogsUrl"
import AutomationsPanel from "./AutomationsPanel.vue"
import type { BlindReplicationController } from "../app/blindReplication"
import type { MeshMemberView } from "../ui/deviceInfo"
const TelemetrySettingsPanel = defineAsyncComponent<Component>(() => import("./TelemetrySettingsPanel.vue"))
const TelemetryDeliveryPanel = defineAsyncComponent<Component>(() => import("./TelemetryDeliveryPanel.vue"))
const props = defineProps<{
  workspace: AutomationWorkspace; workspaceId: string; controller: BlindReplicationController; owner: boolean
  presence: string; saveState: "idle" | "saving" | "saved" | "error"; accessRole?: string; diagnostic?: string; members: MeshMemberView[]
}>()
const automations = useAutomations(props.workspace, props.controller, () => props.owner)
const logsUrl = computed(() => props.accessRole === "owner" || props.accessRole === "editor" ? serviceLogsUrl(telemetryConfig(), props.workspaceId) : undefined)
</script>
<template>
  <section class="workspace-status" aria-label="Workspace status">
    <h4>Board status</h4>
    <p role="status">{{ saveState === 'error' ? 'Changes could not be saved on this device.' : saveState === 'saving' ? 'Saving changes on this device…' : 'Changes saved on this device.' }}</p>
    <p>{{ presence }}</p>
    <p v-if="diagnostic" class="sync-error" role="status">{{ diagnostic }} Changes saved on this device stay available. Open Sync to check the connection.</p>
  </section>
  <slot />
  <AutomationsPanel :management="automations" :owner="owner" />
  <section class="workspace-diagnostics ui-stack" aria-label="Workspace diagnostics">
    <h4>Diagnostics</h4>
    <TelemetrySettingsPanel />
    <TelemetryDeliveryPanel />
    <a v-if="logsUrl" :href="logsUrl" target="_blank" rel="noopener">Open board logs</a>
    <details v-if="members.length">
      <summary>Device information for support</summary>
      <div v-for="member in members" :key="member.personId">
        <p>{{ member.name }}</p>
        <div v-for="device in member.deviceList" :key="device.deviceId" class="mesh-device-ua">
          <small>{{ device.name }} · {{ device.deviceId }}</small>
          <code v-if="device.userAgent">User agent: {{ device.userAgent }}</code>
        </div>
      </div>
    </details>
  </section>
</template>
<style scoped>
.workspace-status, .workspace-diagnostics { display: grid; gap: var(--space-2); }
h4, p { margin: 0; }
.workspace-diagnostics { padding-top: var(--space-4); border-top: 1px solid var(--soft); }
.workspace-diagnostics details { font-size: .9rem; overflow-wrap: anywhere; }
.workspace-diagnostics code { display: block; white-space: normal; }
</style>
