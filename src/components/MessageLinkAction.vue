<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { messageReferenceUrl } from "../chat/messageReference"

const props = defineProps<{ workspaceScope: string; messageId: string; disabled?: boolean }>()
const notice = ref("")
const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined
function resetCopy() { clearTimeout(resetTimer); copied.value = false }
onBeforeUnmount(resetCopy)
const fallback = ref(false)
const copying = ref(false)
const linkInput = ref<HTMLInputElement>()
const url = computed(() => messageReferenceUrl(window.location.href, {
  workspaceScope: props.workspaceScope, messageId: props.messageId,
}))
watch(() => [props.workspaceScope, props.messageId], () => { resetCopy(); notice.value = ""; fallback.value = false })

async function copyLink() {
  if (props.disabled || copying.value) return
  resetCopy()
  copying.value = true
  notice.value = ""
  fallback.value = false
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true
    resetTimer = setTimeout(() => { copied.value = false }, 2000)
  } catch {
    fallback.value = true
    notice.value = "Clipboard unavailable. Select and copy this link."
  } finally {
    copying.value = false
  }
}
</script>

<template>
  <div class="message-link-action">
    <button class="message-action" type="button" :disabled="disabled || copying" title="Workspace must already be available on the receiving device." @click="copyLink"><span aria-live="polite">{{ copied ? "Copied ✓" : copying ? "Copying…" : "Copy link" }}</span></button>
    <span v-if="notice" role="status">{{ notice }}</span>
    <template v-if="fallback">
      <label>Message link<input ref="linkInput" aria-label="Message link" :value="url" readonly @focus="linkInput?.select()" @click="linkInput?.select()"></label>
      <small>Workspace must already be available on the receiving device.</small>
    </template>
  </div>
</template>

<style scoped>
.message-link-action { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); min-width: 0; max-width: 100%; }

.message-link-action > span, .message-link-action small { color: var(--muted); font-size: .8rem; }
.message-link-action label { display: grid; gap: var(--space-1); width: 100%; min-width: 0; font-size: .8rem; }
.message-link-action input { width: 100%; min-width: 0; box-sizing: border-box; }
</style>
