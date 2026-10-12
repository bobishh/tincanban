<script setup lang="ts">
import { onMounted, ref } from "vue"
import type { DeviceCertificate } from "../domain/model"
import { bootstrapIdentity, signEnvelope } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { readWorkspaceCatalogRecords } from "../storageCatalog"
import { peerStore } from "../sync/peerStore"
import { parseServiceLoginRequest, serviceLoginPayload, type ServiceLoginRequest } from "./serviceLogin"

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
  pending.value = true
  error.value = ""
  try {
    const profile = await bootstrapIdentity()
    const authorities = await peerStore.listWorkspaceAuthorities()
    const metadata = (await readWorkspaceCatalogRecords()).filter(board => !board.archivedAt)
    const workspaces = authorities.filter(authority => authority.scopeAuthoritySnapshot).map(authority => {
      const catalog = authority.catalog as { revocations?: unknown[]; deviceRevocations?: Array<{ record: unknown; authority: unknown }>; departures?: unknown[] } | undefined
      return { workspace: authority.workspaceId, name: metadata.find(board => board.id === authority.workspaceId)?.title ?? "", grant: authority.localGrant ?? null,
        policy: { scope: authority.scopeAuthoritySnapshot, revocations: catalog?.revocations ?? [], departures: catalog?.departures ?? [],
          deviceRevocations: (catalog?.deviceRevocations ?? []).map(value => ({ record: value.record, signer: value.authority })) } }
    })
    // Sending transport secrets, document contents or identity private keys is unnecessary.
    const proof = await signEnvelope(profile.privateKeys.devicePrivateKey,
      { ...serviceLoginPayload(request.value, Math.floor(Date.now() / 1000)), boards: workspaces.map(board => ({ workspace: board.workspace, name: board.name })) }, profile.device.deviceId, "TINSINK/1")
    const certificates = await certifiedDeviceChain(profile.certificate, hash => defaultProofStore.getCertificate(hash))
    const opener = window.opener as Window | null
    if (!opener) throw new Error("TinSink sign-in window is unavailable")
    const evidence = { identity: profile.identity, deviceId: profile.device.deviceId,
      certificates, proof,
      workspaces }
    opener.postMessage({ type: "tinsink-approval", challenge: request.value.challenge, evidence: JSON.stringify(evidence) }, request.value.origin)
    approved.value = true
  } catch (e) { error.value = e instanceof Error ? e.message : "Approval failed" }
  finally { pending.value = false }
}

async function certifiedDeviceChain(leaf: DeviceCertificate, getCertificate: (hash: string) => Promise<DeviceCertificate | null>) {
  const certificates = [leaf]
  let certificate = leaf
  while (certificate.payload.issuerCertificateHash) {
    if (certificates.length >= 32) throw new Error("Device certificate chain is too long")
    const issuer = await getCertificate(certificate.payload.issuerCertificateHash)
    if (!issuer || certificates.some(value => value.signature === issuer.signature)) throw new Error("Device certificate chain is unavailable")
    certificates.push(issuer)
    certificate = issuer
  }
  return certificates
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
