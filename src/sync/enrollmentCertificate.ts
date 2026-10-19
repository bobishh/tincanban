import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { canonicalizeJson } from "../domain/identity"
import { certHashDefault } from "../domain/proofs"
import type { DeviceCertificate } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { assertSigningContextCurrent, signingEvidence, signWithContext, type VerifiedSigningContext } from "../domain/signingContext"
import type { StoredInvitation } from "./invitations"

type ApprovalPort = {
  getInvitation: (invitationId: string) => Promise<StoredInvitation | null>
  consume: (invite: StoredInvitation, approvedAt: string,
    stillCurrent: (current: StoredInvitation | null, now: number) => boolean) => boolean
}

function enrollmentApprovalPrecondition(invite: StoredInvitation | null, deviceId: string,
  profile: LocalProfile): string | null {
  if (!invite) return "Invitation not found"
  if (invite.kind !== "device-enrollment") return "Not a device-enrollment invitation"
  if (invite.status !== "redeeming" || invite.claimedByDeviceId !== deviceId) {
    return "Invitation not currently redeeming for this device"
  }
  if (!profile.certificate.payload.canEnrollDevices) return "This device cannot enroll other devices"
  if (invite.issuerPersonId !== profile.identity.personId || invite.issuerDeviceId !== profile.device.deviceId ||
      invite.issuerPublicKey !== profile.device.publicKey) return "Invitation issuer does not match the active signing device"
  return null
}

function enrollmentInvitationIdentity(invite: StoredInvitation): string {
  return canonicalizeJson([invite.version, invite.kind, invite.invitationId, invite.issuerPersonId, invite.issuerDeviceId,
    invite.issuerPublicKey, invite.issuerEndpoint, invite.createdAt, invite.expiresAt, invite.secret])
}

function hasEnrollmentIssuerEvidence(context: VerifiedSigningContext, profile: LocalProfile): boolean {
  const evidence = signingEvidence(context)
  return context.purpose === "device-certificate" && context.deviceId === profile.device.deviceId &&
    evidence.identity.personId === profile.identity.personId && evidence.identity.publicKey === profile.identity.publicKey &&
    evidence.publicKey === profile.device.publicKey && evidence.signerKeyId === profile.device.deviceId &&
    canonicalizeJson(evidence.certificates[0]) === canonicalizeJson(profile.certificate)
}

function matchingVerifiedAncestor(context: VerifiedSigningContext, profile: LocalProfile,
  recipientDevice: { deviceId: string; publicKey: string }): DeviceCertificate | undefined {
  return signingEvidence(context).certificates.find(certificate => certificate.payload.personId === profile.identity.personId &&
    certificate.payload.deviceId === recipientDevice.deviceId && certificate.payload.devicePublicKey === recipientDevice.publicKey)
}

export async function approveEnrollmentCertificate(
  invitationId: string,
  recipientDevice: { deviceId: string; publicKey: string; displayName?: string },
  profile: LocalProfile,
  suppliedContext: VerifiedSigningContext | undefined,
  port: ApprovalPort,
): Promise<{ ok: true; certificate: DeviceCertificate } | { ok: false; error: string }> {
  const invite = await port.getInvitation(invitationId)
  const precondition = enrollmentApprovalPrecondition(invite, recipientDevice.deviceId, profile)
  if (precondition) return { ok: false, error: precondition }
  if (!invite) return { ok: false, error: "Invitation not found" }
  const approvedInvite = structuredClone(invite)
  const invitationFingerprint = enrollmentInvitationIdentity(approvedInvite)
  const assertCurrentClaim = async () => {
    const current = await port.getInvitation(invitationId)
    if (!current || enrollmentInvitationIdentity(current) !== invitationFingerprint || current.status !== "redeeming" ||
        current.claimedByDeviceId !== recipientDevice.deviceId) {
      throw new Error("Enrollment invitation claim changed before approval")
    }
    return current
  }

  try {
    const issuerCertificateHash = await certHashDefault(profile.certificate)
    const certPayload = {
      kind: "device-certificate" as const,
      version: 1 as const,
      personId: profile.identity.personId,
      deviceId: recipientDevice.deviceId,
      devicePublicKey: recipientDevice.publicKey,
      issuerCertificateHash,
      canEnrollDevices: true as const,
    }
    await assertCurrentClaim()
    const context = suppliedContext ?? await resolveLocalSigningContext(profile, certPayload.kind, {
      personId: certPayload.personId, deviceId: certPayload.deviceId,
      devicePublicKey: certPayload.devicePublicKey, issuerCertificateHash,
    }, { ensureCurrent: async () => { await assertCurrentClaim() },
      currentAuthority: async () => {
        const current = await assertCurrentClaim()
        return canonicalizeJson([current.status, current.claimedByDeviceId, invitationFingerprint])
      } })
    if (!hasEnrollmentIssuerEvidence(context, profile)) throw new Error("Enrollment signing context does not contain the issuer certificate chain")
    await assertCurrentClaim()
    const existingAncestor = matchingVerifiedAncestor(context, profile, recipientDevice)
    let signedCert: DeviceCertificate
    if (existingAncestor) {
      signedCert = existingAncestor
    } else {
      signedCert = await signWithContext(context, certPayload)
      await verifyDeviceCertificateChain(profile.identity, recipientDevice.deviceId,
        [signedCert, ...signingEvidence(context).certificates])
    }
    await assertSigningContextCurrent(context)
    const current = await assertCurrentClaim()
    const consumed = port.consume(current, new Date().toISOString(), (stored, now) => !!stored && stored === current &&
      enrollmentInvitationIdentity(stored) === invitationFingerprint && stored.status === "redeeming" &&
      stored.claimedByDeviceId === recipientDevice.deviceId && Number.isFinite(Date.parse(stored.expiresAt)) &&
      Date.parse(stored.expiresAt) > now)
    if (!consumed) return { ok: false, error: "Enrollment invitation claim changed before approval" }
    return { ok: true, certificate: signedCert }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not approve device enrollment" }
  }
}
