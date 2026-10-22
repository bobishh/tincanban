import { createIdentityProfileRecovery, type IdentityProfileRecoveryFile } from "@meta-uber/mesh-identity"
import { createBrowserIdentityEnrollmentHost, connectBrowserIdentityEnrollment, serveIdentityProfileSync,
  syncProfileState, type BrowserIdentityEnrollmentHost, type PendingIdentityEnrollment,
  type IdentityEnrollmentRecovery } from "@meta-uber/mesh-runtime"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { bootstrapIdentity, isCurrentIdentityProfile, replaceWithEnrolledIdentityDevice, type LocalProfile } from "../domain/identity"
import type { PublicIdentity } from "../domain/model"
import { initializePersonalRootCatalog } from "../statePersonalRoot"
import { defaultStorage } from "../storage"
import { createIdentityEnrollmentProfileStore } from "../sync/identityEnrollmentProfile"
import { writeLocal } from "../localDb"
import { identityEnrollmentPrefix } from "./identityEnrollmentReceipt"

export type IdentityEnrollmentRequest = PendingIdentityEnrollment["request"]["payload"]

export async function startIdentityProfileHost(options: {
  profile: LocalProfile
  portalOrigin: string
  signal?: AbortSignal
  onInvite(inviteUrl: string): void
  onRequest(request: IdentityEnrollmentRequest): Promise<"approve" | "reject">
  onStatus(message: string): void
}): Promise<BrowserIdentityEnrollmentHost> {
  if (!options.profile.privateKeys.identityPrivateKey) throw new Error("This device cannot create a portable Identity profile")
  const certificates = await trustedCertificates(options.profile)
  const host = await createBrowserIdentityEnrollmentHost({ profile: options.profile, certificates,
    transportSeed: crypto.getRandomValues(new Uint8Array(32)), origin: options.portalOrigin })
  options.onInvite(host.inviteUrl)
  options.onStatus("Waiting for the Identity portal to connect…")
  try {
    const pending = await host.waitForEnrollment(options.signal)
    const request = pending.request.payload
    if (request.personId !== options.profile.identity.personId) {
      await pending.reject()
      throw new Error("The device request belongs to a different Identity")
    }
    options.onStatus("Verified device request is ready for your review.")
    const decision = await options.onRequest(request)
    if (decision !== "approve") {
      await pending.reject()
      throw new Error("Device request declined")
    }
    await approveIdentityDevice({ profile: options.profile, certificates, pending, onStatus: options.onStatus })
    return host
  } catch (error) {
    await host.close()
    throw error
  }
}

async function approveIdentityDevice(options: {
  profile: LocalProfile
  certificates: Awaited<ReturnType<typeof trustedCertificates>>
  pending: PendingIdentityEnrollment
  onStatus(message: string): void
}): Promise<void> {
  const ensureCurrent = () => {
    if (!isCurrentIdentityProfile(options.profile)) throw new Error("Local Identity changed before enrollment approval")
  }
  ensureCurrent()
  const root = await defaultStorage.loadPersonalRoot()
  if (!root || root.identity.personId !== options.profile.identity.personId) throw new Error("Personal Identity root is unavailable")
  ensureCurrent()
  options.onStatus("Preparing full Identity recovery package…")
  const recovery = await createIdentityProfileRecovery(options.profile, {
    displayName: root.identity.displayName,
    avatarData: root.photo?.avatarData ?? null,
    ...(root.profileState ? { profileState: root.profileState } : {}),
  }, "better", options.certificates)
  options.onStatus("Recovery package prepared. Sending the approved device response…")
  const approval = await options.pending.approve({ fullRecoveryConsent: true, recovery, ensureCurrent,
    persist: async (_identity, certificates) => {
      options.onStatus("New device acknowledged. Saving its trusted certificate…")
      await persistCertificates(certificates)
    } })
  ensureCurrent()
  options.onStatus("Saving signed Identity profile on the new device…")
  await syncNewPeer(options.profile, options.certificates, approval.connection, approval.remoteRoute,
    options.pending.request.payload.deviceId)
  await writeLocal(`${identityEnrollmentPrefix}${options.profile.identity.personId}`, JSON.stringify({
    personId: options.profile.identity.personId,
    deviceId: options.profile.device.deviceId,
    certificateHash: await certHashDefault(options.profile.certificate),
    completedAt: new Date().toISOString(),
  }))
}

export async function connectIdentityProfile(options: {
  profile: LocalProfile
  inviteUrl: string
  deviceLabel: string
  fullRecoveryConsent: boolean
  signal?: AbortSignal
  confirmReplacement(identity: Pick<PublicIdentity, "personId" | "displayName">): Promise<void>
  onRecovery(recovery: IdentityEnrollmentRecovery): Promise<void>
  onStatus(message: string): void
}): Promise<void> {
  throwIfAborted(options.signal)
  const before = await bootstrapIdentity()
  throwIfAborted(options.signal)
  if (before.identity.personId !== options.profile.identity.personId || !isCurrentIdentityProfile(options.profile)) {
    throw new Error("Local Identity changed before enrollment")
  }
  let replacementConfirmed = false
  const confirmReplacement = async (identity: Pick<PublicIdentity, "personId" | "displayName">) => {
    if (identity.personId === before.identity.personId) return
    await options.confirmReplacement(identity)
    throwIfAborted(options.signal)
    replacementConfirmed = true
  }
  const connected = await awaitConnectionUnlessAborted(connectBrowserIdentityEnrollment({ inviteUrl: options.inviteUrl,
    transportSeed: crypto.getRandomValues(new Uint8Array(32)), deviceLabel: options.deviceLabel,
    ...(options.fullRecoveryConsent ? { fullRecoveryConsent: true as const } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    acknowledgeRecovery: async (recovery, identity, callbackSignal) => {
      throwIfAborted(callbackSignal ?? options.signal)
      if (!recovery) throw new Error("Identity recovery package is invalid")
      if (recovery.file.personId !== identity.personId) throw new Error("Identity recovery package belongs to another person")
      await confirmReplacement(identity)
      throwIfAborted(callbackSignal ?? options.signal)
      await options.onRecovery(recovery)
      throwIfAborted(callbackSignal ?? options.signal)
    },
  }), options.signal)
  try {
    throwIfAborted(options.signal)
    if (connected.identity.personId !== before.identity.personId && !replacementConfirmed) {
      await confirmReplacement(connected.identity)
    }
    throwIfAborted(options.signal)
    if (!isCurrentIdentityProfile(before)) throw new Error("Local Identity changed before enrollment completed")
    options.onStatus("Adopting this approved device and saving the signed profile…")
    const adopted = connected.identity.personId === before.identity.personId
      ? await (await import("../domain/identity")).adoptEnrolledIdentityDevice(connected.profile, connected.certificates, before.identity.personId, undefined, options.signal)
      : await replaceWithEnrolledIdentityDevice(connected.profile, connected.certificates, before,
        { consentToReplaceExistingIdentity: replacementConfirmed, signal: options.signal })
    throwIfAborted(options.signal)
    const certificates = await trustedCertificates(adopted)
    throwIfAborted(options.signal)
    await persistCertificates(connected.certificates)
    throwIfAborted(options.signal)
    await initializePersonalRootCatalog(defaultStorage, adopted)
    throwIfAborted(options.signal)
    await syncNewPeer(adopted, certificates, connected.connection, connected.remoteRoute, connected.remoteRoute.deviceId)
    throwIfAborted(options.signal)
    const certificateHash = await certHashDefault(adopted.certificate)
    throwIfAborted(options.signal)
    await writeLocal(`${identityEnrollmentPrefix}${adopted.identity.personId}`, JSON.stringify({
      personId: adopted.identity.personId,
      deviceId: adopted.device.deviceId,
      certificateHash,
      completedAt: new Date().toISOString(),
    }))
  } finally {
    await connected.close()
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Identity enrollment was cancelled", "AbortError")
}

export async function awaitConnectionUnlessAborted<T extends { close(): Promise<void> }>(
  connectionPromise: Promise<T>, signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return await connectionPromise
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("Identity enrollment was cancelled", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    const connection = await Promise.race([connectionPromise, aborted])
    throwIfAborted(signal)
    return connection
  } catch (error) {
    if (signal.aborted) void connectionPromise.then(value => value.close(), () => undefined)
    throw error
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

async function syncNewPeer(profile: LocalProfile, certificates: Awaited<ReturnType<typeof trustedCertificates>>,
  connection: Parameters<typeof serveIdentityProfileSync>[0]["connection"], route: Parameters<typeof syncProfileState>[0]["route"],
  remoteDeviceId: string): Promise<void> {
  const store = createIdentityEnrollmentProfileStore(profile)
  const serving = serveIdentityProfileSync({ profile, certificates, connection, remoteDeviceId,
    current: store.current, commit: store.commit })
  try {
    await syncProfileState({ profile, certificates, connection, route, targetDeviceId: remoteDeviceId,
      current: store.current, commit: store.commit })
  } finally {
    await serving.close()
    await serving.done.catch(() => undefined)
  }
}

async function trustedCertificates(profile: LocalProfile) {
  const byDevice = new Map<string, NonNullable<Awaited<ReturnType<typeof defaultProofStore.listCertificates>>[number]>>()
  for (const certificate of [profile.certificate, ...await defaultProofStore.listCertificates()]) {
    if (certificate.payload.personId === profile.identity.personId) byDevice.set(certificate.payload.deviceId, certificate)
  }
  return [...byDevice.values()]
}

async function persistCertificates(certificates: readonly NonNullable<Awaited<ReturnType<typeof defaultProofStore.listCertificates>>[number]>[]) {
  for (const certificate of certificates) await defaultProofStore.putCertificate(await certHashDefault(certificate), certificate)
}

export function recoveryFileJson(file: IdentityProfileRecoveryFile): string {
  return JSON.stringify(file, null, 2)
}
