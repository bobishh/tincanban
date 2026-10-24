<script setup lang="ts">
import { computed, ref } from "vue"
import DialogWindow from "./DialogWindow.vue"
import type { LocalProfile } from "../domain/identity"
import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import type { BlindReplicationController } from "../app/blindReplication"
import { parseRustyStatusRequest, assertRustyStatusRequest, createRustyStatusReply, type RustyStatusRequest } from "../app/rustyStatusHandoff"

const props = defineProps<{ workspaceId: string; ready: boolean; profile: () => LocalProfile | null;
  boards: { id: string; title: string }[]; readWorkspaceDoc: (id: string) => Promise<WorkspaceDocumentV2>; controller: BlindReplicationController }>()
const emit = defineEmits<{ close: [] }>()
const request = ref<RustyStatusRequest>()
const error = ref("")
const pending = ref(false)
const sent = ref(false)
const originalOpener = window.opener as Window | null
function close() {
  if (window.opener) window.close()
  const url = new URL(window.location.href)
  const hash = new URLSearchParams(url.hash.slice(1))
  hash.delete("rusty-status")
  url.hash = hash.toString()
  window.history.replaceState(window.history.state, "", url)
  emit("close")
}
try {
  request.value = parseRustyStatusRequest(location.hash, Date.now())
  if (!originalOpener) throw new Error("Open board status from Rusty in this browser.")
} catch (cause) { error.value = cause instanceof Error ? cause.message : "Invalid Rusty status request" }
const visibleBoards = computed(() => props.boards.filter(board => props.controller.configs.value.some(config =>
  config.origin === request.value?.origin && config.workspaceId === board.id) || props.controller.preferenceConflicts.value.some(conflict =>
  conflict.origin === request.value?.origin && conflict.workspaceIds.includes(board.id))))
const canApprove = computed(() => props.ready && props.controller.currentDeviceId.value === props.profile()?.device.deviceId)

async function approve() {
  if (!request.value || pending.value || !canApprove.value) return
  const expected = { ...request.value }, profile = props.profile()
  const selectedIds = new Set(visibleBoards.value.map(board => board.id))
  const ensureCurrent = () => {
    assertRustyStatusRequest(request.value, expected, window.opener as Window | null, originalOpener, Date.now())
    const current = props.profile()
    if (!profile || current?.identity.personId !== profile.identity.personId || current.device.publicKey !== profile.device.publicKey ||
        current.certificate.signature !== profile.certificate.signature) throw new Error("Identity changed during Rusty status confirmation")
  }
  pending.value = true
  error.value = ""
  try {
    ensureCurrent()
    await props.controller.syncNow()
    const boards = await Promise.all(props.boards.filter(board => selectedIds.has(board.id)).map(async entry => {
      const doc = await props.readWorkspaceDoc(entry.id)
      const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))
      if (doc.id !== entry.id || !board) throw new Error("The board address is unavailable. Open this board in Tincanban and retry.")
      return { ...entry, boardId: board.id }
    }))
    ensureCurrent()
    const reply = createRustyStatusReply(expected, props.controller.configs.value,
      boards.filter(board => props.boards.some(entry => entry.id === board.id)), props.controller.statuses.value, Date.now(), props.controller.preferenceConflicts.value)
    originalOpener!.postMessage(reply, expected.origin)
    sent.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not share Rusty status" }
  finally { pending.value = false }
}
</script>

<template>
  <DialogWindow window-id="rusty-status-confirmation" :workspace-id="workspaceId" title="View board storage status" :busy="pending" @close="close">
    <section class="dialog dialog-window-content rusty-status-confirmation ui-stack">
      <p v-if="request">Share connected board names and their latest sync results with <strong>{{ request.origin }}</strong>?</p>
      <ul v-if="visibleBoards.length"><li v-for="board in visibleBoards" :key="board.id">{{ board.title }}</li></ul>
      <p v-else-if="ready">No boards in this browser are configured on this Rusty server.</p>
      <p v-if="sent" role="status">Status shared. Return to Rusty.</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="ui-actions">
        <button v-if="request && !sent" class="button button-primary" type="button" :disabled="!canApprove || pending" @click="approve">{{ pending ? 'Checking board storage…' : 'Share board status' }}</button>
        <button class="button" type="button" :disabled="pending" @click="close">{{ sent ? 'Close' : 'Cancel' }}</button>
      </div>
    </section>
  </DialogWindow>
</template>

<style scoped>
.rusty-status-confirmation { overflow-wrap: anywhere; }
.rusty-status-confirmation p { margin: 0; }
</style>
