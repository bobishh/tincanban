<script setup lang="ts">
import { onMounted, ref } from "vue"
import DialogWindow from "./DialogWindow.vue"
import type { DeviceAuthorizationRequest } from "@meta-uber/mesh-identity"
import type { LocalProfile } from "../domain/identity"
import type { PublicIdentity, WorkspaceDocumentV2 } from "../domain/model"
import { connectIdentityProfile, recoveryFileJson, startIdentityProfileHost, type IdentityEnrollmentRequest } from "../app/identityPortalEnrollment"
import { browserSignInFailureMessage, clearIdentityBrowserSignIn, clearPendingRustyConnectionIntent, createApprovedSignInCompletion, createIdentityBrowserSignIn, identityBrowserReturnPath,
  readIdentityBrowserSignInReturn, readPendingIdentityBrowserSignIn, recordIdentityBrowserSignIn,
  verifyIdentityBrowserSignInReturn, writePendingIdentityBrowserSignIn, type IdentityBrowserSignInResult } from "../app/identityBrowserSignIn"
import { completeIdentityBrowserSignIn } from "../app/completeIdentityBrowserSignIn"
import type { IdentityEnrollmentRecovery } from "@meta-uber/mesh-runtime"

class KeepCurrentIdentity extends Error {
  constructor() {
    super("Kept the current Identity")
    this.name = "KeepCurrentIdentity"
  }
}

function browserSignInFailure(phase: "callback" | "adoption" | "refresh", cause: unknown, elapsedMs: number): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    recordIdentityBrowserSignIn(phase, "failed", { errorCode: phase === "callback" ? "callback_failed" : phase === "adoption" ? "adoption_failed" : "refresh_failed", elapsedMs })
    return browserSignInFailureMessage(cause)
  }
  recordIdentityBrowserSignIn(phase, "failed", { errorCode: phase === "callback" ? "callback_failed" : phase === "adoption" ? "adoption_failed" : "refresh_failed", elapsedMs })
  return cause instanceof Error ? cause.message : "Identity sign-in failed"
}

function restoreSignInReturnPath(path: string | null) {
  if (path) window.history.replaceState(window.history.state, "", path)
}

const props = defineProps<{ workspaceId: string; portalOrigin: string; profile: LocalProfile; browserReturn: boolean;
  initialMode?: "choose" | "signin" | "connect";
  workspaces: Array<{ id: string; title: string }>; readWorkspaceDoc(id: string): Promise<WorkspaceDocumentV2>;
  exportCurrentWorkspace(): Promise<void>; completeBrowserSignIn(returnPath: string, request?: DeviceAuthorizationRequest): Promise<void> }>()
const emit = defineEmits<{ close: []; completed: [] }>()
const mode = ref<"choose" | "create" | "connect" | "signin">("choose")
const inviteUrl = ref("")
const invitationToJoin = ref("")
const deviceLabel = ref("This device")
const status = ref("")
const error = ref("")
const busy = ref(false)
const request = ref<IdentityEnrollmentRequest | null>(null)
const approveFullRecovery = ref(false)
const recovery = ref<IdentityEnrollmentRecovery | null>(null)
const recoverySaved = ref(false)
const allowRecoveryTransfer = ref(false)
const replacementIdentity = ref<Pick<PublicIdentity, "personId" | "displayName"> | null>(null)
const affectedBoards = ref<string[]>([])
const unavailableWorkspaceCount = ref(0)
const replacementConfirmed = ref(false)
const browserApproval = ref<Extract<IdentityBrowserSignInResult, { kind: "approved" }> | null>(null)
const browserSignInReturnPath = ref<string | null>(null)
const browserSignInCompletion = createApprovedSignInCompletion(props.completeBrowserSignIn)
let browserSignInAttempt = 0
let resolveRequest: ((decision: "approve" | "reject") => void) | undefined
let resolveRecovery: (() => void) | undefined
let rejectRecovery: ((reason: Error) => void) | undefined
let resolveReplacement: (() => void) | undefined
let rejectReplacement: ((reason: Error) => void) | undefined
let abortHost: AbortController | undefined
let activeBrowserSignInChallenge: string | null = null

onMounted(() => {
  if (props.browserReturn) void finishBrowserSignInReturn()
  else if (props.initialMode === "signin") void beginBrowserSignIn()
  else if (props.initialMode === "connect") mode.value = "connect"
})

async function beginBrowserSignIn() {
  mode.value = "signin"
  error.value = ""
  status.value = ""
  clearIdentityBrowserSignIn(window.sessionStorage)
  activeBrowserSignInChallenge = null
  browserApproval.value = null
  browserSignInCompletion.reset()
  const attempt = ++browserSignInAttempt
  busy.value = true
  const startedAt = performance.now()
  recordIdentityBrowserSignIn("request", "started")
  try {
    const returnPath = browserSignInReturnPath.value ?? `${window.location.pathname}${window.location.search}`
    const { pending, portalUrl } = await createIdentityBrowserSignIn({ profile: props.profile,
      portalOrigin: props.portalOrigin, applicationOrigin: window.location.origin, returnPath })
    if (attempt !== browserSignInAttempt) return
    browserSignInReturnPath.value = pending.returnPath
    activeBrowserSignInChallenge = pending.request.payload.challenge
    writePendingIdentityBrowserSignIn(window.sessionStorage, pending)
    recordIdentityBrowserSignIn("request", "completed", { elapsedMs: performance.now() - startedAt })
    recordIdentityBrowserSignIn("redirect", "completed")
    busy.value = false
    window.location.assign(portalUrl)
  } catch (cause) {
    if (attempt !== browserSignInAttempt) return
    recordIdentityBrowserSignIn("request", "failed", { errorCode: "request_failed", elapsedMs: performance.now() - startedAt })
    error.value = cause instanceof Error ? cause.message : "Identity sign-in could not start"
  } finally {
    if (attempt === browserSignInAttempt) busy.value = false
  }
}

async function finishBrowserSignInReturn() {
  const attempt = ++browserSignInAttempt
  const startedAt = performance.now()
  let phase: "callback" | "adoption" | "refresh" = "callback"
  let trustedReturnPath: string | null = null
  mode.value = "signin"
  busy.value = true
  const hash = readIdentityBrowserSignInReturn(window.sessionStorage) ?? window.location.hash
  const callbackState = new URLSearchParams(hash.replace(/^#/u, "")).get("state") ?? ""
  window.history.replaceState(window.history.state, "", `${identityBrowserReturnPath}${window.location.search}`)
  try {
    const pending = readPendingIdentityBrowserSignIn(window.sessionStorage, callbackState)
    if (!pending) throw new Error("Identity sign-in request expired or was already used. Select Sign in to try again.")
    trustedReturnPath = pending.returnPath
    activeBrowserSignInChallenge = pending.request.payload.challenge
    browserSignInReturnPath.value = pending.returnPath
    const result = await verifyIdentityBrowserSignInReturn({ hash, pending, currentProfile: props.profile,
      applicationOrigin: window.location.origin })
    if (attempt !== browserSignInAttempt) return
    if (result.kind === "cancelled") {
      clearPendingRustyConnectionIntent(window.sessionStorage)
      recordIdentityBrowserSignIn("callback", "cancelled", { elapsedMs: performance.now() - startedAt })
      restoreSignInReturnPath(pending.returnPath)
      error.value = "Identity approval was not granted. Select Sign in to try again."
      return
    }
    recordIdentityBrowserSignIn("callback", "verified", { elapsedMs: performance.now() - startedAt })
    browserApproval.value = result
    if (result.replacesIdentity) await confirmReplacement(result.approval.identity)
    if (attempt !== browserSignInAttempt) return
    phase = "adoption"
    recordIdentityBrowserSignIn("adoption", "started")
    await completeIdentityBrowserSignIn(result.approval, pending.request, props.profile, props.workspaceId)
    recordIdentityBrowserSignIn("adoption", "completed", { elapsedMs: performance.now() - startedAt })
    phase = "refresh"
    if (await browserSignInCompletion.finish(pending.returnPath, pending.request)) browserApproval.value = null
    else {
      browserApproval.value = null
      error.value = browserSignInCompletion.error.value ?? "Identity was approved, but the app could not finish sign-in. Select Sign in to retry."
    }
  } catch (cause) {
    if (attempt !== browserSignInAttempt) return
    if (cause instanceof KeepCurrentIdentity) {
      browserApproval.value = null
      mode.value = "signin"
      error.value = ""
      status.value = "Kept the current Identity. No local data changed."
      restoreSignInReturnPath(trustedReturnPath)
      return
    }
    browserApproval.value = null
    mode.value = "signin"
    error.value = browserSignInFailure(phase, cause, performance.now() - startedAt)
    restoreSignInReturnPath(trustedReturnPath)
  } finally {
    if (attempt === browserSignInAttempt) busy.value = false
  }
}

function dismissBrowserSignIn() {
  browserSignInAttempt++
  const pending = readPendingIdentityBrowserSignIn(window.sessionStorage, undefined, false)
  const returnPath = browserSignInReturnPath.value ?? pending?.returnPath
  readIdentityBrowserSignInReturn(window.sessionStorage)
  if (activeBrowserSignInChallenge) {
    readPendingIdentityBrowserSignIn(window.sessionStorage, activeBrowserSignInChallenge)
  }
  clearPendingRustyConnectionIntent(window.sessionStorage)
  cancelReplacement()
  if (returnPath) window.history.replaceState(window.history.state, "", returnPath)
  browserSignInReturnPath.value = null
  activeBrowserSignInChallenge = null
  browserApproval.value = null
  error.value = ""
  status.value = ""
  busy.value = false
  recordIdentityBrowserSignIn("cancel", "cancelled")
  emit("close")
}

async function confirmReplacement(identity: Pick<PublicIdentity, "personId" | "displayName">) {
  if (identity.personId === props.profile.identity.personId) return
  const signal = abortHost?.signal
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Sign in was cancelled", "AbortError")
  replacementIdentity.value = identity
  replacementConfirmed.value = false
  affectedBoards.value = []
  unavailableWorkspaceCount.value = 0
  await Promise.all(props.workspaces.map(async workspace => {
    try {
      const doc = await props.readWorkspaceDoc(workspace.id)
      const boards = Object.values(doc.entities).filter(entity => entity.kind === "board")
      affectedBoards.value.push(...(boards.length ? boards.map(board => `${board.title} · ${workspace.title}`) : [workspace.title]))
    } catch { unavailableWorkspaceCount.value++ }
  }))
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Sign in was cancelled", "AbortError")
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const onAbort = () => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Sign in was cancelled", "AbortError")) }
    resolveReplacement = () => { cleanup(); resolve() }
    rejectReplacement = reason => { cleanup(); reject(reason) }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
  replacementIdentity.value = null
}

function approveReplacement() {
  if (!replacementConfirmed.value) return
  resolveReplacement?.()
  resolveReplacement = undefined
  rejectReplacement = undefined
}

function cancelReplacement() {
  rejectReplacement?.(new KeepCurrentIdentity())
  resolveReplacement = undefined
  rejectReplacement = undefined
  replacementIdentity.value = null
}

function downloadRecoveryFile() {
  if (!recovery.value) return
  const url = URL.createObjectURL(new Blob([recoveryFileJson(recovery.value.file)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "identity-profile-recovery.json"
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

async function createProfile() {
  mode.value = "create"
  busy.value = true
  error.value = ""
  abortHost = new AbortController()
  try {
    await startIdentityProfileHost({ profile: props.profile, portalOrigin: props.portalOrigin, signal: abortHost.signal,
      onInvite: url => { inviteUrl.value = url },
      onStatus: message => { status.value = message },
      onRequest: incoming => new Promise(resolve => { request.value = incoming; resolveRequest = resolve }),
    })
    if (request.value && !approveFullRecovery.value) throw new Error("Full Identity recovery was not approved")
    emit("completed")
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Identity profile creation failed"
    if (!abortHost.signal.aborted) error.value = message
  } finally {
    busy.value = false
    recovery.value = null
    request.value = null
    resolveRequest = undefined
  }
}

async function connectProfile() {
  mode.value = "connect"
  busy.value = true
  error.value = ""
  abortHost = new AbortController()
  status.value = "Connecting to the Identity portal…"
  try {
    await connectIdentityProfile({ profile: props.profile, inviteUrl: invitationToJoin.value.trim(), deviceLabel: deviceLabel.value,
      signal: abortHost.signal, fullRecoveryConsent: allowRecoveryTransfer.value, confirmReplacement,
      onStatus: message => { status.value = message },
      onRecovery: value => new Promise<void>((resolve, reject) => {
        recovery.value = value
        recoverySaved.value = false
        resolveRecovery = resolve
        rejectRecovery = reject
      }),
    })
    emit("completed")
  } catch (cause) {
    if (!abortHost?.signal.aborted && cause instanceof KeepCurrentIdentity) {
      status.value = "Kept the current Identity. No local data changed."
    } else if (!abortHost?.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : "Identity sign-in failed"
    }
  } finally {
    busy.value = false
    recovery.value = null
    replacementIdentity.value = null
    abortHost = undefined
    resolveRecovery = undefined
    rejectRecovery = undefined
    resolveReplacement = undefined
    rejectReplacement = undefined
  }
}

function approveRequest() {
  if (!approveFullRecovery.value || !request.value || !request.value.fullRecoveryConsent) return
  resolveRequest?.("approve")
  resolveRequest = undefined
  request.value = null
}

function rejectRequest() {
  resolveRequest?.("reject")
  resolveRequest = undefined
  request.value = null
  error.value = "Device request declined."
}

function acknowledgeRecovery() {
  if (!recoverySaved.value || !recovery.value) return
  resolveRecovery?.()
  resolveRecovery = undefined
  recovery.value = null
}

function cancel() {
  if (mode.value === "signin") {
    dismissBrowserSignIn()
    return
  }
  if (recovery.value) rejectRecovery?.(new DOMException("Recovery was not acknowledged", "AbortError"))
  cancelReplacement()
  if (request.value) rejectRequest()
  abortHost?.abort()
  resolveRecovery = undefined
  rejectRecovery = undefined
  recovery.value = null
  if (!busy.value) emit("close")
}
</script>

<template>
  <DialogWindow window-id="identity-portal-enrollment" :workspace-id="workspaceId" title="Identity profile" @close="cancel">
    <section class="dialog dialog-window-content identity-portal-enrollment">
      <template v-if="mode === 'choose'">
        <h2>Use your Identity profile</h2>
        <p class="dialog-copy">Your board data stays on this device. Identity enrollment adds a trusted device and synchronizes signed profile history.</p>
        <div class="dialog-actions">
          <button class="button button-primary" type="button" @click="createProfile">Create profile</button>
          <button class="button button-quiet" type="button" @click="beginBrowserSignIn">Sign in</button>
          <button class="button button-quiet" type="button" @click="mode = 'connect'">Add another device</button>
        </div>
      </template>

      <template v-else-if="mode === 'create'">
        <h2>Create profile</h2>
        <p class="dialog-copy">Open this one-use link in Identity. Approve only a device request you started.</p>
        <label>Identity invitation<input class="technical-text" readonly :value="inviteUrl" /></label>
        <a v-if="inviteUrl" class="button button-primary" :href="inviteUrl" target="_blank" rel="noopener noreferrer">Open Identity</a>
        <p v-if="status" role="status">{{ status }}</p>
        <section v-if="request" class="mesh-member-action" aria-label="Device approval">
          <p><strong>{{ request.displayName }}</strong> wants to enroll. Identity person: {{ request.personId }}</p>
          <p class="dialog-copy">Guest signed consent for full recovery transfer: {{ request.fullRecoveryConsent ? "Yes" : "No" }}.</p>
          <label><input v-model="approveFullRecovery" type="checkbox" /> I approve transferring full Identity recovery for this person.</label>
          <div class="dialog-actions">
            <button class="button button-primary" type="button" :disabled="!approveFullRecovery || !request.fullRecoveryConsent" @click="approveRequest">Approve and create profile</button>
            <button class="button button-quiet" type="button" @click="rejectRequest">Decline</button>
          </div>
        </section>
      </template>

      <template v-else-if="mode === 'signin'">
        <h2>Sign in</h2>
        <p v-if="busy" class="dialog-copy" role="status">Signing in…</p>
        <p v-else class="dialog-copy">Approve this app device in Identity to continue.</p>
        <div v-if="!browserApproval && !busy" class="dialog-actions identity-browser-signin-actions">
          <button class="button button-primary" type="button" @click="beginBrowserSignIn">Sign in</button>
        </div>
        <p v-if="status" role="status">{{ status }}</p>
        <section v-if="replacementIdentity" class="mesh-member-action" aria-label="Replace local Identity confirmation">
          <h3>Join {{ replacementIdentity.displayName }}?</h3>
          <p class="dialog-copy">Incoming Identity: <code>{{ replacementIdentity.personId }}</code></p>
          <p class="dialog-copy">This replaces the Identity active in this browser. Local board data stays stored, but {{ replacementIdentity.displayName }} may not have access to it. Identities and boards are not merged.</p>
          <p v-if="affectedBoards.length">Known local boards and workspaces:</p>
          <ul v-if="affectedBoards.length"><li v-for="name in affectedBoards" :key="name">{{ name }}</li></ul>
          <p v-if="unavailableWorkspaceCount || !affectedBoards.length" class="dialog-copy">Some saved or inaccessible copies may not appear in this list.</p>
          <button class="button button-quiet" type="button" @click="exportCurrentWorkspace">Download active workspace backup</button>
          <label><input v-model="replacementConfirmed" type="checkbox" /> I understand this changes the active Identity and may leave local boards inaccessible.</label>
          <div class="dialog-actions">
            <button class="button button-primary" type="button" :disabled="!replacementConfirmed" @click="approveReplacement">Continue with this Identity</button>
            <button class="button button-quiet" type="button" @click="cancelReplacement">Keep current Identity</button>
          </div>
        </section>
      </template>

      <template v-else>
        <h2>Add another device</h2>
        <p class="dialog-copy">Connect this device using an invitation created by an existing Identity device.</p>
        <div class="identity-device-connect-form">
          <label class="identity-device-field">Identity invitation<textarea v-model="invitationToJoin" class="technical-text" rows="3" :disabled="busy" autocomplete="off" /></label>
          <label class="identity-device-field">Device name<input v-model="deviceLabel" :disabled="busy" maxlength="128" /></label>
          <label class="identity-device-consent"><input v-model="allowRecoveryTransfer" type="checkbox" :disabled="busy" /><span>Allow an optional full-Identity recovery transfer. It gives full Identity authority and requires saving its file and words.</span></label>
          <div class="identity-device-actions">
            <button class="button button-primary" type="button" :disabled="busy || !invitationToJoin.trim() || !deviceLabel.trim()" @click="connectProfile">Connect this device</button>
            <button class="button button-quiet" type="button" :disabled="busy" @click="mode = 'choose'">Back to Identity options</button>
          </div>
        </div>
        <p v-if="status" role="status">{{ status }}</p>
        <section v-if="recovery" class="mesh-member-action" aria-label="Identity recovery acknowledgment">
          <h3>Save your Identity recovery</h3>
          <p class="dialog-copy">These words and file restore full Identity authority. Once displayed, they cannot be recalled. Save the encrypted file and keep it separate from the words. This must finish before device enrollment.</p>
          <button class="button button-quiet" type="button" @click="downloadRecoveryFile">Download encrypted recovery file</button>
          <p><code class="recovery-words">{{ recovery.recoveryKey }}</code></p>
          <label><input v-model="recoverySaved" type="checkbox" /> I saved the encrypted file and wrote down the recovery words.</label>
          <button class="button button-primary" type="button" :disabled="!recoverySaved" @click="acknowledgeRecovery">I saved my recovery</button>
        </section>
      </template>

      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button v-if="mode !== 'signin' && busy" class="button button-quiet" type="button" @click="cancel">Cancel</button>
        <button v-else class="button button-quiet" type="button" @click="mode === 'signin' ? dismissBrowserSignIn() : emit('close')">Close</button>
      </div>
    </section>
  </DialogWindow>
</template>

<style scoped>
.identity-device-connect-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  min-width: 0;
}

.identity-device-field {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  color: var(--muted);
  font: 700 .8rem/1.4 var(--site-font-sans);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.identity-device-field input,
.identity-device-field textarea {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.identity-device-field textarea { resize: vertical; }

.identity-device-consent {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--space-2);
  min-width: 0;
  color: var(--muted);
  font: 400 .9rem/1.45 var(--site-font-sans);
  letter-spacing: 0;
  text-transform: none;
}

.identity-device-consent input {
  width: 18px;
  height: 18px;
  margin-block-start: var(--space-1);
}

.identity-device-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.identity-browser-signin-actions { justify-content: flex-start; }
</style>
