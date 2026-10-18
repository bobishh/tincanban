import { z } from "zod"
import { adoptEnrolledIdentity, isCurrentIdentityProfile, fromBase64Url, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import type { WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { keyId, verifyDeviceChain } from "./meshRecords"
import type { DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { deviceCertificateSchema as certificateSchema, deviceWorkspaceTransferSchema } from "./identityDeviceTransferSchemas"
import { createIdentityDeviceTransfer, readIdentityDeviceTransfer, requireEnrollmentTransfer } from "./identityDeviceTransfer"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signingEvidence, signWithContext, type VerifiedSigningContext } from "../domain/signingContext"
import { activateIdentityDeviceTransfer, resumeIdentityDeviceActivation } from "./identityDeviceActivation"
import { readLocal, type LocalStatePlan } from "../localDb"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"

const text = z.string().min(1).max(512)
const requestPayload = z.object({ kind: z.literal("device-enrollment-request"), version: z.literal(2),
  invitationId: text, deviceId: text, publicKey: text, displayName: text })
const requestSchema = z.object({ payload: requestPayload, signerKeyId: text, signature: text })
const approvalSchema = z.object({
  payload: z.object({ kind: z.literal("device-enrollment-approval"), version: z.literal(3), invitationId: text,
    recipientDeviceId: text, certificate: certificateSchema, certificates: z.array(certificateSchema).min(1).max(32),
    deviceState: z.unknown(),
    snapshot: z.string().min(1),
  }).strict(), signerKeyId: text, signature: text,
}).passthrough()
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

export async function createEnrollmentRequest(invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const requestInvite = { ...invite }
  const requestProfile = structuredClone(profile)
  const binding = { invitationId: requestInvite.invitationId, deviceId: requestProfile.device.deviceId,
    publicKey: requestProfile.device.publicKey }
  const context = await resolveLocalSigningContext(requestProfile, "device-enrollment-request", binding)
  const signed = await signWithContext(context, {
    kind: "device-enrollment-request", version: 2, ...binding, displayName: requestProfile.device.displayName,
  })
  return encode(signed)
}

export async function readEnrollmentRequest(bytes: Uint8Array, invite: DeviceEnrollmentInvitation) {
  const parsed = requestSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
  if (!parsed.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const request = parsed.data
  if (request.payload.invitationId !== invite.invitationId || request.signerKeyId !== request.payload.deviceId ||
    await keyId(request.payload.publicKey) !== request.payload.deviceId ||
    !await verifyEnvelope(request, request.payload.publicKey)) throw new Error("Invalid device enrollment request.")
  return request.payload
}

export async function enrollmentPayload(invite: DeviceEnrollmentInvitation, profile: LocalProfile,
  certificate: DeviceCertificate, personalRoot: PersonalRootDocumentV1, workspaces: { id: string; title: string }[],
  activeWorkspaceId: string, meshWorkspaces: unknown[], grants: WorkspaceGrant[], snapshot: Uint8Array,
  suppliedContext?: VerifiedSigningContext) {
  invite = structuredClone(invite); profile = structuredClone(profile); certificate = structuredClone(certificate)
  personalRoot = structuredClone(personalRoot); workspaces = workspaces.map(({ id, title }) => ({ id, title }))
  meshWorkspaces = structuredClone(meshWorkspaces); grants = structuredClone(grants); snapshot = new Uint8Array(snapshot)
  const context = suppliedContext ?? await resolveLocalSigningContext(profile, "device-enrollment-approval", {
    invitationId: invite.invitationId, recipientDeviceId: certificate.payload.deviceId,
  })
  const evidence = signingEvidence(context)
  if (evidence.identity.personId !== personalRoot.identity.personId || context.deviceId !== profile.device.deviceId) {
    throw new Error("Enrollment signing context does not match the identity catalog")
  }
  const certificates = [profile.certificate, ...(await defaultProofStore.listCertificates())]
    .filter(cert => cert.payload.personId === profile.identity.personId)
  const deviceState = await createIdentityDeviceTransfer(personalRoot,
    [...new Map([...certificates, certificate].map(cert => [cert.signature, cert])).values()],
    deviceWorkspaceTransferSchema.parse({ workspaces, activeWorkspaceId, meshWorkspaces, grants }))
  const payload = {
    kind: "device-enrollment-approval", version: 3, invitationId: invite.invitationId,
    recipientDeviceId: certificate.payload.deviceId, certificate,
    certificates: evidence.certificates, deviceState, snapshot: toBase64Url(snapshot),
  }
  // Optional mesh fields must have exactly the same shape when signed and sent as JSON.
  return encode(await signWithContext(context, JSON.parse(JSON.stringify(payload))))
}

type EnrollmentContents = z.infer<typeof approvalSchema>["payload"] & { personalRoot: PersonalRootDocumentV1 } &
  NonNullable<Awaited<ReturnType<typeof readIdentityDeviceTransfer>>["enrollment"]>
function hasMatchingEnrollmentContents(payload: EnrollmentContents,
  invite: DeviceEnrollmentInvitation, profile: LocalProfile): boolean {
  const workspaceIds = new Set(payload.workspaces.map(item => item.id))
  const meshWorkspaceIds = new Set(payload.meshWorkspaces.map(item => item.workspaceId))
  const matchesInvite = payload.invitationId === invite.invitationId && payload.recipientDeviceId === profile.device.deviceId &&
    payload.personalRoot.identity.personId === invite.issuerPersonId && payload.certificate.payload.deviceId === profile.device.deviceId &&
    payload.certificate.payload.devicePublicKey === profile.device.publicKey && payload.certificate.payload.personId === invite.issuerPersonId
  const workspaceSetIsValid = workspaceIds.size === payload.workspaces.length && workspaceIds.has(payload.activeWorkspaceId) &&
    payload.meshWorkspaces.length === payload.workspaces.length && meshWorkspaceIds.size === payload.workspaces.length
  return matchesInvite && workspaceSetIsValid && payload.meshWorkspaces.every(item => workspaceIds.has(item.workspaceId))
}

export async function installEnrollment(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile, replacePersonId?: string) {
  const prepared = await preflightEnrollment(bytes, invite, profile)
  if (prepared.profile.identity.personId !== profile.identity.personId && replacePersonId !== profile.identity.personId) {
    throw new Error("Identity conflict: this device already belongs to another identity. Explicit replacement is required; identities and permissions are not merged.")
  }
  const enrolled = await adoptEnrolledIdentity(prepared.payload.personalRoot.identity, prepared.payload.certificate, async (adoption, ensureCurrent) => {
    if (adoption.publicProfile.device.deviceId !== profile.device.deviceId ||
      adoption.publicProfile.device.publicKey !== profile.device.publicKey) throw new Error("Enrollment device changed before activation")
    const plan: LocalStatePlan = { conditions: [{ key: adoption.storageKey, value: adoption.previousProfile }],
      writes: [{ key: adoption.storageKey, value: adoption.candidateProfile }] }
    if (adoption.backup) {
      plan.conditions.push({ key: adoption.backup.key, value: await readLocal(adoption.backup.key) })
      plan.writes.push(adoption.backup)
    }
    await activateIdentityDeviceTransfer(prepared.transfer, ensureCurrent, { adoption: plan, deferEffects: true })
  })
  await resumeIdentityDeviceActivation(enrolled.identity.personId, () => {
    if (!isCurrentIdentityProfile(enrolled)) throw new Error("Identity changed during enrollment recovery")
  }, true)
  prepared.payload.personalRoot = await defaultStorage.loadPersonalRoot() ?? prepared.payload.personalRoot
  return { ...prepared.payload, profile: enrolled }
}

/** Checks enrollment data without replacing the local identity or root. */
export async function preflightEnrollment(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const rawResult = z.record(z.string(), z.unknown()).safeParse(JSON.parse(new TextDecoder().decode(bytes)))
  if (!rawResult.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const raw = rawResult.data
  if (typeof raw.error === "string") throw new Error(raw.error)
  const parsed = approvalSchema.safeParse(raw)
  if (!parsed.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const approval = parsed.data
  // The passthrough schema keeps outer signed fields intact during validation.
  if (approval.signerKeyId !== invite.issuerDeviceId || !await verifyEnvelope(approval, invite.issuerPublicKey)) {
    throw new Error("Invalid device enrollment approval signature.")
  }
  const transfer = await readIdentityDeviceTransfer(approval.payload.deviceState, invite.issuerPersonId)
  const payload: EnrollmentContents = { ...approval.payload, ...requireEnrollmentTransfer(transfer), personalRoot: transfer.personalRoot }
  if (!hasMatchingEnrollmentContents(payload, invite, profile)) {
    throw new Error("Invalid device enrollment approval.")
  }
  const certificates = [...payload.certificates, payload.certificate, ...transfer.certificates]
  const issuerKey = await verifyDeviceChain({ personId: invite.issuerPersonId,
    publicKey: payload.personalRoot.identity.publicKey, deviceId: invite.issuerDeviceId, certificates })
  if (issuerKey !== invite.issuerPublicKey) throw new Error("Enrollment issuer does not match the invitation.")
  await verifyDeviceChain({ personId: invite.issuerPersonId, publicKey: payload.personalRoot.identity.publicKey,
    deviceId: profile.device.deviceId, certificates })
  // Validate encoded data before changing the local identity.
  fromBase64Url(payload.snapshot)
  const enrolled: LocalProfile = {
    identity: payload.personalRoot.identity,
    certificate: payload.certificate,
    device: profile.device,
    privateKeys: payload.personalRoot.identity.personId === profile.identity.personId
      ? profile.privateKeys
      : { devicePrivateKey: profile.privateKeys.devicePrivateKey },
  }
  for (const envelope of payload.meshWorkspaces) {
    meshRustRuntime().state.planInvitationCredential({ workspaceId: envelope.workspaceId, envelope,
      previousCredential: null, previousAuthority: null, localPersonId: enrolled.identity.personId,
      localGrant: payload.grants.find(grant => grant.payload.workspaceId === envelope.workspaceId && grant.payload.personId === enrolled.identity.personId) ?? null,
      updatedAt: new Date().toISOString() })
  }
  return { payload, certificates, profile: enrolled, transfer }
}
