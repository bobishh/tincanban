<script setup lang="ts">
import { onMounted, ref } from "vue"
import DialogWindow from "./DialogWindow.vue"
import type { DeviceAuthorizationRequest } from "@meta-uber/mesh-identity"
import type { LocalProfile } from "../domain/identity"
import type { PublicIdentity, WorkspaceDocumentV2 } from "../domain/model"
import { startIdentityProfileHost, type IdentityEnrollmentRequest } from "../app/identityPortalEnrollment"
import { beginIdentityBrowserSignInDiagnostic, browserSignInFailureMessage, clearIdentityBrowserSignIn, clearPendingRustyConnectionIntent, createApprovedSignInCompletion, createIdentityBrowserSignIn, identityBrowserReturnPath,
  readIdentityBrowserSignInReturn, readPendingIdentityBrowserSignIn, recordIdentityBrowserSignIn,
  verifyIdentityBrowserSignInReturn, writePendingIdentityBrowserSignIn, type IdentityBrowserSignInResult } from "../app/identityBrowserSignIn"
import { completeIdentityBrowserSignIn } from "../app/completeIdentityBrowserSignIn"

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
  initialMode?: "choose" | "signin";
  workspaces: Array<{ id: string; title: string }>; readWorkspaceDoc(id: string): Promise<WorkspaceDocumentV2>;
  exportCurrentWorkspace(): Promise<void>; completeBrowserSignIn(returnPath: string, request?: DeviceAuthorizationRequest): Promise<void> }>()
const emit = defineEmits<{ close: []; completed: [] }>()
const mode = ref<"choose" | "create" | "signin">("choose")
const inviteUrl = ref("")
const status = ref("")
const error = ref("")
const busy = ref(false)
const request = ref<IdentityEnrollmentRequest | null>(null)
const approveFullRecovery = ref(false)
const replacementIdentity = ref<Pick<PublicIdentity, "personId" | "displayName"> | null>(null)
const affectedBoards = ref<string[]>([])
const unavailableWorkspaceCount = ref(0)
const replacementConfirmed = ref(false)
const browserApproval = ref<Extract<IdentityBrowserSignInResult, { kind: "approved" }> | null>(null)
const browserSignInReturnPath = ref<string | null>(null)
const browserSignInCompletion = createApprovedSignInCompletion(props.completeBrowserSignIn)
let browserSignInAttempt = 0
let resolveRequest: ((decision: "approve" | "reject") => void) | undefined
let resolveReplacement: (() => void) | undefined
let rejectReplacement: ((reason: Error) => void) | undefined
let abortHost: AbortController | undefined
let activeBrowserSignInChallenge: string | null = null

onMounted(() => {
  if (props.browserReturn) void finishBrowserSignInReturn()
  else if (props.initialMode === "signin") void beginBrowserSignIn()
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
  const diagnostic = await beginIdentityBrowserSignInDiagnostic("request")
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
    await diagnostic.beforeRedirect()
    if (attempt !== browserSignInAttempt) return
    busy.value = false
    window.location.assign(portalUrl)
  } catch (cause) {
    if (attempt !== browserSignInAttempt) return
    recordIdentityBrowserSignIn("request", "failed", { errorCode: "request_failed", elapsedMs: performance.now() - startedAt })
    diagnostic.end(new Error("Identity request failed"))
    error.value = cause instanceof Error ? cause.message : "Identity sign-in could not start"
  } finally {
    diagnostic.end()
    if (attempt === browserSignInAttempt) busy.value = false
  }
}

async function finishBrowserSignInReturn() {
  const attempt = ++browserSignInAttempt
  const startedAt = performance.now()
  const diagnostic = await beginIdentityBrowserSignInDiagnostic("callback")
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
    diagnostic.end(new Error("Identity callback failed"))
    restoreSignInReturnPath(trustedReturnPath)
  } finally {
    diagnostic.end()
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
    request.value = null
    resolveRequest = undefined
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

function cancel() {
  if (mode.value === "signin") {
    dismissBrowserSignIn()
    return
  }
  cancelReplacement()
  if (request.value) rejectRequest()
  abortHost?.abort()
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

      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button v-if="mode !== 'signin' && busy" class="button button-quiet" type="button" @click="cancel">Cancel</button>
        <button v-else class="button button-quiet" type="button" @click="mode === 'signin' ? dismissBrowserSignIn() : emit('close')">Close</button>
      </div>
    </section>
  </DialogWindow>
</template>
