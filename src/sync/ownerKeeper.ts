import { readLocal, writeLocal } from "../localDb"
import { bootstrapIdentity } from "../domain/identity"
import type { KeeperIntegrationReference, PersonalRootDocumentV1 } from "../domain/model"
import { defaultStorage } from "../storage"
import { withLocalStateWriteLock } from "../localStateLock"

export type KeeperDetails = {
  origin?: string
  boardIds: string[]
  futureBoards: boolean
  futureBoardBaselineIds?: string[]
  integrationId?: string
  servicePersonId?: string
  serviceDeviceId?: string
  serviceDeviceIds?: string[]
  servicePublicKey?: string
  serviceCertificates?: unknown[]
  revision?: number
  integrationSettingsSupported?: boolean
  removalPending?: boolean
  localRevocationComplete?: boolean
}
export type OwnerKeeper = { personId: string; role: "visitor" | "editor"; details?: KeeperDetails }
const key = (ownerPersonId: string) => `tincanban.owner-keepers.v1:${ownerPersonId}`

export async function ownerKeepers(ownerPersonId: string): Promise<OwnerKeeper[]> {
  const raw = await readLocal(key(ownerPersonId))
  if (!raw) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(value)) return []
  const records = value as OwnerKeeper[]
  return records.filter(record => !!record && typeof record.personId === "string" &&
    (record.role === "visitor" || record.role === "editor"))
}

/** Existing scopes need explicit selection; future consent covers only later-created scopes. */
export function mayOfferFutureKeeperWorkspace(details: KeeperDetails | undefined, workspaceId: string): boolean {
  return details?.futureBoards === true
    && Array.isArray(details.futureBoardBaselineIds)
    && !details.futureBoardBaselineIds.includes(workspaceId)
}

export async function saveOwnerKeeper(ownerPersonId: string, keeper: OwnerKeeper) {
  await withLocalStateWriteLock(key(ownerPersonId), async () => {
    const records = await ownerKeepers(ownerPersonId)
    const previous = records.find(record => record.personId === keeper.personId)
    await assertOwnerKeeperWriteIsCurrent(ownerPersonId, previous, keeper)
    await writeLocal(key(ownerPersonId), JSON.stringify([
      ...records.filter(record => record.personId !== keeper.personId),
      { ...previous, ...keeper },
    ]))
  })
}

export async function removeOwnerKeeper(ownerPersonId: string, personId: string,
  expected?: { integrationId: string; throughRevision: number }) {
  await withLocalStateWriteLock(key(ownerPersonId), async () => {
    const records = await ownerKeepers(ownerPersonId)
    const current = records.find(record => record.personId === personId)
    if (expected && !canRemoveOwnerKeeperCache(current, expected)) return
    await writeLocal(key(ownerPersonId), JSON.stringify(records.filter(record => record.personId !== personId)))
  })
}

async function assertOwnerKeeperWriteIsCurrent(ownerPersonId: string, previous: OwnerKeeper | undefined, next: OwnerKeeper) {
  const currentDetails = previous?.details
  const nextDetails = next.details ?? currentDetails
  if (currentDetails?.integrationId && currentDetails.integrationId === nextDetails?.integrationId) {
    assertSameIntegrationCacheWrite(currentDetails, nextDetails)
  }
  if (nextDetails?.integrationId) {
    await assertCanonicalKeeperCacheTarget(ownerPersonId, next.personId, nextDetails!)
  }
}

async function assertCanonicalKeeperCacheTarget(ownerPersonId: string, personId: string, target: KeeperDetails) {
  const { root, integrations } = await keeperIntegrationReferences()
  if (root?.identity.personId !== ownerPersonId) {
    throw new Error("Keeper cache owner identity does not match the canonical personal root.")
  }
  const current = Object.values(integrations).filter(reference =>
    reference.servicePersonId === personId && reference.state !== "removed")
  if (current.length === 1 && current[0].integrationId === target.integrationId && current[0].revision === target.revision) return
  throw new Error(`Keeper cache write is not the current canonical integration for ${ownerPersonId}.`)
}

function assertSameIntegrationCacheWrite(currentDetails: KeeperDetails, nextDetails: KeeperDetails) {
  const currentRevision = currentDetails.revision
  const nextRevision = nextDetails.revision
  if (Number.isSafeInteger(currentRevision) && Number.isSafeInteger(nextRevision) && nextRevision! < currentRevision!) {
    throw new Error("An earlier keeper cache write cannot replace a newer integration revision.")
  }
  if (currentDetails.removalPending && !nextDetails.removalPending
    && (!Number.isSafeInteger(currentRevision) || !Number.isSafeInteger(nextRevision) || nextRevision! <= currentRevision!)) {
    throw new Error("Keeper cache removal intent cannot be cleared without a newer integration revision.")
  }
}

function canRemoveOwnerKeeperCache(current: OwnerKeeper | undefined,
  expected: { integrationId: string; throughRevision: number }) {
  if (!current) return true
  // A verified terminal receipt may clear a legacy locator with no integration binding.
  // Modern cache rows remain fenced by integration ID and revision.
  if (!current.details?.integrationId) return true
  if (current.details?.integrationId !== expected.integrationId) return false
  const currentRevision = current.details.revision
  // Missing legacy revision cannot outrank a verified terminal service receipt.
  return !Number.isSafeInteger(currentRevision) || currentRevision! <= expected.throughRevision
}

/** Reconcile locally saved settings after a verified durable activation receipt. */
export async function rememberActivatedKeeper(ownerPersonId: string, personId: string, details: KeeperDetails) {
  // Rusty integrations are provisioned only with the independent owner-signed
  // Editor grant; generic peer invitations continue to use their chosen role.
  await saveOwnerKeeper(ownerPersonId, { personId, role: "editor", details })
}

export async function keeperIntegrationReferences(root?: PersonalRootDocumentV1) {
  const profile = await bootstrapIdentity()
  const current = root ?? await defaultStorage.loadPersonalRoot()
  if (!current || current.identity.personId !== profile.identity.personId) throw new Error("Personal root does not belong to this identity.")
  return { root: current, integrations: current.keeperIntegrations ?? {} }
}

async function updateCurrentPersonalRoot(
  update: (root: PersonalRootDocumentV1) => PersonalRootDocumentV1,
): Promise<PersonalRootDocumentV1> {
  const profile = await bootstrapIdentity()
  const root = await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, current => {
    if (!current) throw new Error("Personal identity is unavailable. Reload and try again.")
    return update(current)
  })
  if (!root) throw new Error("Personal identity is unavailable. Reload and try again.")
  return root
}

export async function saveKeeperIntegrationReference(reference: KeeperIntegrationReference) {
  if (!reference.integrationId || !reference.serviceOrigin || !reference.servicePersonId || !reference.serviceDeviceId
    || !Number.isSafeInteger(reference.revision) || reference.revision < 0) throw new Error("Keeper descriptor is invalid.")
  // References cross Vue component boundaries; serialize at this JSON persistence boundary to strip proxies.
  const serializable = JSON.parse(JSON.stringify(reference)) as KeeperIntegrationReference
  await updateCurrentPersonalRoot(root => {
    const current = root.keeperIntegrations?.[reference.integrationId]
    if (current) assertKeeperReferenceWriteIsCurrent(current, serializable)
    root.keeperIntegrations = { ...root.keeperIntegrations, [reference.integrationId]: serializable }
    return root
  })
}

function assertKeeperReferenceWriteIsCurrent(current: KeeperIntegrationReference, next: KeeperIntegrationReference) {
  if (next.revision < current.revision) throw new Error("An earlier keeper receipt cannot replace newer integration state.")
  if (next.revision > current.revision) return
  assertSameRevisionCompatible(current, next)
}

function assertSameRevisionCompatible(current: KeeperIntegrationReference, next: KeeperIntegrationReference) {
  if (current.pendingRemoval && !sameOperation(current.pendingRemoval, next.pendingRemoval)) {
    throw new Error("Keeper removal intent changed at the same service revision.")
  }
  if (current.pendingSettings && !sameOperation(current.pendingSettings, next.pendingSettings)) {
    throw new Error("Keeper settings intent changed at the same service revision.")
  }
  if (current.state === "removed" && next.state !== "removed") {
    throw new Error("Same-revision keeper write cannot reactivate a removed integration.")
  }
  if (current.state === "active" && next.state === "removed") {
    throw new Error("Keeper removal requires a newer signed integration revision.")
  }
  if (sameReferenceAuthority(current, next)) return
  if (sameReferenceData(current, next) && (isNewRemovalIntent(current, next) || isNewSettingsIntent(current, next))) return
  throw new Error("Keeper scopes or policy changed without a newer signed integration revision.")
}

function isNewRemovalIntent(current: KeeperIntegrationReference, next: KeeperIntegrationReference) {
  return !current.pendingRemoval && next.pendingRemoval?.expectedRevision === current.revision && next.state === "removing"
}

function isNewSettingsIntent(current: KeeperIntegrationReference, next: KeeperIntegrationReference) {
  return !current.pendingSettings && next.pendingSettings?.expectedRevision === current.revision && current.state === next.state
}

function sameOperation<T extends { operationId: string }>(current: T, next: T | undefined) {
  return !!next && JSON.stringify(current) === JSON.stringify(next)
}

function sameReferenceAuthority(current: KeeperIntegrationReference, next: KeeperIntegrationReference) {
  return current.state === next.state && sameReferenceData(current, next)
}

function sameReferenceData(current: KeeperIntegrationReference, next: KeeperIntegrationReference) {
  return current.integrationId === next.integrationId
    && current.serviceOrigin === next.serviceOrigin
    && current.servicePersonId === next.servicePersonId
    && current.serviceDeviceId === next.serviceDeviceId
    && current.servicePublicKey === next.servicePublicKey
    && JSON.stringify(current.workspaceIds) === JSON.stringify(next.workspaceIds)
    && JSON.stringify(current.scopeReceipts ?? []) === JSON.stringify(next.scopeReceipts ?? [])
    && current.futureBoards === next.futureBoards
    && JSON.stringify(current.futureBoardBaselineIds ?? []) === JSON.stringify(next.futureBoardBaselineIds ?? [])
}

function withdrawalKey(pairingId: string, operationId: string) {
  return `${encodeURIComponent(pairingId)}.${encodeURIComponent(operationId)}`
}

export type PendingKeeperWithdrawal = {
  pairingId: string
  operationId: string
  pairing: Record<string, unknown>
  grantScopes?: Array<{ workspaceId: string; document: string; authorizationBundle: unknown; grant: unknown }>
  orphanResolution?: { verifiedAt: string; serviceRevision: number; integrationRevision: number;
    signedStatus: { payload: Record<string, unknown>; signerKeyId: string; signature: string };
    localRevocationScopes: Array<{ workspaceId: string; document: string; authorizationBundle: unknown }> }
}

export async function pendingKeeperWithdrawal(pairingId: string, operationId: string): Promise<PendingKeeperWithdrawal | undefined> {
  const { root } = await keeperIntegrationReferences()
  return root.pendingKeeperWithdrawals?.[withdrawalKey(pairingId, operationId)] as PendingKeeperWithdrawal | undefined
}

export async function pendingKeeperWithdrawals(): Promise<PendingKeeperWithdrawal[]> {
  const { root } = await keeperIntegrationReferences()
  return Object.values(root.pendingKeeperWithdrawals ?? {}) as PendingKeeperWithdrawal[]
}

export async function saveKeeperOrphanResolution(pairingId: string, operationId: string,
  resolution: NonNullable<PendingKeeperWithdrawal["orphanResolution"]>) {
  const key = withdrawalKey(pairingId, operationId)
  let saved: PendingKeeperWithdrawal | undefined
  await updateCurrentPersonalRoot(root => {
    const previous = root.pendingKeeperWithdrawals?.[key] as PendingKeeperWithdrawal | undefined
    if (!previous) throw new Error("Keeper cancellation history was not saved; verified status remains available for retry.")
    saved = JSON.parse(JSON.stringify({ ...previous, orphanResolution: resolution })) as PendingKeeperWithdrawal
    root.pendingKeeperWithdrawals = { ...root.pendingKeeperWithdrawals, [key]: saved }
    return root
  })
  return saved!
}

export async function savePendingKeeperWithdrawal(pairingId: string, operationId: string, pairing: Record<string, unknown>,
  grantScopes?: Array<{ workspaceId: string; document: string; authorizationBundle: unknown; grant: unknown }>): Promise<PendingKeeperWithdrawal> {
  const key = withdrawalKey(pairingId, operationId)
  const serializable = JSON.parse(JSON.stringify({ pairingId, operationId, pairing, grantScopes })) as PendingKeeperWithdrawal
  let saved = serializable
  await updateCurrentPersonalRoot(root => {
    const previous = root.pendingKeeperWithdrawals?.[key] as PendingKeeperWithdrawal | undefined
    if (previous) { saved = previous; return root }
    root.pendingKeeperWithdrawals = { ...root.pendingKeeperWithdrawals, [key]: serializable }
    return root
  })
  return saved
}

export async function savePendingKeeperWithdrawalProofs(pairingId: string, operationId: string,
  grantScopes: Array<{ workspaceId: string; document: string; authorizationBundle: unknown; grant: unknown }>) {
  const key = withdrawalKey(pairingId, operationId)
  let saved: PendingKeeperWithdrawal | undefined
  await updateCurrentPersonalRoot(root => {
    const previous = root.pendingKeeperWithdrawals?.[key] as PendingKeeperWithdrawal | undefined
    if (!previous) throw new Error("Keeper cancellation intent was not saved. Retry cancellation.")
    if (previous.grantScopes) { saved = previous; return root }
    saved = JSON.parse(JSON.stringify({ ...previous, grantScopes })) as PendingKeeperWithdrawal
    root.pendingKeeperWithdrawals = { ...root.pendingKeeperWithdrawals, [key]: saved }
    return root
  })
  return saved!
}

export async function clearPendingKeeperWithdrawalProofs(pairingId: string, operationId: string) {
  const key = withdrawalKey(pairingId, operationId)
  await updateCurrentPersonalRoot(root => {
    if (!root.pendingKeeperWithdrawals?.[key]) return root
    const remaining = { ...root.pendingKeeperWithdrawals }
    delete remaining[key]
    root.pendingKeeperWithdrawals = remaining
    return root
  })
}
