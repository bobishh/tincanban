<script setup lang="ts">
import { defineAsyncComponent, ref, watch, type Component } from "vue"

const IdentityPhotoPanel = defineAsyncComponent<Component>(() => import("./IdentityPhotoPanel.vue"))

const props = defineProps<{ displayName: string; saveName: (value: string) => Promise<void>; avatarData?: string; saveAvatar: (value: string | null) => Promise<void> }>()
const emit = defineEmits<{ recovery: [] }>()
const name = ref(props.displayName)
const saving = ref(false)
const avatarDraft = ref<string | null | undefined>(undefined)
const saved = ref(false)
const error = ref("")
watch(() => props.displayName, value => { name.value = value })

async function save() {
  const value = name.value.trim()
  if (!value || saving.value) return
  saving.value = true
  error.value = ""
  saved.value = false
  try {
    if (value !== props.displayName) await props.saveName(value)
    if (avatarDraft.value !== undefined) { await props.saveAvatar(avatarDraft.value); avatarDraft.value = undefined }
    saved.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not save profile"
  } finally {
    saving.value = false
  }
}

</script>

<template>
  <section class="identity-settings" aria-label="Identity settings">
    <form class="identity-profile" role="group" aria-label="Your profile" @submit.prevent="save">
      <IdentityPhotoPanel :avatar-data="avatarDraft === undefined ? avatarData : avatarDraft ?? undefined" :disabled="saving" @update:avatar="avatarDraft = $event; saved = false" />
      <div class="identity-profile-fields">
        <label>Name<input v-model="name" maxlength="48" :disabled="saving" @input="saved = false" /></label>
        <button class="button button-primary" type="submit" :disabled="saving || !name.trim()">{{ saving ? 'Saving…' : 'Save profile' }}</button>
        <p v-if="saved" class="dialog-copy" role="status">Profile saved.</p>
      </div>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </form>
    <section class="identity-recovery" aria-label="Identity recovery">
      <h3>Identity recovery</h3>
      <p class="dialog-copy">Create an encrypted identity backup or restore one on this device.</p>
      <button class="button" type="button" @click="emit('recovery')">Recovery backup</button>
    </section>
  </section>
</template>

<style scoped>
.identity-settings { display: grid; gap: 24px; }
.identity-profile { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 24px; align-items: start; }
.identity-profile-fields { display: grid; gap: 12px; width: 100%; max-width: 360px; }
.identity-profile-fields label { display: grid; gap: 7px; min-width: 0; }
.identity-profile input { box-sizing: border-box; width: 100%; min-height: 42px; padding: 8px 10px; }
.identity-profile .button, .identity-recovery .button { justify-self: start; min-height: 42px; }
.identity-profile > .sync-error { grid-column: 1 / -1; margin: 0; }
.identity-recovery { display: grid; gap: 10px; }
.identity-recovery h3, .identity-recovery p { margin: 0; }
@container (max-width: 460px) { .identity-profile { grid-template-columns: minmax(0, 1fr); gap: 20px; } }
</style>
