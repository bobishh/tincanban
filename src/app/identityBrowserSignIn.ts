import { ref, type Ref } from "vue"
import { record } from "../sync/telemetry"
import type { DeviceAuthorizationRequest } from "@meta-uber/mesh-identity"
import type * as Protocol from "./identityBrowserSignInProtocol"
import type { PendingIdentityBrowserSignIn } from "./identityBrowserSignInProtocol"
import { identityBrowserReturnPath, safeReturnPath, validOrigin } from "./identityBrowserSignInNavigation"
export { identityBrowserReturnPath } from "./identityBrowserSignInNavigation"
export type { PendingIdentityBrowserSignIn, IdentityBrowserSignInResult } from "./identityBrowserSignInProtocol"

const identityBrowserSignInPendingKey = "tincanban.identity-browser-signin.pending.v1"
const identityBrowserSignInReturnKey = "tincanban.identity-browser-signin.return.v1"
const pendingRustyConnectionKey = "tincanban.identity-browser-signin.rusty.v1"

export type IdentityBrowserSignInPhase = "request" | "redirect" | "callback" | "adoption" | "refresh" | "catalog" | "boards" | "selection" | "restore" | "cancel"
export type IdentityBrowserSignInOutcome = "started" | "verified" | "completed" | "cancelled" | "pending" | "failed"

/** Keep this browser activity linked across the same-tab Identity redirect. */
export async function beginIdentityBrowserSignInDiagnostic(phase: "request" | "callback"): Promise<{
  end(exception?: unknown): void
  beforeRedirect(): Promise<void>
}> {
  try {
    const contexts = await import("../sync/diagnosticTraceContext")
    if (phase === "request") contexts.clearDiagnosticContinuation()
    const { beginDiagnosticOperation } = await import("../sync/telemetry")
    const operation = await beginDiagnosticOperation(`identity.browser_signin.${phase}`, {})
    contexts.rememberDiagnosticContinuation(operation.context)
    return {
      end: operation.end,
      async beforeRedirect() {
        operation.end()
        try { await (await import("../sync/telemetry")).flushTelemetryBeforeNavigation() }
        catch { /* Optional diagnostics cannot block sign-in. */ }
      },
    }
  } catch {
    return { end() {}, async beforeRedirect() {} }
  }
}

export function browserSignInFailureMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "Identity sign-in was interrupted. Select Sign in to try again."
  }
  return cause instanceof Error ? cause.message : "Identity sign-in failed"
}

/** Emit only fixed lifecycle fields; never include profile, device, request, or certificate data. */
export function recordIdentityBrowserSignIn(phase: IdentityBrowserSignInPhase, outcome: IdentityBrowserSignInOutcome,
  options: { errorCode?: "request_failed" | "callback_failed" | "adoption_failed" | "refresh_failed" | "catalog_failed" | "catalog_unavailable" | "catalog_pending" | "boards_failed" | "boards_pending" | "restore_failed";
    selection?: "saved" | "empty_default"; elapsedMs?: number } = {}) {
  try {
    record("identity.browser_signin", { phase, outcome,
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      ...(options.selection ? { operation: options.selection } : {}),
      ...(typeof options.elapsedMs === "number" && Number.isFinite(options.elapsedMs)
        ? { elapsedMs: Math.max(0, Math.round(options.elapsedMs)) } : {}) })
  } catch { /* Diagnostics must not affect sign-in. */ }
}

export function createIdentityBrowserSignInReturn(options: {
  showPortal: Ref<boolean>
  refreshIdentity(): Promise<void>
  closePortal(): void
  loadBoards?(returnPath: string): Promise<void | "approval_required">
  resolveReturnPath?(returnPath: string): string
  resumeRustyConnection?(origin: string, workspaceId: string): Promise<void>
  reportRustyConnectionFailure?(origin: string, cause: unknown): void
  /** Return true when pairing takes ownership of the restored route. */
  resumePairing?(): boolean | void
}) {
  const hasPendingRequest = window.sessionStorage.getItem(identityBrowserSignInPendingKey) !== null
  const hasReturn = window.sessionStorage.getItem(identityBrowserSignInReturnKey) !== null
  const returning = ref(shouldResumeIdentityBrowserSignIn(window.location.pathname, hasPendingRequest, hasReturn))
  const contextReady = ref(true)
  const boardLoading = ref(false)
  const boardLoadError = ref("")
  const boardCatalogApprovalRequired = ref(false)
  let boardLoad: Promise<void> | undefined

  function restoreReturnPath(returnPath: string) {
    window.history.replaceState(window.history.state, "", options.resolveReturnPath?.(returnPath) ?? returnPath)
    window.dispatchEvent(new Event("popstate"))
  }

  function retryBoards(returnPath = `${window.location.pathname}${window.location.search}`, restoreRoute = true): Promise<void> {
    if (boardLoad) return boardLoad
    boardLoading.value = true
    boardLoadError.value = ""
    boardCatalogApprovalRequired.value = false
    boardLoad = (async () => {
      try {
        if (await options.loadBoards?.(returnPath) === "approval_required") {
          boardCatalogApprovalRequired.value = true
          throw new Error("Your board catalog could not be received from Identity.")
        }
        if (restoreRoute) restoreReturnPath(returnPath)
        recordIdentityBrowserSignIn("restore", "completed")
      } catch (cause) {
        boardLoadError.value = `Signed in. Your boards have not finished loading. ${cause instanceof Error ? cause.message : ""}`.trim()
      } finally {
        contextReady.value = true
        boardLoading.value = false
        boardLoad = undefined
      }
    })()
    return boardLoad
  }
  options.showPortal.value = returning.value
  return {
    returning,
    contextReady,
    boardLoading,
    boardLoadError,
    boardCatalogApprovalRequired,
    retryBoards,
    close() { returning.value = false; options.closePortal(); options.resumePairing?.() },
    async complete(returnPath: string, request?: DeviceAuthorizationRequest) {
      contextReady.value = false
      const refreshStarted = performance.now()
      recordIdentityBrowserSignIn("refresh", "started")
      try {
        await options.refreshIdentity()
      } catch (error) {
        recordIdentityBrowserSignIn("refresh", "failed", { errorCode: "refresh_failed", elapsedMs: performance.now() - refreshStarted })
        throw error
      }
      recordIdentityBrowserSignIn("refresh", "completed", { elapsedMs: performance.now() - refreshStarted })
      const intent = readPendingRustyConnectionIntent(window.sessionStorage, false)
      if (intent && request?.payload.challenge === intent.challenge && "rustyServicePins" in request.payload &&
          (request.payload.rustyServicePins ?? []).some(pin => pin.origin === intent.origin && pin.serviceId === intent.serviceId)) {
        try { await options.resumeRustyConnection?.(intent.origin, intent.workspaceId) }
        catch (cause) { options.reportRustyConnectionFailure?.(intent.origin, cause) }
        finally { clearPendingRustyConnectionIntent(window.sessionStorage) }
      }
      restoreReturnPath(returnPath)
      returning.value = false
      options.showPortal.value = false
      const pairingResumed = options.resumePairing?.() === true
      await retryBoards(returnPath, !pairingResumed)
    },
  }
}

export function shouldResumeIdentityBrowserSignIn(pathname: string, hasPendingRequest: boolean, hasReturn: boolean): boolean {
  return hasPendingRequest && hasReturn && pathname === identityBrowserReturnPath
}

export function captureIdentityBrowserSignInReturn(options: {
  pathname: string
  hash: string
  storage: Pick<Storage, "setItem">
}): boolean {
  if (options.pathname !== identityBrowserReturnPath || !options.hash) return false
  options.storage.setItem(identityBrowserSignInReturnKey, options.hash)
  return true
}

export function readIdentityBrowserSignInReturn(storage: Pick<Storage, "getItem" | "removeItem">): string | null {
  const hash = storage.getItem(identityBrowserSignInReturnKey)
  storage.removeItem(identityBrowserSignInReturnKey)
  return hash
}

export function clearIdentityBrowserSignIn(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(identityBrowserSignInReturnKey)
  storage.removeItem(identityBrowserSignInPendingKey)
  storage.removeItem(pendingRustyConnectionKey)
}

export type PendingRustyConnectionIntent = {
  version: 1
  origin: string
  serviceId: string
  workspaceId: string
  challenge: string
}

export function writePendingRustyConnectionIntent(storage: Pick<Storage, "setItem">, intent: PendingRustyConnectionIntent): void {
  storage.setItem(pendingRustyConnectionKey, JSON.stringify(intent))
}

export function readPendingRustyConnectionIntent(storage: Pick<Storage, "getItem" | "removeItem">,
  consume = true): PendingRustyConnectionIntent | null {
  const raw = storage.getItem(pendingRustyConnectionKey)
  if (!raw) return null
  if (raw.length > 1_024) { storage.removeItem(pendingRustyConnectionKey); return null }
  try {
    const value = JSON.parse(raw) as PendingRustyConnectionIntent
    const origin = new URL(value.origin).origin
    if (value.version !== 1 || origin !== value.origin || !validOrigin(origin) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(value.serviceId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.workspaceId) ||
        !/^[a-f0-9]{64}$/u.test(value.challenge)) throw new Error("Invalid pending Rusty connection")
    if (consume) storage.removeItem(pendingRustyConnectionKey)
    return value
  } catch { storage.removeItem(pendingRustyConnectionKey); return null }
}

export function clearPendingRustyConnectionIntent(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(pendingRustyConnectionKey)
}

export type IdentityBrowserSignInCompletionPhase = "idle" | "pending" | "failed" | "complete"

/** Report profile refresh failures separately from the resumable board loader. */
export function createApprovedSignInCompletion(complete: (returnPath: string, request?: DeviceAuthorizationRequest) => Promise<void>) {
  const phase = ref<IdentityBrowserSignInCompletionPhase>("idle")
  const error = ref<string | null>(null)
  let returnPath: string | null = null

  async function run(request?: DeviceAuthorizationRequest): Promise<boolean> {
    if (phase.value !== "idle" || !returnPath) return false
    phase.value = "pending"
    error.value = null
    try {
      await complete(returnPath, request)
      phase.value = "complete"
      return true
    } catch (cause) {
      phase.value = "failed"
      error.value = `Identity approval was saved, but the app could not refresh your profile. ${cause instanceof Error ? cause.message : ""} Reload the app to retry.`
      return false
    }
  }

  return {
    phase,
    error,
    finish(path: string, request?: DeviceAuthorizationRequest) {
      returnPath = safeReturnPath(path)
      return run(request)
    },
    reset() {
      returnPath = null
      phase.value = "idle"
      error.value = null
    },
  }
}

export function writePendingIdentityBrowserSignIn(storage: Pick<Storage, "setItem">, pending: PendingIdentityBrowserSignIn): void {
  storage.setItem(identityBrowserSignInPendingKey, JSON.stringify(pending))
}

export function readPendingIdentityBrowserSignIn(storage: Pick<Storage, "getItem" | "removeItem">,
  expectedChallenge?: string, consume = true): PendingIdentityBrowserSignIn | null {
  const raw = storage.getItem(identityBrowserSignInPendingKey)
  if (!raw) return null
  if (raw.length > 12_000) { storage.removeItem(identityBrowserSignInPendingKey); return null }
  try {
    const value = JSON.parse(raw) as PendingIdentityBrowserSignIn
    if (!isPending(value)) { storage.removeItem(identityBrowserSignInPendingKey); return null }
    if (expectedChallenge !== undefined && value.request.payload.challenge !== expectedChallenge) return null
    if (consume) storage.removeItem(identityBrowserSignInPendingKey)
    return { request: value.request, returnPath: safeReturnPath(value.returnPath), profileFingerprint: value.profileFingerprint }
  } catch { storage.removeItem(identityBrowserSignInPendingKey); return null }
}

function isPending(value: unknown): value is PendingIdentityBrowserSignIn {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
      typeof value.returnPath !== "string" || typeof value.profileFingerprint !== "string" ||
      !/^[A-Za-z0-9_-]{20,}$/u.test(value.profileFingerprint) || !isRecord(value.request) ||
      !isRecord(value.request.payload)) return false
  return value.request.payload.kind === "mesh-device-authorization-request" &&
    typeof value.request.payload.challenge === "string" && typeof value.request.payload.applicationOrigin === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}


/** Load request cryptography only when the user signs in or an approval returns. */
export async function createIdentityBrowserSignIn(options: Parameters<typeof Protocol.createIdentityBrowserSignIn>[0]) {
  return (await import("./identityBrowserSignInProtocol")).createIdentityBrowserSignIn(options)
}

export async function verifyIdentityBrowserSignInReturn(options: Parameters<typeof Protocol.verifyIdentityBrowserSignInReturn>[0]) {
  return (await import("./identityBrowserSignInProtocol")).verifyIdentityBrowserSignInReturn(options)
}
