<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { retryTelemetry, telemetryConfigured, telemetryStatus, subscribeTelemetryStatus } from "../app/diagnostics"
const configured = telemetryConfigured()
const status = ref(telemetryStatus())
onBeforeUnmount(subscribeTelemetryStatus(() => { status.value = telemetryStatus() }))
</script>
<template>
  <section v-if="configured" aria-label="Diagnostic delivery">
    <p role="status" aria-label="Diagnostic delivery">{{ status.state === 'disabled' ? 'Diagnostics disabled on this device.' : status.state === 'error' ? 'OpenTelemetry export failed.' : status.state === 'pending' ? 'Waiting to export diagnostics.' : status.state === 'sending' ? 'Exporting diagnostics…' : status.lastSentAt ? 'Last OTLP response received.' : 'Ready to export diagnostics.' }}</p>
    <p v-if="status.error" class="sync-error" role="alert">{{ status.error }}</p>
    <button v-if="status.state === 'error' || status.state === 'pending'" class="button button-small" type="button" @click="retryTelemetry">{{ status.state === 'error' ? 'Resume diagnostics' : 'Retry diagnostics' }}</button>
    <details><summary>Delivery history</summary><p>{{ status.queued }} queued · {{ status.dropped }} discarded<span v-if="status.lastSentAt"> · Last OTLP response: {{ new Date(status.lastSentAt).toLocaleString() }}</span></p></details>
  </section>
</template>
