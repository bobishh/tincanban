import { z } from "zod"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import { publicKeyId, certificateHash, verifyDeviceCertificateChain, verifyIdentityAuthorityView } from "@meta-uber/mesh-identity"
import type { ChatRecord } from "../chat/records"
import { verifyPrivateProfileObservation } from "../chat/privateProfileObservation"
import { parsePrivateReplicaWire } from "./privateReplicaPreferences"
import type { PortableManagementRecord } from "./rustyManagementRepository"
import { verifyRustyManagementEvidence } from "./rustyManagementCapability"
import { validateIdentityRecoveryEvidence } from "./identityRecoveryState"
import { decodeIdentityDeviceState, IdentityDeviceStateUpgradeRequiredError } from "./identityDeviceStateCodec"
import { deviceCertificateSchema, deviceWorkspaceTransferSchema, personalRootTransferSchema } from "./identityDeviceTransferSchemas"
import { readIdentityDeviceExtensions } from "./identityDeviceExtensions"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { canonicalizeJson } from "../domain/identity"
import type { IdentityProfileState } from "../domain/identityProfileState"

export type DeviceWorkspaceTransfer = z.infer<typeof deviceWorkspaceTransferSchema>
const text = z.string().min(1).max(512)
const catalogSchema = z.object({ personId: text, personalRoot: personalRootTransferSchema,
  certificates: z.array(deviceCertificateSchema).min(1).max(512) }).strict()
const identityObservation = z.object({ kind: z.literal("identity-profile"), displayName: text,
  profileState: z.unknown().optional(),
  photo: personalRootTransferSchema.shape.photo, displayNamePreset: personalRootTransferSchema.shape.displayNamePreset }).strict()
const profileSchema = z.object({ personId: text, observations: z.array(z.union([identityObservation,
  z.object({ kind: z.literal("workspace-profile"), workspaceId: text, record: z.unknown() }).strict()])).min(1).max(513) }).strict()
const referenceSchema = z.object({ personId: text, workspaces: z.array(z.object({ workspaceId: text, documentId: text,
  grantHash: text, forgotten: z.boolean() }).strict()).max(512), enrollment: deviceWorkspaceTransferSchema.optional() }).strict()
const capabilitySchema = z.object({ personId: text, capabilities: z.array(z.object({
  binding: z.object({ origin: text, servicePublicKey: text, resourceKind: z.enum(["scope", "board", "person"]), resourceId: text }).strict(),
  capability: z.unknown(),
}).strict()).max(256) }).strict()

async function restoreProfileState(root: PersonalRootDocumentV1, causal: boolean): Promise<PersonalRootDocumentV1> {
  const state = await rootIdentityProfileState(root)
  if (causal) verifyProfilePresentationHistory(root, state)
  const projected = projectIdentityProfileRoot(root, state)
  if (causal && (root.identity.displayName !== projected.identity.displayName || canonicalizeJson(root.photo) !== canonicalizeJson(projected.photo))) {
    throw new Error("Profile presentation does not match its signed revision state")
  }
  return projected
}

function verifyProfilePresentationHistory(root: PersonalRootDocumentV1, state: IdentityProfileState): void {
  const observed = [...state.legacy, ...state.operations.map(operation => operation.signed.payload)]
  const nameKnown = observed.some(observation => observation.field === "name" && observation.value === root.identity.displayName)
  const photoKnown = !root.photo || observed.some(observation => observation.field === "photo" &&
    canonicalizeJson(observation.value) === canonicalizeJson(root.photo))
  if (!nameKnown || !photoKnown) throw new Error("Profile presentation is missing from its recorded history")
}

/** Complete preflight has no writes. Call only after authenticating the same-person envelope. */
export async function readIdentityDeviceTransfer(value: unknown, personId: string) {
  const manifest = decodeIdentityDeviceState(value, personId)
  readIdentityDeviceExtensions(manifest)
  const catalog = catalogSchema.parse(manifest.components.identityCatalog.value)
  const references = referenceSchema.parse(manifest.components.workspaceReferences.value)
  const profiles = profileSchema.parse(manifest.components.profileObservations.value)
  const capabilities = capabilitySchema.parse(manifest.components.ownerCapabilities.value)
  const authorityValue = manifest.components.identityAuthority.value.authorityView
  const authorityView = await verifyIdentityAuthorityView(authorityValue)
  const replicas = parsePrivateReplicaWire(manifest.components.privateConnections.value)
  const recoveryEvidence = { personId, envelopes: validateIdentityRecoveryEvidence(personId, manifest.components.recoveryEvidence.value) }
  if (catalog.personalRoot.identity.personId !== personId || catalog.certificates.some(cert => cert.payload.personId !== personId)) {
    throw new Error("Device-state catalog identity mismatch")
  }
  if (authorityView.personId !== personId || authorityView.identityPublicKey !== catalog.personalRoot.identity.publicKey) {
    throw new Error("Device-state Identity authority view binding mismatch")
  }
  const authorityCertificates = new Set(authorityView.certificates.map(certificate => canonicalizeJson(certificate)))
  if (catalog.certificates.some(certificate => !authorityCertificates.has(canonicalizeJson(certificate)))) {
    throw new Error("Device-state certificate is not covered by the Identity authority view")
  }
  const personalRoot = await restoreCatalog(catalog.personalRoot, references.workspaces, profiles.observations,
    manifest.components.profileObservations.schema)
  await verifyCatalogCertificates(personalRoot, catalog.certificates)
  const verifiedCapabilities: PortableManagementRecord[] = []
  for (const entry of capabilities.capabilities) {
    await verifyRustyManagementEvidence(entry.capability, entry.binding, { personId,
      resourceKind: entry.binding.resourceKind, resourceId: entry.binding.resourceId, minimumRevision: 0 })
    verifiedCapabilities.push(structuredClone(entry) as PortableManagementRecord)
  }
  const observations: { workspaceId: string; record: ChatRecord }[] = []
  for (const observation of profiles.observations) {
    if (observation.kind !== "workspace-profile") continue
    if (!references.workspaces.some(reference => reference.workspaceId === observation.workspaceId && !reference.forgotten)) {
      throw new Error("Private profile is missing its workspace reference")
    }
    const record = await verifyPrivateProfileObservation(observation.record, personalRoot.identity)
    observations.push({ workspaceId: observation.workspaceId, record })
  }
  return { manifest, personalRoot, certificates: catalog.certificates, enrollment: references.enrollment,
    replicas, capabilities: verifiedCapabilities, recoveryEvidence, observations, authorityView }
}

async function verifyCatalogCertificates(root: PersonalRootDocumentV1, certificates: DeviceCertificate[]): Promise<void> {
  if (await publicKeyId(root.identity.publicKey) !== root.identity.personId) throw new Error("Device-state identity does not match its key")
  const hashes = await Promise.all(certificates.map(certificateHash))
  const byHash = new Map(hashes.map((hash, index) => [hash, certificates[index]]))
  for (const certificate of certificates) {
    const chain: DeviceCertificate[] = [certificate]
    const seen = new Set<string>()
    let current = certificate
    while (current.payload.issuerCertificateHash !== null) {
      const parentHash = current.payload.issuerCertificateHash
      if (seen.has(parentHash) || chain.length >= 32) throw new Error("Invalid device-state certificate chain")
      seen.add(parentHash)
      const parent = byHash.get(parentHash)
      if (!parent) throw new Error("Missing device-state certificate ancestor")
      chain.push(parent)
      current = parent
    }
    await verifyDeviceCertificateChain(root.identity, certificate.payload.deviceId, chain, "MATCH/1")
  }
}

async function restoreCatalog(catalog: z.infer<typeof personalRootTransferSchema>, references: z.infer<typeof referenceSchema>["workspaces"],
  observations: z.infer<typeof profileSchema>["observations"], schema: string): Promise<PersonalRootDocumentV1> {
  if (Object.keys(catalog.workspaces).length || catalog.photo || catalog.displayNamePreset || catalog.profileState !== undefined) throw new Error("Device-state catalog contains duplicate component state")
  const identityProfiles = observations.filter(observation => observation.kind === "identity-profile")
  if (identityProfiles.length !== 1) throw new Error("Device state must contain one identity profile observation")
  const profile = identityProfiles[0]
  if (profile.kind !== "identity-profile" || profile.displayName !== catalog.identity.displayName) throw new Error("Device-state profile identity mismatch")
  const ids = new Set(references.map(reference => reference.workspaceId))
  if (ids.size !== references.length) throw new Error("Duplicate device-state workspace reference")
  const causal = schema === "profile-observations@3"
  if (causal !== (profile.profileState !== undefined)) throw new IdentityDeviceStateUpgradeRequiredError("Profile revision state does not match its required schema")
  const root: PersonalRootDocumentV1 = { ...catalog, workspaces: Object.fromEntries(references.map(reference => [reference.workspaceId, reference])),
    ...(profile.photo ? { photo: profile.photo } : {}), ...(profile.displayNamePreset ? { displayNamePreset: profile.displayNamePreset } : {}),
    ...(causal ? { profileState: profile.profileState as PersonalRootDocumentV1["profileState"] } : {}) }
  return restoreProfileState(root, causal)
}

export function requireEnrollmentTransfer(transfer: Awaited<ReturnType<typeof readIdentityDeviceTransfer>>): DeviceWorkspaceTransfer {
  if (!transfer.enrollment) throw new IdentityDeviceStateUpgradeRequiredError("Enrollment requires complete workspace transfer state")
  const declared = new Set(Object.keys(transfer.personalRoot.workspaces))
  if (transfer.enrollment.workspaces.some(workspace => !declared.has(workspace.id))) throw new Error("Enrollment workspace is missing from the private catalog")
  return transfer.enrollment
}
