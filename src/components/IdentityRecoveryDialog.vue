<script setup lang="ts">
import { computed, ref } from "vue"
import ModalLayer from "./ModalLayer.vue"
import { createIdentityRecovery, restoreIdentityRecovery, type IdentityRecoveryEnvelope, type IdentitySecurity } from "../domain/identity"

const props = defineProps<{ beforeRestore: () => Promise<void>; displayName: string }>()
const emit = defineEmits<{ close: []; restored: [] }>()
const security = ref<IdentitySecurity>("better")
const task = ref<"backup" | "restore">("backup")
const generatedWords = ref("")
const restoreWords = ref("")
const generated = ref<IdentityRecoveryEnvelope | null>(null)
const envelopeText = ref("")
const replace = ref(false)
const error = ref("")
const busy = ref(false)
const wordCount = computed(() => generatedWords.value.trim().split(/\s+/u).filter(Boolean).length)

function downloadEnvelope(envelope: IdentityRecoveryEnvelope) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "tincanban-identity-recovery.json"
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

async function generate() {
  busy.value = true; error.value = ""
  try {
    const backup = await createIdentityRecovery(security.value)
    generatedWords.value = backup.recoveryKey
    generated.value = backup.recoveryEnvelope
    downloadEnvelope(backup.recoveryEnvelope)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not create recovery backup" }
  finally { busy.value = false }
}

async function restore() {
  busy.value = true; error.value = ""
  try {
    const envelope = JSON.parse(envelopeText.value) as IdentityRecoveryEnvelope
    await restoreIdentityRecovery(envelope, restoreWords.value, props.displayName, replace.value, props.beforeRestore)
    emit("restored")
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not restore identity" }
  finally { busy.value = false }
}

async function loadRecoveryFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  envelopeText.value = ""
  error.value = ""
  replace.value = false
  try {
    const text = await file.text()
    JSON.parse(text)
    envelopeText.value = text
  } catch { error.value = "Choose a valid recovery JSON file." }
}
</script>

<template>
  <ModalLayer :busy="busy" class="overlay-level-120" @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Identity recovery">
      <div class="dialog-head"><h2>Back up or restore your identity</h2><button class="icon-button" type="button" aria-label="Close" :disabled="busy" @click="emit('close')">×</button></div>
      <p class="dialog-copy">Your recovery file and words restore your tincanban identity, not workspace or board content. Keep both somewhere safe and separate.</p>
      <div class="dialog-actions" role="group" aria-label="Identity recovery tasks">
        <button class="button" :class="task === 'backup' ? 'button-primary' : 'button-quiet'" :aria-pressed="task === 'backup'" :disabled="busy" @click="task = 'backup'; error = ''">Create backup</button>
        <button class="button" :class="task === 'restore' ? 'button-primary' : 'button-quiet'" :aria-pressed="task === 'restore'" :disabled="busy" @click="task = 'restore'; error = ''">Restore from backup</button>
      </div>
      <section v-if="task === 'backup'" class="mesh-member-action">
        <label>Recovery length <select v-model="security" :disabled="busy"><option value="better">12 words</option><option value="insane">24 words</option></select></label>
        <button class="button button-primary" type="button" :disabled="busy" @click="generate">Generate and download recovery file</button>
        <p v-if="generated" class="dialog-copy"><strong>Write down these {{ wordCount }} words now:</strong><br><code class="recovery-words">{{ generatedWords }}</code><br>The encrypted recovery file was downloaded.</p>
      </section>
      <section v-else class="mesh-member-action">
        <label>Recovery words<textarea v-model="restoreWords" :disabled="busy" class="technical-text" rows="3" autocomplete="off" /></label>
        <label>Recovery file<input type="file" :disabled="busy" accept="application/json" @change="loadRecoveryFile" /></label>
        <label><input v-model="replace" :disabled="busy" type="checkbox" /> I understand this can replace the identity on this device. My local board data stays here.</label>
        <button class="button button-danger" type="button" :disabled="busy || !replace || !envelopeText || !restoreWords.trim()" @click="restore">Restore identity</button>
      </section>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </section>
  </ModalLayer>
</template>
