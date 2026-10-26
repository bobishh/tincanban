import { canonicalizeJson, createDeviceAuthorizationRequest, encodeDeviceAuthorizationRequest, sha256Base64Url,
  parseDeviceAuthorizationApproval, type DeviceAuthorizationApproval, type DeviceAuthorizationRequest,
  type IdentityRustyServicePin, type LocalProfile } from "@meta-uber/mesh-identity"
import { safeReturnPath, validOrigin } from "./identityBrowserSignInNavigation"
import { discoverRustyService } from "@meta-uber/mesh-replication/rusty-management"

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
  personId?: string | null
  rustyServicePins?: IdentityRustyServicePin[]
  catalogOrigin?: string
}): Promise<{ pending: PendingIdentityBrowserSignIn; portalUrl: string }> {
  const now = options.now ?? Date.now()
  const portal = new URL(options.portalOrigin)
  const application = new URL(options.applicationOrigin)
  if (!validOrigin(portal.origin) || !validOrigin(application.origin) ||
      portal.origin !== options.portalOrigin || application.origin !== options.applicationOrigin) {
    throw new Error("Identity sign-in requires a secure app and portal origin")
  }
  const returnPath = safeReturnPath(options.returnPath)
  let rustyServicePins = options.rustyServicePins
  if (rustyServicePins === undefined && options.catalogOrigin?.trim()) {
    const service = await discoverRustyService(options.catalogOrigin.trim())
    rustyServicePins = [{ origin: service.origin, serviceId: service.serviceId, servicePublicKey: service.servicePublicKey }]
  }
  const challenge = options.challenge ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("")
  const request = await createDeviceAuthorizationRequest(options.profile, {
    applicationOrigin: application.origin,
    challenge,
    expiresAt: now + 120_000,
    personId: options.personId ?? null,
    includeIdentityCatalogAccess: true,
    ...(rustyServicePins ? { rustyServicePins } : {}),
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
  if (!encoded) throw new Error("Identity approval is missing")
  if (await profileFingerprint(options.currentProfile) !== options.pending.profileFingerprint) {
    throw new Error("Local app identity changed during sign-in")
  }
  const approval = await parseDeviceAuthorizationApproval(encoded, options.pending.request,
    { now: () => options.now ?? Date.now(), expectedExistingProfile: options.currentProfile })
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

