<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { telemetryConfigured, telemetryStatus, subscribeTelemetryStatus } from "../app/diagnostics"
const configured = telemetryConfigured()
const status = ref(telemetryStatus())
onBeforeUnmount(subscribeTelemetryStatus(() => { status.value = telemetryStatus() }))
</script>
<template>
  <section v-if="configured" aria-label="Diagnostic delivery">
    <h3>Diagnostic delivery</h3>
    <p role="status" aria-label="Diagnostic delivery">{{ status.state }} · {{ status.queued }} queued · {{ status.dropped }} dropped<span v-if="status.lastSentAt"> · Last confirmed: {{ new Date(status.lastSentAt).toLocaleString() }}</span></p>
    <p v-if="status.error" class="sync-error" role="alert">{{ status.error }}</p>
  </section>
</template>
