<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { telemetryConfig, telemetryConfigured, setTelemetryEnabled, subscribeTelemetryConfig } from "../app/diagnostics"
const configured = telemetryConfigured()
const enabled = ref(telemetryConfig().enabled)
const error = ref("")
onBeforeUnmount(subscribeTelemetryConfig(() => { enabled.value = telemetryConfig().enabled }))
function change(event: Event) {
  error.value = ""
  try { setTelemetryEnabled((event.target as HTMLInputElement).checked) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not save diagnostic preference." }
  ;(event.target as HTMLInputElement).checked = telemetryConfig().enabled
}
</script>
<template>
  <section v-if="configured" class="mesh-member-action" aria-label="Device diagnostics">
    <label class="telemetry-toggle"><input :checked="enabled" type="checkbox" @change="change" />Send diagnostics from this device</label>
    <p class="dialog-copy">Connection diagnostics include record and device IDs, never card or message content. Your choice applies to this device across workspaces.</p>
    <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.telemetry-toggle { display: flex; align-items: center; gap: var(--space-2); }
</style>
