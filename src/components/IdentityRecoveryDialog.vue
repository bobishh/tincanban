<script setup lang="ts">
import { computed, ref } from "vue"
import ModalLayer from "./ModalLayer.vue"
import type { IdentitySecurity } from "../domain/identity"
import { createIdentityDeviceRecovery, restoreIdentityDeviceRecovery, maximumIdentityRecoveryFileBytes,
  parseIdentityRecoveryFile, type IdentityDeviceRecoveryFile, type IdentityRecoveryFile } from "../app/identityRecovery"

const props = defineProps<{ beforeRestore: () => Promise<void>; displayName: string }>()
const emit = defineEmits<{ close: []; restored: [] }>()
const security = ref<IdentitySecurity>("better")
const task = ref<"backup" | "restore">("backup")
const generatedWords = ref("")
const restoreWords = ref("")
const generated = ref<IdentityDeviceRecoveryFile | null>(null)
const envelopeText = ref("")
const loadedFile = ref<IdentityRecoveryFile | null>(null)
const replace = ref(false)
const error = ref("")
const busy = ref(false)
let fileRequest = 0
const wordCount = computed(() => generatedWords.value.trim().split(/\s+/u).filter(Boolean).length)

function downloadEnvelope(envelope: IdentityDeviceRecoveryFile) {
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
    const backup = await createIdentityDeviceRecovery(security.value)
    generatedWords.value = backup.recoveryKey
    generated.value = backup.file
    downloadEnvelope(backup.file)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not create recovery backup" }
  finally { busy.value = false }
}

async function restore() {
  busy.value = true; error.value = ""
  try {
    const envelope = parseIdentityRecoveryFile(envelopeText.value)
    await restoreIdentityDeviceRecovery(envelope, restoreWords.value, props.displayName, replace.value, props.beforeRestore)
    emit("restored")
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not restore identity" }
  finally { busy.value = false }
}

async function loadRecoveryFile(event: Event) {
  const request = ++fileRequest
  const file = (event.target as HTMLInputElement).files?.[0]
  envelopeText.value = ""
  loadedFile.value = null
  error.value = ""
  replace.value = false
  if (!file) return
  try {
    if (file.size > maximumIdentityRecoveryFileBytes) throw new Error("Recovery file exceeds size limit.")
    const text = await file.text()
    const parsed = parseIdentityRecoveryFile(text)
    if (request !== fileRequest) return
    loadedFile.value = parsed
    envelopeText.value = text
  } catch (cause) {
    if (request !== fileRequest) return
    error.value = cause instanceof Error && /upgrade|update|size limit/i.test(cause.message)
      ? cause.message : "Choose a valid recovery JSON file."
  }
}
</script>

<template>
  <ModalLayer :busy="busy" class="overlay-level-120" @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Identity recovery">
      <div class="dialog-head"><h2>Back up or restore your identity</h2><button class="icon-button" type="button" aria-label="Close" :disabled="busy" @click="emit('close')">×</button></div>
      <p class="dialog-copy">Your encrypted recovery file and words restore your identity, profile and private Rusty connections. Board and attachment bytes need a separate workspace backup or an available Rusty copy. Keep the file and words safe and separate.</p>
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
        <p v-if="loadedFile?.kind === 'mesh-identity-recovery'" class="dialog-copy" role="status">This older file restores your identity key only. It does not contain your profile, workspace references or private Rusty connections.</p>
        <label><input v-model="replace" :disabled="busy" type="checkbox" /> I understand this can replace the identity on this device. My local board data stays here.</label>
        <button class="button button-danger" type="button" :disabled="busy || !replace || !envelopeText || !restoreWords.trim()" @click="restore">Restore identity</button>
      </section>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </section>
  </ModalLayer>
</template>
