import { bootstrapIdentity } from "../domain/identity"
import { defaultProofStore, validateCertificateChain, verifyWorkspaceGrant } from "../domain/proofs"
import type { WorkspaceGrant } from "../domain/model"
import type { DurableMesh } from "./durableMesh"
import type { KeeperPairing } from "./keeperPairing"
import { discoverKeeper } from "./keeperDiscovery"
import { getKeeperIntegrationStatus } from "./keeperPairing"
import type { PendingKeeperWithdrawal } from "./ownerKeeper"

type VerifiedStatus = Awaited<ReturnType<typeof getKeeperIntegrationStatus>>

function integrationForOrphan(pairing: KeeperPairing, status: VerifiedStatus) {
  const integration = status.integrations.find(item => item.integrationId === pairing.integrationId)
  if (!integration || integration.pendingOperation) return undefined
  const expected = pairing.expectedIntegrationRevision
  if (expected !== undefined && (!Number.isSafeInteger(expected) || integration.revision < expected)) return undefined
  return integration
}

function tombstonesCoverSavedGrants(pairing: KeeperPairing, integration: NonNullable<ReturnType<typeof integrationForOrphan>>,
  grantEpochs: Map<string, number>) {
  const workspaceIds = pairing.workspaces.map(workspace => workspace.id)
  if (!workspaceIds.length || new Set(workspaceIds).size !== workspaceIds.length) return false
  const selected = new Set(workspaceIds)
  if (integration.scopes.some(scope => selected.has(scope.workspaceId))) return false
  if (grantEpochs.size !== 0 && grantEpochs.size !== workspaceIds.length) return false
  const tombstones = new Map(integration.tombstones.map(item => [item.workspaceId, item]))
  if (workspaceIds.some(id => tombstones.has(id) !== grantEpochs.has(id))) return false
  for (const [workspaceId, epoch] of grantEpochs) {
    const tombstone = tombstones.get(workspaceId)
    if (!tombstone || tombstone.state !== "removed" || tombstone.cleanup !== "complete"
      || tombstone.grantEpoch < epoch) return false
  }
  return true
}

/** Require local grant epochs and the signed Rusty state to agree before unblocking an orphan. */
export function orphanStatusProvesCleanup(pairing: KeeperPairing, saved: PendingKeeperWithdrawal,
  status: VerifiedStatus, grantEpochs: Map<string, number>): boolean {
  if (!saved.grantScopes) return false
  const integration = integrationForOrphan(pairing, status)
  return !!integration && tombstonesCoverSavedGrants(pairing, integration, grantEpochs)
}

export function savedGrantEpoch(grant: unknown, workspaceId: string, targetPersonId: string): number | undefined {
  if (!grant || typeof grant !== "object") return undefined
  const signed = grant as { signerKeyId?: unknown; payload?: Record<string, unknown> }
  const payload = signed.payload
  const epoch = payload?.accessEpoch
  if (typeof signed.signerKeyId !== "string" || !payload || payload.kind !== "workspace-grant"
    || payload.version !== 1 || typeof payload.grantId !== "string" || !payload.grantId
    || payload.workspaceId !== workspaceId || payload.personId !== targetPersonId || payload.role !== "editor"
    || !Number.isSafeInteger(epoch) || (epoch as number) < 1) return undefined
  return epoch as number
}

export async function verifiedGrantEpochs(pairing: KeeperPairing, saved: PendingKeeperWithdrawal,
  ownerPublicKey: string, ownerPersonId: string, ownerCertificate: Awaited<ReturnType<typeof bootstrapIdentity>>["certificate"],
  certificates: Awaited<ReturnType<typeof defaultProofStore.listCertificates>>): Promise<Map<string, number> | undefined> {
  if (!saved.grantScopes) return undefined
  const certificatePool = [ownerCertificate, ...certificates]
  const epochs = new Map<string, number>()
  for (const scope of saved.grantScopes) {
    const grant = scope.grant as WorkspaceGrant | null
    const epoch = savedGrantEpoch(grant, scope.workspaceId, pairing.discovery.personId)
    const certificate = certificatePool.find(item => item.payload.deviceId === grant?.signerKeyId
      && item.payload.personId === ownerPersonId)
    if (!grant || !certificate || epoch === undefined || epochs.has(scope.workspaceId)
      || !pairing.workspaces.some(workspace => workspace.id === scope.workspaceId)
      || !(await validateCertificateChain(certificate, ownerPublicKey, certificatePool)).ok
      || !await verifyWorkspaceGrant(grant, certificate.payload.devicePublicKey)) return undefined
    epochs.set(scope.workspaceId, epoch)
  }
  return epochs
}

async function sameService(pairing: KeeperPairing) {
  const current = await discoverKeeper(pairing.discovery.origin)
  return current.origin === pairing.discovery.origin && current.personId === pairing.discovery.personId
    && current.deviceId === pairing.discovery.deviceId && current.publicKey === pairing.discovery.publicKey
    ? current : undefined
}

async function checkedControllerProfile(pairing: KeeperPairing) {
  if (!pairing.controllerFingerprint) return undefined
  const profile = await bootstrapIdentity()
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(profile.identity.publicKey)))
  const fingerprint = [...digest].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0"))
    .join("").match(/.{1,4}/g)?.join(":") ?? "unavailable"
  return fingerprint === pairing.controllerFingerprint ? profile : undefined
}

function signedStatusMatchesCurrentController(status: VerifiedStatus, ownerPersonId: string, service: Awaited<ReturnType<typeof sameService>>) {
  const receipt = status.signedStatus
  return !!receipt && !!service && receipt.payload.controllerPersonId === ownerPersonId
    && receipt.payload.servicePersonId === service.personId && receipt.payload.serviceDeviceId === service.deviceId
    && receipt.payload.serviceOrigin === service.origin && Number.isSafeInteger(status.revision)
}

async function completeLocalRevocations(epochs: Map<string, number>, servicePersonId: string,
  ensureMesh: () => Promise<DurableMesh | undefined>) {
  if (!epochs.size) return [] as Array<{ workspaceId: string; document: string; authorizationBundle: unknown }>
  const mesh = await ensureMesh()
  if (!mesh) throw new Error("Workspace mesh is unavailable; orphan cancellation remains pending.")
  const workspaceIds = [...epochs.keys()].sort()
  for (const workspaceId of workspaceIds) await mesh.revokePerson(workspaceId, servicePersonId, epochs.get(workspaceId)!)
  return mesh.captureRevocationCompletionScopes(workspaceIds, servicePersonId)
}

export async function resolveMissingKeeperPairing(pairing: KeeperPairing, saved: PendingKeeperWithdrawal,
  ensureMesh: () => Promise<DurableMesh | undefined>, statusLoader = getKeeperIntegrationStatus) {
  if (!saved.grantScopes || !pairing.workspaces.length) return undefined
  const profile = await checkedControllerProfile(pairing)
  if (!profile) return undefined
  const service = await sameService(pairing)
  if (!service) return undefined
  const certificates = await defaultProofStore.listCertificates()
  const epochs = await verifiedGrantEpochs(pairing, saved, profile.identity.publicKey, profile.identity.personId,
    profile.certificate, certificates)
  if (!epochs) return undefined
  const status = await statusLoader(service)
  if (!orphanStatusProvesCleanup(pairing, saved, status, epochs)) return undefined
  if (!signedStatusMatchesCurrentController(status, profile.identity.personId, service)) return undefined
  const receipt = status.signedStatus!
  const localRevocationScopes = await completeLocalRevocations(epochs, service.personId, ensureMesh)
  const resolved = await import("./ownerKeeper").then(({ saveKeeperOrphanResolution }) =>
    saveKeeperOrphanResolution(pairing.pairingId, saved.operationId, {
      verifiedAt: new Date().toISOString(), serviceRevision: status.revision,
      integrationRevision: status.integrations.find(item => item.integrationId === pairing.integrationId)!.revision,
      signedStatus: receipt, localRevocationScopes,
    }))
  return resolved
}
