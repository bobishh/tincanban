<script setup lang="ts">
import { computed, ref } from "vue"
import type { BlindReplicationController } from "../app/blindReplication"

const props = defineProps<{ controller: BlindReplicationController; workspaceId: string; owner: boolean }>()
const busy = ref(false)
const error = ref("")
const notice = computed(() => props.controller.historyNotices.value[props.workspaceId] ?? "")

function presentError(cause: unknown) {
  if ((cause instanceof DOMException && cause.name === "QuotaExceededError") ||
      (cause instanceof Error && /quota|storage (?:is )?full|capacity exceeded/i.test(cause.message))) {
    return "Browser storage is full. Free up space, then retry archiving history."
  }
  const message = cause instanceof Error ? cause.message : ""
  if (message === "History compaction requires one active Rusty connection for this board") return "Connect this workspace to Rusty, then try again."
  if (message === "Wait for current Rusty sync to finish") return "Wait for Rusty to finish syncing, then retry archiving history."
  if (/^Only (?:the current )?workspace owner (?:may|can)/i.test(message)) return "Only the workspace owner can archive history."
  if (/history (?:has unresolved|contains changes that require review)/i.test(message)) return "Resolve pending or quarantined changes before archiving history."
  return message ? `Could not archive history. ${message}` : "Could not archive history. Try again."
}

async function compact() {
  if (busy.value || !props.owner) return
  busy.value = true
  error.value = ""
  try {
    await props.controller.syncNow()
    await props.controller.compactWorkspaceHistory(props.workspaceId)
  } catch (cause) {
    error.value = presentError(cause)
    console.error("Workspace history archiving failed:", cause instanceof Error ? cause.stack ?? cause.message : "Unknown error")
  } finally { busy.value = false }
}
</script>

<template>
  <section class="sync-section" aria-label="Workspace history">
    <p class="sync-section-copy">Workspace history</p>
    <p class="dialog-copy">Keeps recent changes quick to open. Earlier versions stay available.</p>
    <button class="button button-quiet" type="button" :disabled="!owner || busy" @click="compact">
      {{ busy ? "Archiving history…" : "Archive older history" }}
    </button>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-else-if="notice && !busy" class="dialog-copy" role="status">{{ notice }}</p>
  </section>
</template>
