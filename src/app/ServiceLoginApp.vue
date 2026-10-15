<script setup lang="ts">
import { onMounted, ref } from "vue"
import { bootstrapIdentity, canonicalizeJson, type LocalProfile } from "../domain/identity"
import { readWorkspaceCatalogRecords } from "../storageCatalog"
import { peerStore } from "../sync/peerStore"
import { assertServiceLoginSession, createServiceLoginApproval } from "./serviceLoginApproval"
import { parseServiceLoginRequest, type ServiceLoginRequest } from "./serviceLogin"

const request = ref<ServiceLoginRequest>()
const identityName = ref("")
const error = ref("")
const ready = ref(false)
const pending = ref(false)
const approved = ref(false)

onMounted(async () => {
  try {
    request.value = parseServiceLoginRequest(new URLSearchParams(location.hash.slice(1)).get("request") ?? "", Math.floor(Date.now() / 1000))
    if (!window.opener) throw new Error("Open sign-in from TinSink in the same browser.")
    const { initializePolicyBrowserRuntime } = await import("../iroh")
    await initializePolicyBrowserRuntime()
    identityName.value = (await bootstrapIdentity()).identity.displayName
    ready.value = true
  } catch (e) { error.value = e instanceof Error ? e.message : "Identity unavailable" }
})

function cancel() { window.close() }

async function approve() {
  if (!request.value || pending.value) return
  const requestSnapshot = structuredClone(request.value)
  const opener = window.opener as Window | null
  if (!opener) { error.value = "TinSink sign-in window is unavailable"; return }
  pending.value = true
  error.value = ""
  try {
    const activeProfile = await bootstrapIdentity()
    const profile = { ...activeProfile, identity: structuredClone(activeProfile.identity), device: structuredClone(activeProfile.device),
      certificate: structuredClone(activeProfile.certificate), privateKeys: { ...activeProfile.privateKeys } }
    const currentWorkspaces = await readWorkspaceEvidence()
    const ensureCurrent = async () => {
      assertServiceLoginSession(request.value, requestSnapshot, window.opener as Window | null, opener)
      const current = await bootstrapIdentity()
      if (!sameProfile(current, profile)) throw new Error("Identity changed during TinSink approval")
      const latest = await readWorkspaceEvidence()
      if (canonicalizeJson(latest) !== canonicalizeJson(currentWorkspaces)) throw new Error("Workspace authority changed during TinSink approval")
    }
    const approval = await createServiceLoginApproval(profile, requestSnapshot, currentWorkspaces, {
      ensureCurrent,
      currentAuthority: async () => canonicalizeJson(await readWorkspaceEvidence()),
    })
    await ensureCurrent()
    assertServiceLoginSession(request.value, requestSnapshot, window.opener as Window | null, opener)
    opener.postMessage({ type: "tinsink-approval", challenge: requestSnapshot.challenge,
      evidence: JSON.stringify(approval) }, requestSnapshot.origin)
    approved.value = true
  } catch (e) { error.value = e instanceof Error ? e.message : "Approval failed" }
  finally { pending.value = false }
}

async function readWorkspaceEvidence() {
  const authorities = await peerStore.listWorkspaceAuthorities()
  const metadata = (await readWorkspaceCatalogRecords()).filter(board => !board.archivedAt)
  return authorities.filter(authority => authority.scopeAuthoritySnapshot).map(authority => {
    const catalog = authority.catalog as { revocations?: unknown[]; deviceRevocations?: Array<{ record: unknown; authority: unknown }>; departures?: unknown[] } | undefined
    return { workspace: authority.workspaceId, name: metadata.find(board => board.id === authority.workspaceId)?.title ?? "", grant: authority.localGrant ?? null,
      policy: { scope: authority.scopeAuthoritySnapshot, revocations: catalog?.revocations ?? [], departures: catalog?.departures ?? [],
        deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.authority })) } }
  })
}

function sameProfile(left: LocalProfile, right: LocalProfile) {
  return left.identity.personId === right.identity.personId && left.identity.publicKey === right.identity.publicKey &&
    left.device.deviceId === right.device.deviceId && left.device.publicKey === right.device.publicKey &&
    left.certificate.signature === right.certificate.signature &&
    left.privateKeys.devicePrivateKey === right.privateKeys.devicePrivateKey &&
    left.privateKeys.identityPrivateKey === right.privateKeys.identityPrivateKey
}

</script>

<template>
  <div class="keeper-admin">
    <header class="topbar"><div class="brand"><h1>tincanban</h1></div></header>
    <main class="service-login">
      <h2>Sign in to TinSink</h2>
      <template v-if="request">
        <p>Service: <strong>{{ request.origin }}</strong></p>
        <p v-if="identityName">Identity: <strong>{{ identityName }}</strong></p>
      </template>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="!ready" role="status">Loading identity…</p>
      <p v-if="approved" role="status">Approval sent. Return to TinSink for the result.</p>
      <button v-else class="button button-primary" :disabled="!ready || pending" @click="approve">{{ pending ? "Approving…" : "Approve sign-in" }}</button>
      <button class="button" @click="cancel">Cancel</button>
    </main>
  </div>
</template>

<style scoped>
.service-login { max-width: 42rem; margin: 2rem auto; padding: 1.5rem; overflow-wrap: anywhere; }
button + button { margin-left: .75rem; }
</style>
