<script setup lang="ts">
import { computed } from "vue"
import type { BlindReplicationController } from "../app/blindReplication"
const props = defineProps<{ controller: BlindReplicationController }>()
const issues = computed(() => [...new Set(Object.values(props.controller.deviceSyncIssues?.value ?? {}))])
</script>

<template>
  <section v-if="issues.length" aria-label="Device sync problem">
    <h3>Sync on this device</h3>
    <p v-for="issue in issues" :key="issue" class="dialog-copy" role="alert">{{ issue }}</p>
    <button class="button" type="button" :disabled="controller.busy.value" @click="controller.syncNow()">Retry sync</button>
  </section>
</template>
