<script setup lang="ts">
import { ref } from "vue"
import type { BrowserRelaySettings } from "../browserRelaySettings"

const props = defineProps<{
  read: () => BrowserRelaySettings
  save: (mode: BrowserRelaySettings["mode"], input: string) => Promise<void>
}>()
const mode = ref<BrowserRelaySettings["mode"]>("public")
const rustAddress = ref("")
const relayAddresses = ref("")
const error = ref("")
const saving = ref(false)

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

try {
  const saved = props.read()
  mode.value = saved.mode
  if (saved.mode === "rusty") rustAddress.value = saved.origin
  if (saved.mode === "custom") relayAddresses.value = saved.urls.join("\n")
} catch (cause) {
  error.value = describeError(cause)
}

async function apply() {
  saving.value = true
  error.value = ""
  try {
    await props.save(mode.value, mode.value === "rusty" ? rustAddress.value : relayAddresses.value)
    location.reload()
  } catch (cause) {
    error.value = describeError(cause)
    saving.value = false
  }
}
</script>

<template>
  <details class="mesh-relay-settings">
    <summary>Mesh relay</summary>
    <form class="mesh-relay-form" aria-label="Mesh relay" @submit.prevent="apply">
      <label>
        Relay mode
        <select v-model="mode" :disabled="saving">
          <option value="public">Public Iroh relay</option>
          <option value="rusty">Rusty relay only</option>
          <option value="custom">Specified relay URLs only</option>
        </select>
      </label>
      <label v-if="mode === 'rusty'">
        Rusty origin
        <input v-model="rustAddress" :disabled="saving" />
      </label>
      <label v-if="mode === 'custom'">
        Relay URLs
        <textarea v-model="relayAddresses" :disabled="saving" rows="3" />
      </label>
      <p class="form-error mesh-relay-message" role="alert">{{ error }}</p>
      <button class="button button-small" type="submit" :disabled="saving">Save and reload</button>
    </form>
  </details>
</template>

<style scoped>
.mesh-relay-settings > summary { cursor: pointer; }
.mesh-relay-form, .mesh-relay-form label { display: grid; gap: var(--space-2); }
.mesh-relay-form { margin-block-start: var(--space-2); }
.mesh-relay-message { min-height: 1lh; margin: 0; }
.mesh-relay-form .button { justify-self: start; }
</style>
