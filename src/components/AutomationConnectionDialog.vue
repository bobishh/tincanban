<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue"
import DialogWindow from "./DialogWindow.vue"
import { fromBase64Url } from "../domain/identityCrypto"
import type { LocalProfile } from "../domain/identity"
import { readLocal, writeLocal } from "../localDb"
import { createAutomationConnection, parseAutomationConnectionRequest,
  type AutomationConnectionRequest, type ResolvedAutomationConnection } from "../app/automationConnection"
import { createOwnerRequest } from "../app/automationClient"
import type { AutomationWorkerIdentity, AutomationConfiguration, automationBoardDescription } from "../app/automation"

type BoardDescription = ReturnType<typeof automationBoardDescription>
const props = defineProps<{
  ready: boolean; workspaceId: string; boards: { id: string; title: string }[]
  profile: LocalProfile | null
  describe: (workspaceId: string, configuration: AutomationConfiguration) => Promise<BoardDescription>
  exportPacket: (identity: AutomationWorkerIdentity, workspaceId: string, fingerprint: string, configuration: AutomationConfiguration) => Promise<string>
}>()
const emit = defineEmits<{ signIn: [] }>()
const request = shallowRef<AutomationConnectionRequest>()
const resolved = shallowRef<ResolvedAutomationConnection>()
const description = shallowRef<BoardDescription>()
const selected = ref(props.workspaceId), pending = ref(false), loading = ref(true), error = ref("")
const ownerMatches = computed(() => props.profile?.identity.personId === request.value?.owner_person_id)
const canApprove = computed(() => props.ready && ownerMatches.value && Boolean(description.value && resolved.value) && !pending.value && !loading.value)
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Automation connection is unavailable. Retry the same request."
function close() { window.location.assign("/") }

function client(approval?: { profile: LocalProfile; fingerprint: string }) {
  if (!request.value) throw new Error("Open this connection from Reflux")
  const captured = request.value
  const stateKey = `tincanban.automation-approval.v1.${captured.owner_person_id}.${captured.intent_id}`
  return createAutomationConnection({ request: captured,
    store: { load: () => readLocal(stateKey), save: value => writeLocal(stateKey, value) },
    ensureCurrent: () => {
      if (!approval) return
      const current = props.profile
      if (current?.identity.personId !== approval.profile.identity.personId ||
          current.device.deviceId !== approval.profile.device.deviceId || current.certificate.signature !== approval.profile.certificate.signature) {
        throw new Error("Identity changed during automation approval")
      }
    },
    sign: async input => {
      if (!approval) throw new Error("Approve access before signing")
      return createOwnerRequest(approval.profile, input)
    },
    exportPacket: (identity, workspaceId) => {
      if (!approval) throw new Error("Approve access before exporting")
      if (!resolved.value) throw new Error("Connection configuration unavailable")
      return props.exportPacket(identity, workspaceId, approval.fingerprint, resolved.value.configuration)
    } })
}

async function load() {
  loading.value = true
  error.value = ""
  try {
    const current = new URL(location.href)
    const encoded = new URLSearchParams(current.hash.slice(1)).get("request")
    if (encoded) {
      if (encoded.length > 12_000) throw new Error("Automation connection request is too large")
      request.value = parseAutomationConnectionRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(encoded))))
      await writeLocal(`tincanban.automation-intent.v1.${request.value.intent_id}`, JSON.stringify(request.value))
      current.hash = ""
      current.search = new URLSearchParams({ intent: request.value.intent_id }).toString()
      history.replaceState(history.state, "", current)
    } else {
      const id = current.searchParams.get("intent")
      if (!id || !/^[0-9a-f-]{36}$/iu.test(id)) throw new Error("Open this connection from Reflux")
      request.value = parseAutomationConnectionRequest(JSON.parse(await readLocal(`tincanban.automation-intent.v1.${id}`) ?? "null"))
    }
    resolved.value = await client().resolve()
    if (props.ready && ownerMatches.value) await selectBoard()
  } catch (cause) { error.value = message(cause) }
  finally { loading.value = false }
}
async function selectBoard() {
  description.value = undefined
  pending.value = true
  error.value = ""
  try {
    if (!resolved.value) throw new Error("Connection configuration unavailable")
    description.value = await props.describe(selected.value, resolved.value.configuration)
  }
  catch (cause) { error.value = message(cause) }
  finally { pending.value = false }
}
async function approve() {
  const profile = props.profile, approved = description.value
  if (!profile || !approved || !canApprove.value) return
  pending.value = true
  error.value = ""
  try {
    const returnTo = await client({ profile, fingerprint: approved.fingerprint }).approve(profile.identity.personId, selected.value, approved.fingerprint)
    location.assign(returnTo)
  } catch (cause) { error.value = message(cause) }
  finally { pending.value = false }
}
async function decline() {
  if (pending.value) return
  pending.value = true
  try { location.assign(await client().decline()) }
  catch (cause) { error.value = message(cause); pending.value = false }
}
onMounted(load)
</script>

<template>
  <DialogWindow window-id="automation-connection" :workspace-id="workspaceId" title="Connect automation" :busy="pending" @close="close">
    <section class="dialog dialog-window-content automation-connection ui-stack">
      <p v-if="loading" role="status">Loading connection…</p>
      <template v-else-if="resolved">
        <h2>{{ resolved.workflowTitle }}</h2>
        <p class="dialog-copy">Requested by {{ request?.reflux_origin }}</p>
        <p>Sources: {{ (resolved.configuration.parameters.sources as string[]).join(', ') }}</p>
        <p>Automatically processes website submissions and application emails within the access approved below.</p>
        <template v-if="ownerMatches">
          <div class="automation-board-label">
            <label for="automation-connection-board">Board</label>
            <select id="automation-connection-board" v-model="selected" :disabled="pending || !ready" @change="selectBoard">
              <option v-for="board in boards" :key="board.id" :value="board.id">{{ board.title }}</option>
            </select>
          </div>
          <div v-if="description" class="automation-access ui-stack">
            <p><strong>Read:</strong> Entire workspace, including its documents.</p>
            <p><strong>Write:</strong> Create and update job cards in {{ description.columns.join(', ') }}.</p>
            <p><strong>Fields:</strong> {{ description.fields.join(', ') }}.</p>
            <p class="dialog-copy">Access lasts 30 days. Existing cards stay in place.</p>
          </div>
        </template>
        <template v-else>
          <p>Sign in with the Identity that owns this workflow to choose a board.</p>
          <button type="button" class="button" @click="emit('signIn')">Sign in</button>
        </template>
      </template>
      <p v-if="error" role="alert" class="notice notice-error">{{ error }}</p>
      <div class="dialog-actions">
        <button class="button button-quiet" type="button" :disabled="pending || !request" @click="decline">Decline</button>
        <button v-if="!resolved && !loading" class="button button-quiet" type="button" @click="load">Retry</button>
        <button v-if="ownerMatches" class="button" type="button" :disabled="!canApprove" @click="approve">{{ pending ? 'Connecting…' : 'Connect workflow' }}</button>
      </div>
    </section>
  </DialogWindow>
</template>

<style scoped>
.automation-connection { max-width: 44rem; }
.automation-board-label { display: grid; gap: var(--space-2); }
.automation-access p { margin: 0; }
</style>
