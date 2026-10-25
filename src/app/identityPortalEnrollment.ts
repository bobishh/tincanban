import { createIdentityProfileRecovery } from "@meta-uber/mesh-identity"
import { createBrowserIdentityEnrollmentHost, serveIdentityProfileSync,
  syncProfileState, type BrowserIdentityEnrollmentHost, type PendingIdentityEnrollment } from "@meta-uber/mesh-runtime"
import { defaultProofStore, certHashDefault } from "../domain/proofs"
import { isCurrentIdentityProfile, type LocalProfile } from "../domain/identity"
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
