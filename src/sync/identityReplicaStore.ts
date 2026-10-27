import { canonicalizeJson, sha256Base64Url, type LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { defaultStorage } from "../storage"
import { defaultProofStore } from "../domain/proofs"
import { readIdentityStateRevision } from "../identityStateRevision"
import { IdentityReplica } from "./identityReplica"
import type { IdentityReplicaConfig } from "./blindReplication"
import { parsePrivateReplicaConfig } from "./blindReplicaConfig"
import { privateReplicaBinding, getPrivateReplicaProgress, persistPrivateReplicaState } from "./privateReplicaRepository"
import { createIdentityDeviceTransfer, applyIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { createIdentityReplicaRecord } from "./identityReplicaProtocol"
import { RustyManagementRepository, type ManagementBinding } from "./rustyManagementRepository"
import { readRustyManagementStatus } from "./rustyManagementClient"
import { verifyRustyManagementEvidence } from "./rustyManagementCapability"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { discoverBlindKeeper } from "./blindClient"
import { RustyPermissionMigrationRequiredError } from "./rustyPermissionMigration"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"
import { createRustyIdentityProfileScopeFetcher } from "./rustyIdentityTransport"
import { inventoryBlindObjects, downloadBlindObject, uploadBlindObject, type BlindAccess } from "./blindClient"
import { readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { captureIdentityWorkspaceRouteRecovery } from "./identityWorkspaceRouteRecovery"
import { peerStore } from "./peerStore"

/** Production ports keep private person state outside workspace/Worker replication adapters. */
export function createIdentityReplica(config: IdentityReplicaConfig, profile: LocalProfile, ensureCurrent: () => void,
  options: { includeRecoveryEvidence?: boolean } = {}) {
  const trackedProfile = profile
  const parsed = parsePrivateReplicaConfig(JSON.stringify(config), profile.identity.personId)
  if (parsed.purpose !== "identity") throw new Error("Private identity scope required")
  config = parsed
  profile = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
    certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } }
  const personId = profile.identity.personId
  const identityRevision = async () => {
    ensureCurrent()
    const [revision, root] = await Promise.all([readIdentityStateRevision(), defaultStorage.loadPersonalRoot()])
    if (root?.identity.personId !== personId) throw new Error("Private identity catalog is unavailable")
    const routes = await captureIdentityWorkspaceRouteRecovery(peerStore, Object.values(root.workspaces)
      .filter(reference => !reference.forgotten).map(reference => reference.workspaceId), profile)
    ensureCurrent()
    return `${revision}:${await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(routes)))}`
  }
  const scopeFetch = createRustyIdentityProfileScopeFetcher({ access: config, profile, ensureCurrent })
  const transport = {
    inventory: (access: BlindAccess, after: number) => inventoryBlindObjects(access, after, scopeFetch),
    download: (access: BlindAccess, id: string) => downloadBlindObject(access, id, scopeFetch),
    upload: (access: BlindAccess, object: Parameters<typeof uploadBlindObject>[1], requestId: string, observedSequence = 0) =>
      uploadBlindObject(access, object, requestId, observedSequence, scopeFetch),
  }
  const management: ManagementBinding = { origin: config.origin, servicePublicKey: config.servicePublicKey,
    resourceKind: "scope", resourceId: config.scopeId }
  const repository = new RustyManagementRepository(personId)
  const personBinding: ManagementBinding = { ...management, resourceKind: "person", resourceId: personId }
  const personAuthority = async (deviceId: string) => {
    const saved = await repository.read(personBinding)
    if (saved?.pending) throw new Error("Person policy transition is pending")
    if (saved?.capability?.payload.revokedDeviceIds.includes(deviceId)) throw new Error(
      `Private identity device is revoked by person policy: device=${deviceId}; localDevice=${profile.device.deviceId}; revision=${saved.capability.payload.revision}`)
    return saved?.capability ?? null
  }
  const authority = async () => {
    ensureCurrent()
    const saved = await repository.read(management)
    if (!saved?.capability || saved.pending) throw new Error("Private identity scope requires confirmed Rusty management policy")
    const cap = await verifyRustyManagementEvidence(saved.capability, management, { personId, resourceKind: "scope",
      resourceId: config.scopeId, minimumRevision: 1 })
    ensureCurrent()
    return cap
  }
  const authorize = async (deviceId: string, revision: number) => {
    await personAuthority(deviceId)
    const cap = await authority()
    if (revision > cap.revision || cap.revokedDeviceIds.includes(deviceId)) throw new Error("Private identity signer is revoked or its policy is unconfirmed")
  }
  const guard = async () => {
    ensureCurrent()
    await personAuthority(profile.device.deviceId)
    if (config.removalPending) throw new Error("Private identity scope removal is pending")
    await getPrivateReplicaProgress(personId, config)
    const cap = await authority()
    if (cap.revokedDeviceIds.includes(profile.device.deviceId)) throw new Error("Private identity device is revoked")
    ensureCurrent()
  }
  const replica = new IdentityReplica(config, privateReplicaBinding(personId, config), {
    runExclusive: operation => withPrivateReplicaOperation(personId, config, async () => { ensureCurrent(); return operation() }),
    repository: { read: () => getPrivateReplicaProgress(personId, config), commit: async (expected, next) => {
      await persistPrivateReplicaState(personId, config, expected, next, ensureCurrent)
    } },
    revision: identityRevision,
    capture: async () => {
      await guard()
      const cap = await authority()
      const root = await defaultStorage.loadPersonalRoot()
      if (root?.identity.personId !== personId) throw new Error("Private identity catalog is unavailable")
      const context = await resolveLocalSigningContext(profile, "identity-replica-state", { personId, origin: config.origin,
        scopeId: config.scopeId, keyEpoch: config.keyEpoch, managementRevision: cap.revision }, {
        ensureCurrent: guard, currentAuthority: async () => canonicalizeJson([await authority(), await personAuthority(profile.device.deviceId)]),
      })
      const certificates = [profile.certificate, ...await defaultProofStore.listCertificates()]
        .filter(certificate => certificate.payload.personId === personId)
      return createIdentityReplicaRecord(context, config, await createIdentityDeviceTransfer(root, certificates, undefined, profile), cap.revision)
    },
    merge: async transfer => {
      await guard()
      const selected = options.includeRecoveryEvidence === false ? await projectIdentityReplicaCatalogOnly(transfer, personId) : transfer
      if (await applyIdentityDeviceTransfer(selected, ensureCurrent)) identityDevicePreferencesChanged(personId)
    }, authorize, guard,
  }, transport)
  const refresh = async () => {
    ensureCurrent()
    const service = await discoverBlindKeeper(config.origin)
    if (service.servicePublicKey !== config.servicePublicKey) throw new Error("Private identity service pin changed")
    if (service.personManagement === 1) {
      const status = await readRustyManagementStatus(personBinding, profile, { ensureCurrent })
      if (status.migrationPending) throw new Error("Person policy migration is unfinished")
      if (!status.capability) throw new RustyPermissionMigrationRequiredError()
    } else if (await repository.read(personBinding)) throw new Error("Rusty upgrade required for saved person authority")
    const status = await readRustyManagementStatus(management, profile, { ensureCurrent })
    if (status.migrationPending || !status.capability) throw new Error("Private identity policy migration is unfinished")
    await guard()
  }
  const publishAfterPush = async (changed: boolean) => {
    ensureCurrent()
    if (changed) await (await import("./identityCatalogPublisher")).publishCurrentIdentityCatalogAccess(trackedProfile, config)
  }
  return { sync: async () => { await refresh(); const changed = await replica.sync(); await publishAfterPush(changed); return changed },
    pull: async () => { await refresh(); return replica.pull() },
    push: async () => { await refresh(); const changed = await replica.push(); await publishAfterPush(changed); return changed } }
}

export async function projectIdentityReplicaCatalogOnly(transfer: Awaited<ReturnType<typeof readIdentityDeviceTransfer>>,
  personId: string): Promise<Awaited<ReturnType<typeof readIdentityDeviceTransfer>>> {
  const manifest = structuredClone(transfer.manifest)
  manifest.components.recoveryEvidence = { ...manifest.components.recoveryEvidence,
    value: { personId, envelopes: [] } }
  return readIdentityDeviceTransfer(manifest, personId)
}
