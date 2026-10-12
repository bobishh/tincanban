<script setup lang="ts">
import { defineAsyncComponent, ref, watch, type Component } from "vue"

const TelemetrySettingsPanel = defineAsyncComponent<Component>(() => import("./TelemetrySettingsPanel.vue"))
const TelemetryDeliveryPanel = defineAsyncComponent<Component>(() => import("./TelemetryDeliveryPanel.vue"))

const props = defineProps<{ displayName: string; saveName: (value: string) => Promise<void> }>()
const emit = defineEmits<{ recovery: [] }>()
const name = ref(props.displayName)
const saving = ref(false)
const error = ref("")
watch(() => props.displayName, value => { name.value = value })

async function save() {
  const value = name.value.trim()
  if (!value || saving.value) return
  saving.value = true
  error.value = ""
  try {
    await props.saveName(value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not save identity name"
  } finally {
    saving.value = false
  }
}

</script>

<template>
  <section aria-label="Identity settings">
    <form class="mesh-member-action identity-name-form" @submit.prevent="save">
      <label>Name<input v-model="name" maxlength="48" :disabled="saving" /></label>
      <button class="button button-primary" type="submit" :disabled="saving || !name.trim()">Save name</button>
    </form>
    <section class="mesh-member-action" aria-label="Identity recovery">
      <h3>Identity recovery</h3>
      <p class="dialog-copy">Create an encrypted identity backup or restore one on this device.</p>
      <button class="button" type="button" @click="emit('recovery')">Recovery backup</button>
    </section>
    <TelemetrySettingsPanel />
    <TelemetryDeliveryPanel />
    <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.identity-name-form label { display: grid; gap: 7px; min-width: 0; }
.identity-name-form input, .identity-name-form .button { box-sizing: border-box; width: 100%; min-height: 46px; }
</style>
