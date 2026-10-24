import { captureIdentityProfile } from "../domain/identity"
import { z } from "zod"
import { adoptEnrolledIdentity, isCurrentIdentityProfile, fromBase64Url, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import { identityDeviceCertificateChain, mergeIdentityAuthorityViews, verifyIdentityAuthorityView,
  publicKeyId, type IdentityAuthorityView, type VerifiedIdentityAuthorityView } from "@meta-uber/mesh-identity"
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
import { enrollmentManagementConflictResolver } from "./enrollmentManagementReconciliation"
import { readIdentityAuthorityView } from "./identityAuthorityStore"
import { parsePrivateReplicaConfig, parseReplicaConfig } from "./blindReplicaConfig"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { readIdentityRustyServicePin } from "./identityRustyServiceCatalog"
import type { Context } from "@opentelemetry/api"

const text = z.string().min(1).max(512)
const requestPayload = z.object({ kind: z.literal("device-enrollment-request"), version: z.literal(2),
  invitationId: text, deviceId: text, publicKey: text, displayName: text, identityAuthorityView: z.unknown().optional() })
const requestSchema = z.object({ payload: requestPayload, signerKeyId: text, signature: text })
const approvalSchema = z.object({
  payload: z.object({ kind: z.literal("device-enrollment-approval"), version: z.literal(3), invitationId: text,
    recipientDeviceId: text, certificate: certificateSchema, certificates: z.array(certificateSchema).min(1).max(32),
    deviceState: z.unknown(),
    snapshot: z.string().min(1),
  }).strict(), signerKeyId: text, signature: text,
}).passthrough()
const workspaceBootstrapSchema = z.object({
  payload: z.object({ kind: z.literal("device-workspace-bootstrap-approval"), version: z.literal(1),
    invitationId: text, personId: text, recipientDeviceId: text, workspaceId: text, authorityViewDigest: text,
    authorityView: z.unknown(),
    workspace: z.object({ id: text, title: text, reference: z.object({ workspaceId: text, documentId: text,
      grantHash: text, forgotten: z.boolean() }).strict() }).strict(),
    workspaces: z.array(z.object({ id: text, title: text }).strict()).length(1), activeWorkspaceId: text,
    meshWorkspaces: z.array(z.unknown()).length(1), grants: z.array(z.unknown()).max(1),
    storage: z.array(z.unknown()).min(1).max(32), identityStorage: z.array(z.unknown()).min(1).max(32),
    snapshot: z.string().min(1) }).strict(),
  signerKeyId: text, signature: text,
}).strict()
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
export type EnrollmentRequestInfo = { kind: "device-enrollment-request"; version: 2; invitationId: string;
  deviceId: string; publicKey: string; displayName: string; identityAuthorityView?: VerifiedIdentityAuthorityView }

/** Merge public Identity evidence monotonically, then authorize one exact active app key. */
export async function assertActiveIdentityEnrollmentDevice(current: IdentityAuthorityView, incoming: IdentityAuthorityView,
  personId: string, deviceId: string, devicePublicKey: string) {
  if (current.personId !== personId || incoming.personId !== personId) {
    throw new Error("Identity authority view belongs to another person")
  }
  const authorityView = await mergeIdentityAuthorityViews(current, incoming)
  const certificates = await identityDeviceCertificateChain({ personId, publicKey: authorityView.identityPublicKey, displayName: "" },
    authorityView, deviceId)
  if (certificates[0]?.payload.devicePublicKey !== devicePublicKey) throw new Error("Identity device key does not match the active certificate")
  return { authorityView, certificates }
}

export type SamePersonWorkspaceBootstrap = {
  authorityView: IdentityAuthorityView
  workspace: { id: string; title: string; reference: { workspaceId: string; documentId: string; grantHash: string; forgotten: boolean } }
  meshWorkspaces: unknown[]
  grants: WorkspaceGrant[]
  storage: BlindReplicaConfig[]
  identityStorage: IdentityReplicaConfig[]
  snapshot: Uint8Array
}

type SamePersonWorkspaceBootstrapInput = {
  invite: DeviceEnrollmentInvitation
  profile: LocalProfile
  recipientDeviceId: string
  recipientPublicKey: string
  authorityView: IdentityAuthorityView
  workspace: SamePersonWorkspaceBootstrap["workspace"]
  meshWorkspaces: unknown[]
  grants: WorkspaceGrant[]
  storage: BlindReplicaConfig[]
  identityStorage: IdentityReplicaConfig[]
  snapshot: Uint8Array
}

/** Sign one selected workspace bootstrap for a device already present in Identity authority. */
export async function createSamePersonWorkspaceBootstrap(input: SamePersonWorkspaceBootstrapInput) {
  const { invite, profile, recipientDeviceId } = input
  assertSamePersonBootstrapOwnerWorkspace(input)
  assertSamePersonBootstrapStoragePairing(input)
  if (input.meshWorkspaces.length !== 1 || input.grants.length > 1 || !(input.snapshot instanceof Uint8Array)) {
    throw new Error("Invalid same-person workspace bootstrap")
  }
  await assertActiveIdentityEnrollmentDevice(input.authorityView, input.authorityView, profile.identity.personId,
    recipientDeviceId, input.recipientPublicKey)
  await assertActiveIdentityEnrollmentDevice(input.authorityView, input.authorityView, profile.identity.personId,
    profile.device.deviceId, profile.device.publicKey)
  const { storage, identityStorage } = await normalizeSamePersonBootstrapStorage(input)
  const workspaceTransfer = deviceWorkspaceTransferSchema.parse({ workspaces: [{ id: input.workspace.id, title: input.workspace.title }],
    activeWorkspaceId: input.workspace.id, meshWorkspaces: input.meshWorkspaces, grants: input.grants })
  const binding = { invitationId: invite.invitationId, recipientDeviceId, workspaceId: input.workspace.id,
    authorityViewDigest: input.authorityView.viewDigest }
  const context = await resolveLocalSigningContext(profile, "device-workspace-bootstrap-approval", binding,
    { certificates: input.authorityView.certificates, currentAuthority: async () => {
      const current = await readIdentityAuthorityView(profile.identity.personId)
      return current?.viewDigest ?? ""
    }, expectedAuthority: input.authorityView.viewDigest })
  const payload = { kind: "device-workspace-bootstrap-approval" as const, version: 1 as const,
    invitationId: invite.invitationId, personId: profile.identity.personId, recipientDeviceId,
    workspaceId: input.workspace.id, authorityViewDigest: input.authorityView.viewDigest,
    authorityView: input.authorityView, workspace: structuredClone(input.workspace), ...workspaceTransfer,
    storage, identityStorage, snapshot: toBase64Url(input.snapshot) }
  const signed = await signWithContext(context, payload)
  const bytes = encode(signed)
  const wireApproval = JSON.parse(new TextDecoder().decode(bytes)) as typeof signed
  if (!await verifyEnvelope(wireApproval, profile.device.publicKey)) throw new Error("Workspace bootstrap did not verify after JSON encoding")
  return bytes
}

function assertSamePersonBootstrapOwnerWorkspace(input: SamePersonWorkspaceBootstrapInput) {
  if (input.invite.issuerPersonId !== input.profile.identity.personId ||
      input.authorityView.personId !== input.profile.identity.personId ||
      input.workspace.id !== input.workspace.reference.workspaceId || input.workspace.reference.forgotten) {
    throw new Error("Invalid same-person workspace bootstrap")
  }
}

function assertSamePersonBootstrapStoragePairing(input: SamePersonWorkspaceBootstrapInput) {
  const workspaceOrigins = new Set(input.storage.map(config => config.origin))
  const identityOrigins = new Set(input.identityStorage.map(config => config.origin))
  const identityMatchesWorkspace = input.identityStorage.every(config => config.personId === input.profile.identity.personId &&
    config.purpose === "identity" && input.storage.some(workspaceConfig => workspaceConfig.origin === config.origin &&
      workspaceConfig.servicePublicKey === config.servicePublicKey && workspaceConfig.scopeId !== config.scopeId))
  if (input.storage.length < 1 || input.storage.some(config => config.workspaceId !== input.workspace.id) ||
      workspaceOrigins.size !== input.storage.length || input.identityStorage.length !== workspaceOrigins.size ||
      identityOrigins.size !== input.identityStorage.length || !identityMatchesWorkspace) {
    throw new Error("Invalid same-person workspace bootstrap")
  }
}

async function normalizeSamePersonBootstrapStorage(input: SamePersonWorkspaceBootstrapInput) {
  const storage = input.storage.map(config => {
    const storageWire = { ...config, cursor: 0, lastUploaded: "" } as Record<string, unknown>
    delete storageWire.preferenceRevision
    const parsed = parseReplicaConfig(JSON.stringify(storageWire))
    if (parsed.workspaceId !== input.workspace.id || parsed.removalPending) throw new Error("Selected workspace Rusty access is unavailable")
    return parsed
  })
  const identityStorage = input.identityStorage.map(config => {
    const storageWire = { ...config, cursor: 0, lastUploaded: "" } as Record<string, unknown>
    delete storageWire.preferenceRevision
    const parsed = parsePrivateReplicaConfig(JSON.stringify(storageWire), input.profile.identity.personId)
    if (parsed.purpose !== "identity" || parsed.removalPending) throw new Error("Identity profile Rusty access is unavailable")
    return parsed
  })
  for (const config of [...storage, ...identityStorage]) {
    const pin = await readIdentityRustyServicePin(input.profile.identity.personId, config.origin)
    if (!pin || pin.servicePublicKey !== config.servicePublicKey || pin.serviceId !== await publicKeyId(config.servicePublicKey)) {
      throw new Error("Selected Rusty service is not pinned by the current Identity")
    }
  }
  return { storage, identityStorage }
}

/** Authenticate and narrow a same-person approval before any workspace or preference writes. */
export async function preflightSamePersonWorkspaceBootstrap(bytes: Uint8Array, invite: DeviceEnrollmentInvitation,
  profile: LocalProfile, requestAuthorityView: IdentityAuthorityView): Promise<SamePersonWorkspaceBootstrap> {
  const { payload, authorityView } = await verifySamePersonWorkspaceApproval(bytes, invite, profile)
  const authority = await acceptSamePersonWorkspaceAuthority(authorityView, invite, profile, requestAuthorityView)
  const { storage, identityStorage } = await parseSamePersonWorkspaceStorage(payload, profile)
  const transfer = deviceWorkspaceTransferSchema.parse({ workspaces: payload.workspaces, activeWorkspaceId: payload.activeWorkspaceId,
    meshWorkspaces: payload.meshWorkspaces, grants: payload.grants })
  const snapshot = fromBase64Url(payload.snapshot)
  if (payload.workspace.reference.workspaceId !== transfer.workspaces[0]?.id) throw new Error("Workspace reference differs from its transfer")
  return { authorityView: authority.authorityView, workspace: structuredClone(payload.workspace),
    meshWorkspaces: structuredClone(transfer.meshWorkspaces), grants: structuredClone(transfer.grants), storage, identityStorage, snapshot }
}

type WorkspaceBootstrapPayload = z.infer<typeof workspaceBootstrapSchema>["payload"]

async function verifySamePersonWorkspaceApproval(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const parsed = workspaceBootstrapSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
  if (!parsed.success) throw new Error("Invalid same-person workspace bootstrap")
  const approval = parsed.data
  if (approval.signerKeyId !== invite.issuerDeviceId) throw new Error("Same-person workspace bootstrap signer differs from the invite")
  if (!await verifyEnvelope(approval, invite.issuerPublicKey)) throw new Error("Invalid same-person workspace bootstrap signature")
  const payload = approval.payload
  assertSamePersonWorkspaceApprovalBinding(payload, invite, profile)
  const authorityView = await verifyIdentityAuthorityView(payload.authorityView)
  if (payload.authorityViewDigest !== authorityView.viewDigest || payload.workspaceId !== payload.workspace.id) {
    throw new Error("Same-person workspace approval authority binding is invalid")
  }
  return { payload, authorityView }
}

function assertSamePersonWorkspaceApprovalBinding(payload: WorkspaceBootstrapPayload,
  invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const validOwner = invite.issuerPersonId === profile.identity.personId && payload.personId === profile.identity.personId
  const validInvite = payload.invitationId === invite.invitationId && payload.recipientDeviceId === profile.device.deviceId
  const validWorkspace = payload.workspace.id === payload.workspace.reference.workspaceId && !payload.workspace.reference.forgotten &&
    payload.workspaces.length === 1 && payload.workspaces[0]?.id === payload.workspace.id && payload.activeWorkspaceId === payload.workspace.id
  const validTransfer = payload.meshWorkspaces.length === 1 && payload.grants.length <= 1
  if (!validOwner || !validInvite || !validWorkspace || !validTransfer) {
    throw new Error("Same-person workspace approval binding is invalid")
  }
}

async function acceptSamePersonWorkspaceAuthority(authorityView: IdentityAuthorityView, invite: DeviceEnrollmentInvitation,
  profile: LocalProfile, requestAuthorityView: IdentityAuthorityView) {
  const requestMerge = await assertActiveIdentityEnrollmentDevice(requestAuthorityView, authorityView, profile.identity.personId,
    profile.device.deviceId, profile.device.publicKey)
  const targetView = await readIdentityAuthorityView(profile.identity.personId)
  if (!targetView) throw new Error("Current Identity authority view is required for same-person device sync")
  const mergedTarget = await assertActiveIdentityEnrollmentDevice(targetView, requestMerge.authorityView,
    profile.identity.personId, profile.device.deviceId, profile.device.publicKey)
  await assertActiveIdentityEnrollmentDevice(mergedTarget.authorityView, mergedTarget.authorityView,
    profile.identity.personId, invite.issuerDeviceId, invite.issuerPublicKey)
  return mergedTarget
}

async function parseSamePersonWorkspaceStorage(payload: WorkspaceBootstrapPayload, profile: LocalProfile) {
  const storage = payload.storage.map(value => parseReplicaConfig(JSON.stringify(value)))
  if (storage.some(config => config.workspaceId !== payload.workspace.id || config.removalPending) ||
      new Set(storage.map(config => config.origin)).size !== storage.length) throw new Error("Workspace Rusty access binding is invalid")
  const identityStorage = payload.identityStorage.map(value => {
    const config = parsePrivateReplicaConfig(JSON.stringify(value), profile.identity.personId)
    if (config.purpose !== "identity") throw new Error("Identity profile Rusty access binding is invalid")
    return config
  })
  if (identityStorage.length !== storage.length || identityStorage.some(config => config.purpose !== "identity" || config.removalPending ||
      !storage.some(workspaceConfig => workspaceConfig.origin === config.origin && workspaceConfig.servicePublicKey === config.servicePublicKey &&
        workspaceConfig.scopeId !== config.scopeId)) ||
      new Set(identityStorage.map(config => config.origin)).size !== identityStorage.length) {
    throw new Error("Identity profile Rusty access binding is invalid")
  }
  await verifySamePersonWorkspaceServicePins(storage, identityStorage, profile.identity.personId)
  return { storage, identityStorage }
}

async function verifySamePersonWorkspaceServicePins(storage: BlindReplicaConfig[], identityStorage: IdentityReplicaConfig[], personId: string) {
  for (const config of [...storage, ...identityStorage]) {
    const pin = await readIdentityRustyServicePin(personId, config.origin)
    if (!pin || pin.servicePublicKey !== config.servicePublicKey || pin.serviceId !== await publicKeyId(config.servicePublicKey)) {
      throw new Error("Workspace Rusty service is not pinned by the current Identity")
    }
  }
}

export async function createEnrollmentRequest(invite: DeviceEnrollmentInvitation, profile: LocalProfile) {
  const requestInvite = { ...invite }
  const requestProfile = captureIdentityProfile(profile)
  const binding = { invitationId: requestInvite.invitationId, deviceId: requestProfile.device.deviceId,
    publicKey: requestProfile.device.publicKey }
  const context = await resolveLocalSigningContext(requestProfile, "device-enrollment-request", binding)
  const identityAuthorityView = requestInvite.issuerPersonId === requestProfile.identity.personId
    ? await readIdentityAuthorityView(requestProfile.identity.personId) : null
  if (requestInvite.issuerPersonId === requestProfile.identity.personId && !identityAuthorityView) {
    throw new Error("Current Identity authority view is required for same-person device sync")
  }
  if (identityAuthorityView) await assertActiveIdentityEnrollmentDevice(identityAuthorityView, identityAuthorityView,
    requestProfile.identity.personId, requestProfile.device.deviceId, requestProfile.device.publicKey)
  const signed = await signWithContext(context, {
    kind: "device-enrollment-request", version: 2, ...binding, displayName: requestProfile.device.displayName,
    ...(identityAuthorityView ? { identityAuthorityView } : {}),
  })
  return encode(signed)
}

export async function readEnrollmentRequest(bytes: Uint8Array, invite: DeviceEnrollmentInvitation): Promise<EnrollmentRequestInfo> {
  const parsed = requestSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
  if (!parsed.success) throw new Error("The other device needs an update. Reload both devices and create a new link.")
  const request = parsed.data
  if (request.payload.invitationId !== invite.invitationId || request.signerKeyId !== request.payload.deviceId ||
    await keyId(request.payload.publicKey) !== request.payload.deviceId ||
    !await verifyEnvelope(request, request.payload.publicKey)) throw new Error("Invalid device enrollment request.")
  if (request.payload.identityAuthorityView !== undefined) {
    const authorityView = await verifyIdentityAuthorityView(request.payload.identityAuthorityView)
    if (authorityView.personId !== invite.issuerPersonId) throw new Error("Same-person enrollment authority belongs to another Identity")
    await assertActiveIdentityEnrollmentDevice(authorityView, authorityView, authorityView.personId,
      request.payload.deviceId, request.payload.publicKey)
    return { ...request.payload, identityAuthorityView: authorityView } as EnrollmentRequestInfo
  }
  return { kind: request.payload.kind, version: request.payload.version, invitationId: request.payload.invitationId,
    deviceId: request.payload.deviceId, publicKey: request.payload.publicKey, displayName: request.payload.displayName }
}

export async function enrollmentPayload(invite: DeviceEnrollmentInvitation, profile: LocalProfile,
  certificate: DeviceCertificate, personalRoot: PersonalRootDocumentV1, workspaces: { id: string; title: string }[],
  activeWorkspaceId: string, meshWorkspaces: unknown[], grants: WorkspaceGrant[], snapshot: Uint8Array,
  suppliedContext?: VerifiedSigningContext) {
  invite = structuredClone(invite); profile = captureIdentityProfile(profile); certificate = structuredClone(certificate)
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

export async function installEnrollment(bytes: Uint8Array, invite: DeviceEnrollmentInvitation, profile: LocalProfile, replacePersonId?: string,
  ensureEnrollmentCurrent: () => void = () => {}, diagnosticContext?: Context) {
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
    const resolveManagementConflict = enrollmentManagementConflictResolver(prepared, profile, () => { ensureEnrollmentCurrent(); ensureCurrent() }, diagnosticContext)
    await activateIdentityDeviceTransfer(prepared.transfer, ensureCurrent, { adoption: plan, deferEffects: true, resolveManagementConflict })
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
