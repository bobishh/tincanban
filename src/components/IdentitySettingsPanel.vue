<script setup lang="ts">
import { defineAsyncComponent, ref, watch, type Component } from "vue"

const IdentityPhotoPanel = defineAsyncComponent<Component>(() => import("./IdentityPhotoPanel.vue"))

type ProfileDraft = { name: string; avatarData?: string | null; revision?: string }
type PhotoOption = { avatarData: string | null; changedAt: string }
const props = defineProps<{
  displayName: string
  saveName: (value: string) => Promise<void>
  avatarData?: string
  saveAvatar: (value: string | null) => Promise<void>
  nameOptions?: string[]
  photoOptions?: PhotoOption[]
  profileRevision?: string
  saveProfile?: (draft: ProfileDraft) => Promise<void>
}>()
const emit = defineEmits<{ recovery: [] }>()
const name = ref(props.displayName)
const nameDirty = ref(false)
const saving = ref(false)
const avatarDraft = ref<string | null | undefined>(undefined)
const selectedPhotoKey = ref("")
const draftRevision = ref<string | undefined>(undefined)
const revisionCaptured = ref(false)
const saved = ref(false)
const error = ref("")
const profilePending = () => Boolean(props.saveProfile && !props.profileRevision)
watch(() => props.displayName, value => { if (!nameDirty.value) name.value = value })

function captureCurrentRevision() {
  draftRevision.value = props.profileRevision
  revisionCaptured.value = true
}

function editName() {
  if (!revisionCaptured.value) captureCurrentRevision()
  nameDirty.value = true
  saved.value = false
}

function editPhoto(value: string | null) {
  if (!revisionCaptured.value) captureCurrentRevision()
  avatarDraft.value = value
  selectedPhotoKey.value = ""
  saved.value = false
}

function chooseName(value: string) {
  name.value = value
  nameDirty.value = true
  captureCurrentRevision()
  saved.value = false
}

function photoKey(option: PhotoOption) {
  return JSON.stringify([option.avatarData, option.changedAt])
}

function choosePhoto(option: PhotoOption) {
  captureCurrentRevision()
  avatarDraft.value = option.avatarData
  selectedPhotoKey.value = photoKey(option)
  saved.value = false
}

async function save() {
  const value = name.value.trim()
  if (!value || saving.value || profilePending()) return
  saving.value = true
  error.value = ""
  saved.value = false
  try {
    if (props.saveProfile) {
      const revision = revisionCaptured.value ? draftRevision.value : props.profileRevision
      const draft: ProfileDraft = { name: value,
        ...(avatarDraft.value !== undefined ? { avatarData: avatarDraft.value } : {}),
        ...(revision !== undefined ? { revision } : {}) }
      await props.saveProfile(draft)
    } else {
      if (value !== props.displayName) await props.saveName(value)
      if (avatarDraft.value !== undefined) await props.saveAvatar(avatarDraft.value)
    }
    avatarDraft.value = undefined
    selectedPhotoKey.value = ""
    nameDirty.value = false
    draftRevision.value = undefined
    revisionCaptured.value = false
    saved.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not save profile"
  } finally {
    saving.value = false
  }
}

</script>

<template>
  <section class="identity-settings ui-stack" aria-label="Identity settings">
    <form class="identity-profile" role="group" aria-label="Your profile" @submit.prevent="save">
      <IdentityPhotoPanel :avatar-data="avatarDraft === undefined ? avatarData : avatarDraft ?? undefined" :disabled="saving || profilePending()" @update:avatar="editPhoto" />
      <div class="identity-profile-fields">
        <label>Name<input v-model="name" maxlength="48" :disabled="saving || profilePending()" @input="editName" /></label>
      </div>
      <div class="identity-profile-actions">
        <button class="button button-primary" type="submit" :disabled="saving || profilePending() || !name.trim() || ((nameOptions?.length ?? 0) > 1 && !nameDirty)">{{ saving ? 'Saving…' : 'Save profile' }}</button>
        <p v-if="profilePending()" class="dialog-copy" role="status">Loading saved profile…</p>
        <p v-if="saved && !profilePending()" class="dialog-copy" role="status">Profile saved.</p>
      </div>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
    </form>
    <section v-if="(nameOptions?.length ?? 0) > 1 || (photoOptions?.length ?? 0) > 1" class="profile-conflicts" aria-label="Profile conflicts">
      <p class="dialog-copy">Conflicting saved profile details. Choose which name and photo to keep.</p>
      <div v-if="nameOptions?.length" class="profile-choices" role="group" aria-label="Identity name choices">
        <button v-for="option in nameOptions" :key="option" class="button button-quiet" type="button" :disabled="saving || profilePending()"
          :aria-pressed="name === option" @click="chooseName(option)">Choose name: {{ option }}</button>
      </div>
      <div v-if="photoOptions?.length" class="profile-choices" role="group" aria-label="Identity photo choices">
        <button v-for="(option, index) in photoOptions" :key="photoKey(option)" class="button button-quiet profile-photo-choice" type="button"
          :disabled="saving || profilePending()" :aria-label="`Choose photo: ${option.avatarData ? `Photo ${index + 1}` : 'No photo'}`"
          :aria-pressed="selectedPhotoKey === photoKey(option)" @click="choosePhoto(option)">
          <img v-if="option.avatarData" :src="option.avatarData" alt="Profile photo option" />
          <span v-else>No photo</span>
          <small>{{ new Date(option.changedAt).toLocaleDateString() }}</small>
        </button>
      </div>
    </section>
    <section class="identity-recovery" aria-label="Identity recovery">
      <h3>Identity recovery</h3>
      <p class="dialog-copy">Create an encrypted identity backup or restore one on this device.</p>
      <button class="button" type="button" @click="emit('recovery')">Recovery backup</button>
    </section>
  </section>
</template>

<style scoped>
.identity-settings { display: grid; gap: var(--section-gap); }
.identity-profile { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: var(--space-5); align-items: start; }
.identity-profile-fields { display: grid; gap: var(--field-gap); width: 100%; max-width: var(--form-field-max); }
.identity-profile-actions { grid-column: 1 / -1; display: grid; gap: var(--field-gap); justify-items: start; padding-top: var(--space-4); border-top: 1px solid var(--soft); }
.identity-profile-actions p { margin: 0; }
.identity-profile-fields label { display: grid; gap: var(--space-2); min-width: 0; }
.identity-profile input { box-sizing: border-box; width: 100%; height: var(--control-size); padding: var(--space-2) var(--space-3); }
.identity-profile .button, .identity-recovery .button { justify-self: start; }
.identity-profile > .sync-error { grid-column: 1 / -1; margin: 0; }
.profile-conflicts { display: grid; gap: var(--space-2); }
.profile-conflicts > p { margin: 0; }
.profile-choices { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.profile-photo-choice { display: inline-flex; align-items: center; gap: var(--space-2); }
.profile-photo-choice img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
.profile-photo-choice small { color: var(--muted); }
.identity-recovery { display: grid; gap: var(--space-2); }
.identity-recovery h3, .identity-recovery p { margin: 0; }
@container (max-width: 460px) { .identity-profile { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); } }
</style>
