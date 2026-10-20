<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, type Component } from "vue"
import { AVATAR_MAX_SOURCE_BYTES } from "../avatarCrop"
const AvatarCropDialog = shallowRef<Component>()
const props = defineProps<{ workspaceId?: string; avatarData?: string; disabled?: boolean }>()
const emit = defineEmits<{ "update:avatar": [value: string | null] }>()
const avatarError = ref("")
const avatarSourceUrl = ref("")
const cropping = ref(false)
const editorLoading = ref(false)
const editorFailed = ref(false)
let disposed = false

function discardSource() {
  if (avatarSourceUrl.value) URL.revokeObjectURL(avatarSourceUrl.value)
  avatarSourceUrl.value = ""
}

function choosePhoto(event: Event) {
  if (props.disabled) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  avatarError.value = ""
  if (!file) return
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { avatarError.value = "Choose a PNG, JPEG, or WebP photo"; return }
  if (file.size > AVATAR_MAX_SOURCE_BYTES) { avatarError.value = "Photo is too large to crop"; return }
  discardSource()
  avatarSourceUrl.value = URL.createObjectURL(file)
  void openEditor()
}

async function openEditor() {
  if (editorLoading.value) return
  editorLoading.value = true
  editorFailed.value = false
  avatarError.value = ""
  try {
    if (!AvatarCropDialog.value) {
      const module = await import("./AvatarCropDialog.vue") as { default: Component }
      AvatarCropDialog.value = module.default
    }
    if (!disposed && avatarSourceUrl.value) cropping.value = true
  } catch {
    if (!disposed) {
      editorFailed.value = true
      avatarError.value = "Photo editor could not load. Reload the app, then choose your photo again."
    }
  } finally { editorLoading.value = false }
}

function reloadApp() {
  window.location.reload()
}

function cancelCrop() {
  cropping.value = false
  discardSource()
}

function cropped(value: string) {
  cropping.value = false
  discardSource()
  emit("update:avatar", value)
}

onBeforeUnmount(() => { disposed = true; discardSource() })
</script>
<template>
    <section class="identity-avatar-form" aria-label="Identity photo">
      <img v-if="avatarData" class="participant-avatar participant-avatar-photo identity-avatar-preview" :src="avatarData" alt="Your profile photo" />
      <span v-else class="identity-avatar-placeholder" aria-label="No profile photo">Photo</span>
      <div class="identity-avatar-actions">
        <label class="button" for="identity-avatar-file">Choose photo</label>
        <input id="identity-avatar-file" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" :disabled="disabled || editorLoading" @change="choosePhoto" />
        <button v-if="editorFailed" class="button" type="button" @click="reloadApp">Reload app</button>
        <button v-if="avatarData" class="button button-quiet button-small identity-remove-photo" type="button" :disabled="disabled" @click="emit('update:avatar', null)">Remove photo</button>
      </div>
      <p v-if="avatarError" class="sync-error" role="alert">{{ avatarError }}</p>
      <p v-if="editorLoading" role="status">Opening photo editor…</p>
      <component :is="AvatarCropDialog" v-if="cropping && avatarSourceUrl && AvatarCropDialog" :workspace-id="workspaceId" :source-url="avatarSourceUrl" @save="cropped" @cancel="cancelCrop" />
    </section>
</template>
<style scoped>
.identity-avatar-form { display: grid; justify-items: start; gap: var(--space-3); min-width: 0; }
.identity-avatar-placeholder { display: grid; place-items: center; width: 72px; height: 72px; border-radius: 50%; background: var(--soft); color: var(--muted); }
.identity-avatar-preview { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; }
.identity-avatar-actions { display: grid; gap: var(--space-2); width: 100%; max-width: 140px; }
.identity-avatar-actions .button { padding: var(--space-2) var(--space-3); }
.identity-remove-photo { justify-self: start; text-decoration: underline; text-underline-offset: 3px; }
</style>
