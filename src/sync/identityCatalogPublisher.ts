import { publishRustyIdentityCatalogAccess, type IdentityCatalogAccessPublicationJournal,
  type IdentityCatalogAccessPublicationJournalEntry, type RustyIdentityCatalogAccessPublishReceipt } from "@meta-uber/mesh-replication"
import { verifyRetainedDeviceAuthorizationApproval, type DeviceAuthorizationApproval,
  type DeviceAuthorizationRequest } from "@meta-uber/mesh-identity"
import { canonicalizeJson, isCurrentIdentityProfile, sha256Base64Url, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { defaultStorage } from "../storage"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { identityProfileRustyServicePins } from "@meta-uber/mesh-identity"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { readIdentityRustyServicePin } from "./identityRustyServiceCatalog"
import { getIdentityReplicaConfigurations } from "./privateReplicaRepository"
import { captureIdentityCatalogAccess } from "./identityCatalogAccess"
import type { IdentityReplicaConfig } from "./blindReplication"

type RetainedAuthorization = { version: 1; personId: string; deviceId: string;
  request: DeviceAuthorizationRequest; approval: DeviceAuthorizationApproval }
const retainedKey = (personId: string, deviceId: string) =>
  `tincanban.identity-catalog-publisher-authorization.v1.${personId}.${deviceId}`
const journalPrefix = "tincanban.identity-catalog-publication-journal.v1."
const inFlight = new Map<string, Promise<RustyIdentityCatalogAccessPublishReceipt[]>>()

/** Persist freshly verified source approval after adoption, for post-reload publication. */
export async function retainIdentityCatalogPublisherAuthorization(
  profile: LocalProfile, approvalValue: DeviceAuthorizationApproval,
): Promise<void> {
  if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed before retaining catalog approval")
  const request = requirePublisherRequest(profile, approvalValue)
  const verified = await verifyRetainedDeviceAuthorizationApproval(approvalValue, request,
    { expectedExistingProfile: profile })
  assertVerifiedPublisherApproval(profile, verified)
  if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed while retaining catalog approval")
  const key = retainedKey(profile.identity.personId, profile.device.deviceId)
  const next: RetainedAuthorization = { version: 1, personId: profile.identity.personId,
    deviceId: profile.device.deviceId, request: structuredClone(request), approval: structuredClone(approvalValue) }
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await readLocal(key)
    if (previous === JSON.stringify(next)) return
    if (await compareAndSwapLocal({ conditions: [{ key, value: previous }], writes: [{ key, value: JSON.stringify(next) }] })) return
  }
  throw new Error("Identity catalog publisher approval changed repeatedly; retry required")
}

function requirePublisherRequest(profile: LocalProfile, approval: DeviceAuthorizationApproval): DeviceAuthorizationRequest {
  const request = approval.proof.payload.request as DeviceAuthorizationRequest | undefined
  if (!request || request.payload.version !== 3 || request.payload.includeIdentityCatalogAccess !== true ||
      approval.proof.payload.version !== 5 || (request.payload.personId !== null && request.payload.personId !== profile.identity.personId) ||
      request.payload.deviceId !== profile.device.deviceId || request.payload.devicePublicKey !== profile.device.publicKey) {
    throw new Error("Fresh Identity catalog publisher approval is required")
  }
  return request
}

function assertVerifiedPublisherApproval(profile: LocalProfile,
  approval: Awaited<ReturnType<typeof verifyRetainedDeviceAuthorizationApproval>>) {
  if (approval.identity.personId !== profile.identity.personId || approval.certificate.payload.deviceId !== profile.device.deviceId ||
      approval.certificate.payload.devicePublicKey !== profile.device.publicKey || approval.proof.payload.version !== 5) {
    throw new Error("Identity catalog publisher approval does not match this device")
  }
}

/** Call after a successful Identity replica push/sync; SDK owns publication retry and durable state. */
export function publishCurrentIdentityCatalogAccess(profile: LocalProfile,
  pushedConfig: IdentityReplicaConfig): Promise<RustyIdentityCatalogAccessPublishReceipt[]> {
  const key = `${profile.identity.personId}:${profile.device.deviceId}:${pushedConfig.origin}:${pushedConfig.scopeId}`
  const pending = inFlight.get(key)
  if (pending) return pending
  const operation = publishCurrent(profile, pushedConfig).finally(() => {
    if (inFlight.get(key) === operation) inFlight.delete(key)
  })
  inFlight.set(key, operation)
  return operation
}

async function publishCurrent(profile: LocalProfile, pushedConfig: IdentityReplicaConfig): Promise<RustyIdentityCatalogAccessPublishReceipt[]> {
  const ensureCurrent = () => {
    if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed before catalog publication")
  }
  const publication = await preparePublication(profile, pushedConfig, ensureCurrent)
  if (!publication) return []
  const { approval, config, pin } = publication
  const access = await captureIdentityCatalogAccess(profile, config)
  const catalogId = await stableCatalogId(profile, pin, config.scopeId)
  ensureCurrent()
  const latestPin = await readIdentityRustyServicePin(profile.identity.personId, config.origin, profile)
  if (!latestPin || latestPin.serviceId !== pin.serviceId || latestPin.servicePublicKey !== pin.servicePublicKey) {
    throw new Error("Identity catalog service pin changed before publication")
  }
  const latestAuthorityView = await requireIdentityAuthorityView(profile.identity.personId)
  ensureCurrent()
  return publishRustyIdentityCatalogAccess({ origin: pin.origin, servicePublicKey: pin.servicePublicKey,
    publisher: profile, currentAuthorityView: latestAuthorityView, retainedAuthorization: approval,
    applicationOrigin: appOrigin(), catalogId, access, journal: publicationJournal, ensureCurrent })
}

async function preparePublication(profile: LocalProfile, pushedConfig: IdentityReplicaConfig, ensureCurrent: () => void) {
  ensureCurrent()
  assertPushedIdentityConfig(profile, pushedConfig)
  const approval = await readRetainedAuthorization(profile)
  if (!approval) return null
  const root = await defaultStorage.loadPersonalRoot()
  if (!root || root.identity.personId !== profile.identity.personId || root.identity.publicKey !== profile.identity.publicKey) {
    throw new Error("Current Identity catalog is unavailable")
  }
  const profileState = await rootIdentityProfileState(root)
  const signedPins = identityProfileRustyServicePins(profileState)
  const config = (await getIdentityReplicaConfigurations(profile.identity.personId))
    .find(value => value.origin === pushedConfig.origin && value.scopeId === pushedConfig.scopeId)
  if (!config || config.purpose !== "identity" || config.removalPending || !sameReplicaCredentials(config, pushedConfig)) {
    throw new Error("Pushed Identity replica no longer matches confirmed local catalog")
  }
  const pin = await readIdentityRustyServicePin(profile.identity.personId, config.origin, profile)
  const pinIsCurrent = pin && (signedPins.some(candidate => candidate.origin === pin.origin &&
    candidate.serviceId === pin.serviceId && candidate.servicePublicKey === pin.servicePublicKey) ||
    (root.profileState === undefined && signedPins.length === 0))
  if (!pinIsCurrent || pin.origin !== config.origin || pin.servicePublicKey !== config.servicePublicKey) {
    throw new Error("Identity catalog service pin is not in current signed profile")
  }
  return { approval, config, pin }
}

function assertPushedIdentityConfig(profile: LocalProfile, pushedConfig: IdentityReplicaConfig) {
  if (pushedConfig.purpose !== "identity" || pushedConfig.personId !== profile.identity.personId || pushedConfig.removalPending) {
    throw new Error("Only a confirmed Identity replica push can publish catalog access")
  }
}

function sameReplicaCredentials(left: IdentityReplicaConfig, right: IdentityReplicaConfig): boolean {
  const portable = (config: IdentityReplicaConfig) => {
    const { cursor, lastUploaded, preferenceRevision, ...credentials } = config
    void cursor; void lastUploaded; void preferenceRevision
    return credentials
  }
  return canonicalizeJson(portable(left)) === canonicalizeJson(portable(right))
}

async function readRetainedAuthorization(profile: LocalProfile): Promise<DeviceAuthorizationApproval | null> {
  const key = retainedKey(profile.identity.personId, profile.device.deviceId)
  const raw = await readLocal(key)
  if (!raw) return null
  let record: RetainedAuthorization
  try { record = JSON.parse(raw) as RetainedAuthorization }
  catch { throw new Error("Saved Identity catalog publisher approval is malformed") }
  if (!record || record.version !== 1 || record.personId !== profile.identity.personId ||
      record.deviceId !== profile.device.deviceId || !record.request || !record.approval) {
    throw new Error("Saved Identity catalog publisher approval does not match this device")
  }
  const verified = await verifyRetainedDeviceAuthorizationApproval(record.approval, record.request,
    { expectedExistingProfile: profile })
  if (verified.proof.payload.version !== 5 || verified.identity.personId !== profile.identity.personId ||
      verified.certificate.payload.deviceId !== profile.device.deviceId ||
      verified.certificate.payload.devicePublicKey !== profile.device.publicKey) {
    throw new Error("Saved Identity catalog publisher approval is no longer valid")
  }
  return record.approval
}

async function stableCatalogId(profile: LocalProfile, pin: { origin: string; serviceId: string; servicePublicKey: string }, scopeId: string) {
  const digest = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson([
    profile.identity.personId, profile.device.deviceId, pin.origin, pin.serviceId, scopeId,
  ])))
  return `tincanban-catalog-${digest}`
}

function appOrigin(): string {
  if (typeof window === "undefined" || !window.location.origin) throw new Error("Application origin is unavailable")
  return window.location.origin
}

const publicationJournal: IdentityCatalogAccessPublicationJournal = {
  async read(key) {
    const raw = await readLocal(journalStorageKey(key))
    if (raw === null) return null
    let value: unknown
    try { value = JSON.parse(raw) as unknown } catch { throw new Error("Identity catalog publication journal is malformed") }
    if (!isJournalEntry(value)) throw new Error("Identity catalog publication journal is invalid")
    return value
  },
  async compareAndSet(key, expectedVersion, next) {
    const storageKey = journalStorageKey(key)
    const previous = await readLocal(storageKey)
    const current = previous === null ? null : JSON.parse(previous) as IdentityCatalogAccessPublicationJournalEntry
    if ((current?.version ?? null) !== expectedVersion) return false
    return compareAndSwapLocal({ conditions: [{ key: storageKey, value: previous }],
      writes: [{ key: storageKey, value: JSON.stringify(next) }] })
  },
}

function journalStorageKey(key: string): string { return `${journalPrefix}${key}` }

function isJournalEntry(value: unknown): value is IdentityCatalogAccessPublicationJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Partial<IdentityCatalogAccessPublicationJournalEntry>
  return isPositiveInteger(entry.version) && isPositiveInteger(entry.sourceRevision) &&
    typeof entry.contentHash === "string" && isPublishedEntry(entry)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0
}

function isPublishedEntry(entry: Partial<IdentityCatalogAccessPublicationJournalEntry>): boolean {
  if (entry.state === "pending") return !!entry.envelope
  return entry.state === "published" && !!entry.receipt
}

/** Test cleanup only; does not erase durable approval or publication journal. */
export function clearIdentityCatalogPublicationTestState(): void { inFlight.clear() }
