import { z } from "zod"
import { adoptEnrolledIdentity, fromBase64Url, signEnvelope, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import type { WorkspaceGrant } from "../domain/model"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { keyId, verifyDeviceChain } from "./meshRecords"
import type { DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { isMemberProfileData } from "../domain/avatarData"
import { newerIdentityPhoto } from "../app/identityPhoto"

const text = z.string().min(1).max(512)
const certificateSchema = z.object({
  payload: z.object({ kind: z.literal("device-certificate"), version: z.literal(1), personId: text,
    deviceId: text, devicePublicKey: text, issuerCertificateHash: text.nullable(), canEnrollDevices: z.literal(true) }),
  signerKeyId: text, signature: text,
})
const identitySchema = z.object({ personId: text, publicKey: text, displayName: text })
const keeperIntegrationSchema = z.object({
  integrationId: text,
  serviceOrigin: text,
  servicePersonId: text,
  serviceDeviceId: text,
  servicePublicKey: text,
  serviceCertificates: z.array(certificateSchema).max(32),
  workspaceIds: z.array(text).max(512),
  scopeReceipts: z.array(z.object({ workspaceId: text, grantEpoch: z.number().int().positive(), activationOperationId: text })).max(512).optional(),
  futureBoards: z.boolean(),
  futureBoardBaselineIds: z.array(text).max(512).optional(),
  revision: z.number().int().nonnegative(),
  state: z.enum(["active", "removing", "removed"]),
  verifiedAt: text,
  pendingRemoval: z.object({
    operationId: text,
    expectedRevision: z.number().int().nonnegative(),
    scopes: z.array(z.object({ workspaceId: text, expectedGrantEpoch: z.number().int().positive() })).max(512),
  }).optional(),
})
const rootSchema = z.object({ kind: z.literal("personal-root"), formatVersion: z.literal(1), rootId: text,
  identity: identitySchema,
  photo: z.custom<PersonalRootDocumentV1["photo"]>(value => isMemberProfileData(JSON.stringify(value))).optional(),
  displayNamePreset: z.string().min(1).max(256).optional(),
  devices: z.record(z.string(), z.object({ deviceId: text, publicKey: text, displayName: text, certificateHash: text, addedAt: text })),
  workspaces: z.record(z.string(), z.object({ workspaceId: text, documentId: text, grantHash: text, forgotten: z.boolean() })),
  keeperIntegrations: z.record(z.string(), keeperIntegrationSchema).optional(),
})
const requestPayload = z.object({ kind: z.literal("device-enrollment-request"), version: z.literal(2),
  invitationId: text, deviceId: text, publicKey: text, displayName: text })
const requestSchema = z.object({ payload: requestPayload, signerKeyId: text, signature: text })
const approvalSchema = z.object({
  payload: z.object({ kind: z.literal("device-enrollment-approval"), version: z.literal(2), invitationId: text,
    recipientDeviceId: text, certificate: certificateSchema, certificates: z.array(certificateSchema).min(1).max(32),
    personalRoot: rootSchema, workspaces: z.array(z.object({ id: text, title: text })).min(1).max(512),
    replicaPreferences: z.array(z.unknown()).max(128).optional(),
    activeWorkspaceId: text,
    meshWorkspaces: z.array(z.object({ workspaceId: text, ownerPersonId: text, ownerPublicKey: text }).passthrough()).max(512),
    grants: z.array(z.object({ payload: z.object({ kind: z.literal("workspace-grant"), version: z.literal(1), grantId: text,
      workspaceId: text, personId: text, role: z.enum(["owner", "editor", "visitor"]), accessEpoch: z.number().int().positive().optional() }),
      signerKeyId: text, signature: text }).passthrough()).max(512),
    snapshot: z.string().min(1),
  }), signerKeyId: text, signature: text,
})
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

export async function createEnrollmentRequest(invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  return encode(await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "device-enrollment-request", version: 2, invitationId: invite.invitationId,
    deviceId: profile.device.deviceId, publicKey: profile.device.publicKey, displayName: profile.device.displayName,
  }, profile.device.deviceId))
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
  activeWorkspaceId: string, meshWorkspaces: unknown[], grants: WorkspaceGrant[], snapshot: Uint8Array) {
  const certificates = [profile.certificate, ...(await defaultProofStore.listCertificates())]
    .filter(cert => cert.payload.personId === profile.identity.personId)
  const payload = {
    kind: "device-enrollment-approval", version: 2, invitationId: invite.invitationId,
    recipientDeviceId: certificate.payload.deviceId, certificate,
    certificates: [...new Map(certificates.map(cert => [cert.signature, cert])).values()],
    personalRoot, workspaces, activeWorkspaceId, meshWorkspaces, grants, snapshot: toBase64Url(snapshot),
    replicaPreferences: await (await import("./identityDevicePreferences")).readReplicaPreferences(profile.identity.personId),
  }
  // Optional mesh fields must have exactly the same shape when signed and sent as JSON.
  return encode(await signEnvelope(profile.privateKeys.devicePrivateKey, JSON.parse(JSON.stringify(payload)), profile.device.deviceId))
}

function hasMatchingEnrollmentContents(payload: z.infer<typeof approvalSchema>["payload"],
  invite: DeviceEnrollmentInvitation, profile: LocalProfile): boolean {
  const workspaceIds = new Set(payload.workspaces.map(item => item.id))
  const meshWorkspaceIds = new Set(payload.meshWorkspaces.map(item => item.workspaceId))
  const matchesInvite = payload.invitationId === invite.invitationId && payload.recipientDeviceId === profile.device.deviceId &&
    payload.personalRoot.identity.personId === invite.issuerPersonId && payload.certificate.payload.deviceId === profile.device.deviceId &&
    payload.certificate.payload.devicePublicKey === profile.device.publicKey && payload.certificate.payload.personId === invite.issuerPersonId
  const workspaceSetIsValid = workspaceIds.size === payload.workspaces.length && workspaceIds.has(payload.activeWorkspaceId) &&
    payload.meshWorkspaces.length === payload.workspaces.length && meshWorkspaceIds.size === payload.workspaces.length
  return matchesInvite && workspaceSetIsValid && payload.meshWorkspaces.every(item =>
    item.ownerPersonId === invite.issuerPersonId && item.ownerPublicKey === payload.personalRoot.identity.publicKey && workspaceIds.has(item.workspaceId))
}

export async function installEnrollment(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile, replacePersonId?: string) {
  const prepared = await preflightEnrollment(bytes, invite, profile)
  if (prepared.profile.identity.personId !== profile.identity.personId && replacePersonId !== profile.identity.personId) {
    throw new Error("Identity conflict: this device already belongs to another identity. Explicit replacement is required; identities and permissions are not merged.")
  }
  const existingRoot = profile.identity.personId === prepared.profile.identity.personId
    ? await defaultStorage.loadPersonalRoot() : await defaultStorage.loadPersonalRoot(prepared.payload.personalRoot.rootId)
  if (existingRoot?.identity.personId === prepared.profile.identity.personId) {
    const incoming = prepared.payload.personalRoot
    for (const [id, device] of Object.entries(incoming.devices)) {
      if (existingRoot.devices[id] && existingRoot.devices[id]!.publicKey !== device.publicKey) throw new Error("Identity conflict: a device id has different public keys")
    }
    prepared.payload.personalRoot = { ...incoming, rootId: existingRoot.rootId,
      devices: { ...existingRoot.devices, ...incoming.devices },
      photo: newerIdentityPhoto(existingRoot.photo, incoming.photo),
      workspaces: { ...incoming.workspaces, ...existingRoot.workspaces },
      keeperIntegrations: { ...incoming.keeperIntegrations, ...existingRoot.keeperIntegrations } }
  }
  for (const cert of prepared.certificates) await defaultProofStore.putCertificate(await certHashDefault(cert), cert)
  await defaultStorage.savePersonalRoot(prepared.payload.personalRoot)
  const enrolled = await adoptEnrolledIdentity(prepared.payload.personalRoot.identity, prepared.payload.certificate)
  if (prepared.payload.replicaPreferences) await (await import("./identityDevicePreferences")).receiveReplicaPreferences(enrolled.identity.personId, prepared.payload.replicaPreferences)
  return { ...prepared.payload, profile: enrolled }
}

/** Checks enrollment data without replacing the local identity or root. */
export async function preflightEnrollment(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const raw = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof raw?.error === "string") throw new Error(raw.error)
  const parsed = approvalSchema.safeParse(raw)
  if (!parsed.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const approval = parsed.data
  const payload = approval.payload
  // Verify the original envelope, before schema parsing can strip unknown fields.
  if (approval.signerKeyId !== invite.issuerDeviceId || !await verifyEnvelope(raw, invite.issuerPublicKey)) {
    throw new Error("Invalid device enrollment approval signature.")
  }
  if (payload.replicaPreferences) (await import("./identityDevicePreferences")).parseReplicaPreferences(payload.replicaPreferences)
  if (!hasMatchingEnrollmentContents(payload, invite, profile)) {
    throw new Error("Invalid device enrollment approval.")
  }
  const certificates = [...payload.certificates, payload.certificate]
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
  return { payload, certificates, profile: enrolled }
}
