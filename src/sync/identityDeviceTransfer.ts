import { exportIdentityPeerRecovery } from "./identityPeerRecoveryCatalog"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson } from "../domain/identity"
import { certificateHash } from "@meta-uber/mesh-identity"
import { chatStore } from "../chat/store"
import { getChatScope } from "../chat/service"
import { exportPrivateReplicaState } from "./privateReplicaRepository"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { exportIdentityRecoveryEvidence } from "./identityRecoveryState"
import { decodeIdentityDeviceState, encodeIdentityDeviceState, identityDeviceStateSchemas, type IdentityDeviceState } from "./identityDeviceStateCodec"
import { readIdentityDeviceTransfer, type DeviceWorkspaceTransfer } from "./identityDeviceTransferReader"
import { activateIdentityDeviceTransfer } from "./identityDeviceActivation"
import { exportIdentityDeviceExtensions } from "./identityDeviceExtensions"
import { readIdentityProfileQueue } from "./identityProfileProjectionQueue"
import { WorkspaceUnavailableError } from "../workspaceAvailability"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { projectLegacyEnrollmentCatalog } from "./legacyEnrollmentCatalog"
import { readIdentityStateRevision } from "../identityStateRevision"
import { projectRedundantDeviceCertificates } from "./identityDeviceTransferCertificateProjection"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { captureIdentityWorkspaceRouteRecovery, exportIdentityWorkspaceRouteRecovery,
  identityWorkspaceRouteRecoveryComponent } from "./identityWorkspaceRouteRecovery"
import { peerStore } from "./peerStore"
export { readIdentityDeviceTransfer, requireEnrollmentTransfer, type DeviceWorkspaceTransfer } from "./identityDeviceTransferReader"

async function ownProfileObservations(root: PersonalRootDocumentV1): Promise<{ kind: "workspace-profile"; workspaceId: string; record: unknown }[]> {
  const queued = (await readIdentityProfileQueue(root.identity)).filter(value => root.workspaces[value.workspaceId] && !root.workspaces[value.workspaceId].forgotten)
    .map(value => ({ kind: "workspace-profile" as const, ...value }))
  if (typeof indexedDB === "undefined") return queued
  const profiles = await Promise.all(Object.values(root.workspaces).filter(reference => !reference.forgotten)
    .map(async reference => {
      let scope: string
      try { scope = await getChatScope(reference.workspaceId) }
      catch (cause) { if (cause instanceof WorkspaceUnavailableError) return []; throw cause }
      return (await chatStore.loadProfiles(scope)).filter(profile => profile.personId === root.identity.personId)
        .map(profile => ({ kind: "workspace-profile" as const, workspaceId: reference.workspaceId, record: profile.record }))
    }))
  return [...new Map([...queued, ...profiles.flat()].map(value => [canonicalizeJson(value), value])).values()]
}

/** Capture the actual declared state sources; storage credentials and policy evidence have separate owners. */
export async function createIdentityDeviceTransfer(personalRoot: PersonalRootDocumentV1, certificates: DeviceCertificate[],
  enrollment?: DeviceWorkspaceTransfer, routeProfile?: LocalProfile): Promise<IdentityDeviceState> {
  personalRoot = structuredClone(personalRoot)
  certificates = structuredClone(certificates)
  const authorityView = await requireIdentityAuthorityView(personalRoot.identity.personId)
  if (authorityView.identityPublicKey !== personalRoot.identity.publicKey) throw new Error("Identity authority view does not match the local root")
  const projected = await projectRedundantDeviceCertificates(personalRoot, certificates)
  personalRoot = projected.root
  certificates = projected.certificates
  const coveredCertificates = new Set(authorityView.certificates.map(certificate => canonicalizeJson(certificate)))
  if (certificates.some(certificate => !coveredCertificates.has(canonicalizeJson(certificate)))) {
    throw new Error("Local certificate catalog is newer than the stored Identity authority view")
  }
  personalRoot = projectIdentityProfileRoot(personalRoot, await rootIdentityProfileState(personalRoot))
  enrollment = structuredClone(enrollment)
  certificates = await canonicalCertificates(certificates)
  personalRoot = await projectLegacyEnrollmentCatalog(personalRoot, certificates)
  const personId = personalRoot.identity.personId
  if (routeProfile && routeProfile.identity.personId !== personId) throw new Error("Workspace routes belong to another Identity")
  const [replicas, capabilities, recovery, profiles, extensions, peerRecovery, routeRecovery] = await Promise.all([
    exportPrivateReplicaState(personId), new RustyManagementRepository(personId).export(), exportIdentityRecoveryEvidence(personId),
    ownProfileObservations(personalRoot), exportIdentityDeviceExtensions(personId), exportIdentityPeerRecovery(personId),
    routeProfile ? captureIdentityWorkspaceRouteRecovery(peerStore, Object.values(personalRoot.workspaces)
      .filter(reference => !reference.forgotten).map(reference => reference.workspaceId), routeProfile)
      .then(async value => ({ workspaceRouteRecovery: await identityWorkspaceRouteRecoveryComponent(value) })) :
      exportIdentityWorkspaceRouteRecovery(personId, Object.values(personalRoot.workspaces)
        .filter(reference => !reference.forgotten).map(reference => reference.workspaceId)),
  ])
  const { workspaces, photo, displayNamePreset, profileState, ...catalog } = personalRoot
  const component = (schema: string, value: Record<string, unknown>) => ({ schema, required: true, value })
  const manifest: IdentityDeviceState = { kind: "identity-device-state", version: 1, personId, components: {
    ...extensions, ...peerRecovery, ...routeRecovery,
    identityCatalog: component(identityDeviceStateSchemas.identityCatalog, { personId, personalRoot: { ...catalog, workspaces: {} }, certificates }),
    profileObservations: component(identityDeviceStateSchemas.profileObservations, { personId, observations: [
      { kind: "identity-profile", displayName: personalRoot.identity.displayName, ...(photo ? { photo } : {}),
        profileState,
        ...(displayNamePreset ? { displayNamePreset } : {}) }, ...profiles,
    ] }),
    workspaceReferences: component(identityDeviceStateSchemas.workspaceReferences, { personId, workspaces: Object.values(workspaces),
      ...(enrollment ? { enrollment } : {}) }),
    privateConnections: component(replicas.version === 5 ? identityDeviceStateSchemas.privateConnections : replicas.version === 4 ? "private-rusty-connections@4" : "private-rusty-connections@3", replicas),
    ownerCapabilities: component(identityDeviceStateSchemas.ownerCapabilities, { personId, capabilities }),
    recoveryEvidence: component(identityDeviceStateSchemas.recoveryEvidence, recovery),
    identityAuthority: component(identityDeviceStateSchemas.identityAuthority, { personId, authorityView }),
  } }
  const normalized = decodeIdentityDeviceState(encodeIdentityDeviceState(manifest), personId)
  await readIdentityDeviceTransfer(normalized, personId)
  return normalized
}

async function canonicalCertificates(certificates: DeviceCertificate[]): Promise<DeviceCertificate[]> {
  if (!Array.isArray(certificates) || certificates.length < 1 || certificates.length > 512) {
    throw new Error("Invalid device-state certificate evidence")
  }
  const evidence = await Promise.all(certificates.map(async certificate => ({ certificate, hash: await certificateHash(certificate) })))
  evidence.sort((left, right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0)
  const unique = new Map<string, DeviceCertificate>()
  for (const entry of evidence) {
    const previous = unique.get(entry.hash)
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(entry.certificate)) {
      throw new Error("Conflicting device-state certificate evidence hash")
    }
    unique.set(entry.hash, entry.certificate)
  }
  return [...unique.values()]
}

/** Always validate and apply under the caller's live session guard; report only portable content changes. */
export async function applyIdentityDeviceTransfer(transfer: Awaited<ReturnType<typeof readIdentityDeviceTransfer>>,
  ensureCurrent: () => void): Promise<boolean> {
  ensureCurrent()
  const before = await readIdentityStateRevision()
  ensureCurrent()
  await activateIdentityDeviceTransfer(transfer, ensureCurrent)
  const after = await readIdentityStateRevision()
  ensureCurrent()
  return after !== before
}
