import { ref, type Ref } from "vue"
import {
  canonicalizeJson,
  createDeviceAuthorizationRequest,
  encodeDeviceAuthorizationRequest,
  sha256Base64Url,
  verifyDeviceAuthorizationApproval,
  type DeviceAuthorizationApproval,
  type DeviceAuthorizationRequest,
  type LocalProfile,
} from "@meta-uber/mesh-identity"

export const identityBrowserReturnPath = "/identity/return"
const identityBrowserSignInPendingKey = "tincanban.identity-browser-signin.pending.v1"
const identityBrowserSignInReturnKey = "tincanban.identity-browser-signin.return.v1"

export function createIdentityBrowserSignInReturn(options: {
  showPortal: Ref<boolean>
  refreshIdentity(): Promise<void>
  closePortal(): void
}) {
  const returning = ref(window.location.pathname === identityBrowserReturnPath ||
    window.sessionStorage.getItem(identityBrowserSignInReturnKey) !== null ||
    window.sessionStorage.getItem(identityBrowserSignInPendingKey) !== null)
  options.showPortal.value = returning.value
  return {
    returning,
    close() { returning.value = false; options.closePortal() },
    async complete(returnPath: string) {
      await options.refreshIdentity()
      returning.value = false
      options.showPortal.value = false
      window.history.replaceState(window.history.state, "", returnPath)
    },
  }
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

export type PendingIdentityBrowserSignIn = {
  request: DeviceAuthorizationRequest
  returnPath: string
  profileFingerprint: string
}

export type IdentityBrowserSignInResult =
  | { kind: "cancelled"; returnPath: string }
  | { kind: "approved"; approval: DeviceAuthorizationApproval; returnPath: string; replacesIdentity: boolean }

export async function createIdentityBrowserSignIn(options: {
  profile: LocalProfile
  portalOrigin: string
  applicationOrigin: string
  returnPath: string
  now?: number
  challenge?: string
}): Promise<{ pending: PendingIdentityBrowserSignIn; portalUrl: string }> {
  const now = options.now ?? Date.now()
  const portal = new URL(options.portalOrigin)
  const application = new URL(options.applicationOrigin)
  if (!validOrigin(portal.origin) || !validOrigin(application.origin) ||
      portal.origin !== options.portalOrigin || application.origin !== options.applicationOrigin) {
    throw new Error("Identity sign-in requires a secure app and portal origin")
  }
  const returnPath = safeReturnPath(options.returnPath)
  const challenge = options.challenge ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("")
  const request = await createDeviceAuthorizationRequest(options.profile, {
    applicationOrigin: application.origin,
    challenge,
    expiresAt: now + 120_000,
    personId: null,
  })
  const pending: PendingIdentityBrowserSignIn = {
    request,
    returnPath,
    profileFingerprint: await profileFingerprint(options.profile),
  }
  const encoded = encodeDeviceAuthorizationRequest(request)
  const target = new URL("/authorize", portal.origin)
  target.hash = new URLSearchParams({ "device-request": encoded }).toString()
  return { pending, portalUrl: target.toString() }
}

export function writePendingIdentityBrowserSignIn(storage: Pick<Storage, "setItem">, pending: PendingIdentityBrowserSignIn): void {
  storage.setItem(identityBrowserSignInPendingKey, JSON.stringify(pending))
}

export function readPendingIdentityBrowserSignIn(storage: Pick<Storage, "getItem" | "removeItem">): PendingIdentityBrowserSignIn | null {
  const raw = storage.getItem(identityBrowserSignInPendingKey)
  storage.removeItem(identityBrowserSignInPendingKey)
  if (!raw || raw.length > 12_000) return null
  try {
    const value = JSON.parse(raw) as PendingIdentityBrowserSignIn
    if (!isPending(value)) return null
    return { request: value.request, returnPath: safeReturnPath(value.returnPath), profileFingerprint: value.profileFingerprint }
  } catch { return null }
}

export async function verifyIdentityBrowserSignInReturn(options: {
  hash: string
  pending: PendingIdentityBrowserSignIn
  currentProfile: LocalProfile
  applicationOrigin: string
  now?: number
}): Promise<IdentityBrowserSignInResult> {
  const values = new URLSearchParams(options.hash.replace(/^#/u, ""))
  const state = values.get("state")
  if (state !== options.pending.request.payload.challenge) throw new Error("Identity sign-in state did not match")
  if (values.get("cancelled") === "1") return { kind: "cancelled", returnPath: options.pending.returnPath }
  const encoded = values.get("approval")
  if (!encoded || encoded.length > 64_000 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("Identity approval is missing")
  if (await profileFingerprint(options.currentProfile) !== options.pending.profileFingerprint) {
    throw new Error("Local app identity changed during sign-in")
  }
  const approvalJson = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(encoded))
  const approvalValue = JSON.parse(approvalJson) as unknown
  const approval = await verifyDeviceAuthorizationApproval(approvalValue, options.pending.request,
    { now: () => options.now ?? Date.now() })
  const request = options.pending.request.payload
  if (approval.certificate.payload.deviceId !== options.currentProfile.device.deviceId ||
      approval.certificate.payload.devicePublicKey !== options.currentProfile.device.publicKey ||
      approval.identity.personId !== approval.certificate.payload.personId ||
      request.applicationOrigin !== options.applicationOrigin) {
    throw new Error("Identity approval belongs to another app device or origin")
  }
  return { kind: "approved", approval, returnPath: options.pending.returnPath,
    replacesIdentity: approval.identity.personId !== options.currentProfile.identity.personId }
}

async function profileFingerprint(profile: LocalProfile): Promise<string> {
  return await sha256Base64Url(new TextEncoder().encode(canonicalizeJson({
    identity: profile.identity,
    device: profile.device,
    certificate: profile.certificate,
  })))
}

function safeReturnPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith(identityBrowserReturnPath) || path.includes("\\")) {
    return "/"
  }
  return path
}

function validOrigin(origin: string): boolean {
  try {
    const value = new URL(origin)
    return value.origin === origin && !value.username && !value.password &&
      (value.protocol === "https:" || (value.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname)))
  } catch { return false }
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

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
