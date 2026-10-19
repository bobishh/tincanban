import { canonicalizeJson, sha256Base64Url, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { verifyAutomationInstanceIdentity, type AutomationInstanceIdentityProof } from "../domain/automationInstanceIdentity"
import type { AutomationInstanceDescription } from "../domain/automationInstanceData"
import type { PrivateReplicaConfig } from "./blindReplication"
import { parseReplicaCredentialFreeze, replicaCredentialFreezeKey, type ReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { parseReplicaWriterWorkers, type ReplicaWriterWorker } from "./replicaWriterWorkersState"
import { readScopeEnrollmentIntent, type ScopeEnrollmentBinding, type ScopeEnrollmentIntent } from "./rustyEnrollmentJournal"
import { verifySavedScopeEnrollmentConfirmation } from "./rustyEnrollment"
import { verifyRustyManagementCapability, type RustyManagementCapability } from "./rustyManagementCapability"
import type { RustyScopePolicyReceipt } from "../product-replica"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { getPrivateReplicaConfigurations, getPrivateReplicaProgress, planReplicaCredentialActivation, privateReplicaBinding,
  privateReplicaStateStorageKey } from "./privateReplicaRepository"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { RustyManagementRepository } from "./rustyManagementRepository"

type CredentialTransitionWorker = { scopeId: string; route: ReplicaWriterWorker;
  before: AutomationInstanceIdentityProof; frozen?: AutomationInstanceIdentityProof; rotated?: AutomationInstanceIdentityProof }
export type CredentialTransitionJournal = {
  version: 1
  freeze: ReplicaCredentialFreeze
  cohorts: string[]
  workers: CredentialTransitionWorker[]
  scopes: Array<{ scopeId: string; request: ScopeEnrollmentIntent; receipt: RustyScopePolicyReceipt }>
  person?: SignedEnvelope<RustyManagementCapability>
  activated?: PrivateReplicaConfig[]
}
const profileKey = "tincanban.local_profile.v1"
const encoder = new TextEncoder()
const same = (left: unknown, right: unknown) => canonicalizeJson(left) === canonicalizeJson(right)
const workerKey = (worker: Pick<CredentialTransitionWorker, "scopeId" | "route">) => canonicalizeJson([worker.scopeId, worker.route])

async function credentialTransitionJournalKey(personId: string, origin: string): Promise<string> {
  return (await replicaCredentialFreezeKey(personId, origin)).replace("tincanban.replica-credential-freeze.v1.", "tincanban.replica-credential-transition.v1.")
}

function resource(freeze: ReplicaCredentialFreeze, scopeId: string) {
  const found = freeze.resources.find(item => item.previous.scopeId === scopeId)
  if (!found) throw new Error("Credential transition scope is not captured")
  return found
}

function storagePin(config: Pick<PrivateReplicaConfig, "origin" | "scopeId" | "keyEpoch" | "servicePublicKey">) {
  return { origin: config.origin, scopeId: config.scopeId, keyEpoch: config.keyEpoch, servicePublicKey: config.servicePublicKey }
}

async function workerDescription(worker: CredentialTransitionWorker, proof: AutomationInstanceIdentityProof,
  historical: boolean): Promise<AutomationInstanceDescription> {
  const route = worker.route
  const issuedAt = proof?.signed?.payload?.issuedAt
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("Invalid retained Worker confirmation time")
  const identity = await verifyAutomationInstanceIdentity(proof, { origin: route.origin, workspaceId: route.workspaceId,
    definitionId: route.definitionId, integrationId: route.integrationId, executorPersonId: route.executorPersonId,
    requestNonce: proof.signed.payload.requestNonce }, historical ? issuedAt : Date.now())
  return identity.description
}

function assertStorageDescription(description: AutomationInstanceDescription, config: PrivateReplicaConfig, revision?: number) {
  if (!description.storage || !same(storagePin(description.storage), storagePin(config)) ||
    revision !== undefined && (description.storage.policyRevision !== revision || description.storage.minimumWriterVersion !== 2)) {
    throw new Error("Worker storage confirmation differs from this credential transition")
  }
}

function assertUnchangedApproval(before: AutomationInstanceDescription, after: AutomationInstanceDescription) {
  const approval = (value: AutomationInstanceDescription) => [value.workspaceId, value.boardId, value.definitionId,
    value.executorPersonId, value.grantId, value.expiresAt, value.adoptionRequired]
  if (!same(approval(before), approval(after))) throw new Error("Storage maintenance changed the Worker approval")
}

async function validateScopeConfirmations(journal: CredentialTransitionJournal, profile: LocalProfile): Promise<void> {
  const freeze = journal.freeze
  for (const scope of journal.cohorts) {
    if (resource(freeze, scope).previous.purpose === "identity") throw new Error("Identity scope cannot contain automation Workers")
  }
  const seenScopes = new Set<string>()
  for (const confirmation of journal.scopes) {
    if (!confirmation || Object.keys(confirmation).length !== 3 || seenScopes.has(confirmation.scopeId)) throw new Error("Invalid duplicate scope confirmation")
    const selected = resource(freeze, confirmation.scopeId)
    const receipt = await verifySavedScopeEnrollmentConfirmation(selected.next, profile, confirmation.request, confirmation.receipt)
    if (receipt.payload.revision <= selected.previous.policyRevision || !same(receipt, confirmation.receipt)) throw new Error("Credential transition policy did not advance")
    seenScopes.add(confirmation.scopeId)
  }
}

async function validatePersonConfirmation(journal: CredentialTransitionJournal): Promise<void> {
  const freeze = journal.freeze
  if (journal.person) {
    const cap = await verifyRustyManagementCapability(journal.person, freeze, { personId: freeze.personId, deviceId: freeze.signerDeviceId,
      resourceKind: "person", resourceId: freeze.personId, operation: "management.update", minimumRevision: 1 })
    if (!cap.revokedDeviceIds.includes(freeze.revokedDeviceId)) throw new Error("Person confirmation does not revoke the selected device")
  }
}

function assertWorkerFields(worker: CredentialTransitionWorker): void {
  if (!worker || Object.keys(worker).some(key => !["scopeId", "route", "before", "frozen", "rotated"].includes(key))) throw new Error("Invalid retained Worker fields")
}

async function validateWorkerConfirmation(journal: CredentialTransitionJournal, worker: CredentialTransitionWorker,
  workers: Set<string>): Promise<void> {
  const freeze = journal.freeze
    assertWorkerFields(worker)
    const selected = resource(freeze, worker.scopeId)
    if (selected.previous.purpose === "identity" || !journal.cohorts.includes(worker.scopeId)) throw new Error("Worker cohort scope was not captured")
    const [route] = parseReplicaWriterWorkers([worker.route], selected.previous.workspaceId)
    if (!same(route, worker.route) || workers.has(workerKey(worker))) throw new Error("Invalid duplicate Worker route")
    workers.add(workerKey(worker))
    const before = await workerDescription(worker, worker.before, true)
    assertStorageDescription(before, selected.previous)
    if (before.storageTransition && before.storageTransition.transitionId !== freeze.id) throw new Error("Another Worker storage transition is pending")
    if (worker.frozen) {
      const frozen = await workerDescription(worker, worker.frozen, true)
      assertStorageDescription(frozen, selected.previous)
      assertUnchangedApproval(before, frozen)
      if (!same(frozen.storageTransition, { transitionId: freeze.id, state: "frozen" })) throw new Error("Worker freeze confirmation is missing")
    }
    if (worker.rotated) {
      const confirmation = journal.scopes.find(item => item.scopeId === worker.scopeId)
      if (!worker.frozen || !confirmation || !journal.person) throw new Error("Worker rotation preceded confirmed revocation or scope policy")
      const rotated = await workerDescription(worker, worker.rotated, true)
      assertStorageDescription(rotated, selected.next, confirmation.receipt.payload.revision)
      assertUnchangedApproval(before, rotated)
      if (rotated.storageTransition) throw new Error("Worker rotation remains frozen")
    }
}

function validateActivatedCredentials(journal: CredentialTransitionJournal): void {
  const freeze = journal.freeze
  if (journal.activated) {
    assertReadyToActivate(journal)
    if (!Array.isArray(journal.activated) || journal.activated.length !== freeze.resources.length) throw new Error("Incomplete activated credential set")
    const seen = new Set<string>()
    for (const config of journal.activated) {
      const selected = resource(freeze, config.scopeId)
      const confirmation = journal.scopes.find(item => item.scopeId === config.scopeId)!
      const expected = { ...selected.next, policyRevision: confirmation.receipt.payload.revision, preferenceRevision: config.preferenceRevision,
        ...(selected.next.purpose === "identity" ? {} : { minimumWriterVersion: 2 as const }) }
      if (!config.preferenceRevision || seen.has(config.scopeId) || privateReplicaBinding(freeze.personId, config) !== privateReplicaBinding(freeze.personId, expected)) {
        throw new Error("Activated credentials differ from their confirmed transition")
      }
      seen.add(config.scopeId)
    }
  }
}

function captureTransitionJournal(value: unknown): CredentialTransitionJournal {
  const journal = structuredClone(value) as CredentialTransitionJournal
  if (!journal || journal.version !== 1 || !journal.freeze || Object.keys(journal).some(key =>
    !["version", "freeze", "cohorts", "workers", "scopes", "person", "activated"].includes(key))) throw new Error("Invalid credential transition journal")
  if (!Array.isArray(journal.cohorts) || journal.cohorts.length > 128 || new Set(journal.cohorts).size !== journal.cohorts.length ||
    !Array.isArray(journal.workers) || journal.workers.length > 512 || !Array.isArray(journal.scopes) || journal.scopes.length > 128) {
    throw new Error("Credential transition journal exceeds its bounded cohort")
  }
  return journal
}

async function validateJournal(value: unknown, profile: LocalProfile): Promise<CredentialTransitionJournal> {
  const journal = captureTransitionJournal(value)
  const freeze = parseReplicaCredentialFreeze(JSON.stringify(journal.freeze), profile.identity.personId, journal.freeze.origin)
  if (freeze.signerDeviceId !== profile.device.deviceId || !same(freeze, journal.freeze)) throw new Error("Credential journal signer changed")
  await validateScopeConfirmations(journal, profile)
  await validatePersonConfirmation(journal)
  const workers = new Set<string>()
  for (const worker of journal.workers) await validateWorkerConfirmation(journal, worker, workers)
  validateActivatedCredentials(journal)
  if (encoder.encode(JSON.stringify(journal)).length > 32 * 1024 * 1024) throw new Error("Credential transition journal exceeds storage bound")
  return journal
}

function assertReadyToActivate(journal: CredentialTransitionJournal): void {
  if (!journal.person || journal.scopes.length !== journal.freeze.resources.length ||
    journal.freeze.resources.some(item => item.previous.purpose !== "identity" && !journal.cohorts.includes(item.previous.scopeId)) ||
    journal.workers.some(worker => !worker.frozen || !worker.rotated)) throw new Error("Credential transition confirmations are incomplete")
}

async function currentProfileRaw(profile: LocalProfile): Promise<string> {
  const raw = await readLocal(profileKey)
  const stored = raw === null ? undefined : JSON.parse(raw) as LocalProfile
  if (!stored || stored.identity?.personId !== profile.identity.personId || stored.identity.publicKey !== profile.identity.publicKey ||
    stored.device?.deviceId !== profile.device.deviceId || stored.device.publicKey !== profile.device.publicKey ||
    !same(stored.certificate, profile.certificate)) throw new Error("Credential transition signing profile changed")
  return raw!
}

async function changeJournal(pending: ReplicaCredentialFreeze, profile: LocalProfile,
  change: (current: CredentialTransitionJournal) => CredentialTransitionJournal | Promise<CredentialTransitionJournal>, guard: () => void): Promise<CredentialTransitionJournal> {
  pending = structuredClone(pending)
  profile = structuredClone(profile)
  const key = await credentialTransitionJournalKey(pending.personId, pending.origin)
  const freezeKey = await replicaCredentialFreezeKey(pending.personId, pending.origin)
  return withLocalStateWriteLock(key, async () => {
    guard()
    const [raw, frozen, profileRaw] = await Promise.all([readLocal(key), readLocal(freezeKey), currentProfileRaw(profile)])
    if (raw !== null && encoder.encode(raw).length > 32 * 1024 * 1024) throw new Error("Credential transition journal exceeds storage bound")
    if (frozen === null || !same(parseReplicaCredentialFreeze(frozen, pending.personId, pending.origin), pending)) throw new Error("Credential freeze changed before confirmation persistence")
    const current = raw === null ? { version: 1 as const, freeze: pending, cohorts: [], workers: [], scopes: [] }
      : await validateJournal(JSON.parse(raw), profile)
    if (!same(current.freeze, pending)) throw new Error("Another credential transition journal is pending")
    const next = await validateJournal(await change(structuredClone(current)), profile)
    guard()
    if (!await compareAndSwapLocal({ conditions: [{ key, value: raw }, { key: freezeKey, value: frozen }, { key: profileKey, value: profileRaw }],
      writes: [{ key, value: JSON.stringify(next) }] }, guard)) throw new Error("Credential confirmation changed before persistence; retry required")
    return next
  })
}

export function beginCredentialTransitionJournal(pending: ReplicaCredentialFreeze, profile: LocalProfile, guard: () => void): Promise<CredentialTransitionJournal> {
  return changeJournal(pending, profile, current => current, guard)
}

export async function readCredentialTransitionJournal(profile: LocalProfile, origin: string): Promise<CredentialTransitionJournal | undefined> {
  profile = structuredClone(profile)
  origin = blindOrigin(origin)
  const raw = await readLocal(await credentialTransitionJournalKey(profile.identity.personId, origin))
  if (raw === null) return undefined
  await currentProfileRaw(profile)
  if (encoder.encode(raw).length > 32 * 1024 * 1024) throw new Error("Credential transition journal exceeds storage bound")
  const parsed = await validateJournal(JSON.parse(raw), profile)
  if (parsed.freeze.origin !== origin) throw new Error("Credential transition journal origin mismatch")
  return parsed
}

/** Capture each authenticated route before any person or scope mutation; repeated discovery can only add routes. */
export function captureCredentialTransitionWorkers(pending: ReplicaCredentialFreeze, profile: LocalProfile, scopeId: string,
  incoming: Array<{ route: ReplicaWriterWorker; before: AutomationInstanceIdentityProof }>, guard: () => void): Promise<CredentialTransitionJournal> {
  incoming = structuredClone(incoming)
  return changeJournal(pending, profile, async current => {
    if (current.person || current.scopes.length) throw new Error("Worker discovery must finish before policy mutation")
    const workers = new Map(current.workers.map(worker => [workerKey(worker), worker]))
    for (const item of incoming) {
      const worker = { scopeId, ...item }
      await workerDescription(worker, worker.before, false)
      if (!workers.has(workerKey(worker))) workers.set(workerKey(worker), worker)
    }
    return { ...current, cohorts: [...new Set([...current.cohorts, scopeId])].sort(), workers: [...workers.values()] }
  }, guard)
}

export function confirmCredentialTransitionPerson(pending: ReplicaCredentialFreeze, profile: LocalProfile,
  value: SignedEnvelope<RustyManagementCapability>, guard: () => void): Promise<CredentialTransitionJournal> {
  value = structuredClone(value)
  return changeJournal(pending, profile, current => {
    if (pending.resources.some(item => item.previous.purpose !== "identity" && !current.cohorts.includes(item.previous.scopeId)) ||
      current.workers.some(worker => !worker.frozen)) throw new Error("Every captured Worker must freeze before person revocation")
    if (current.person && (value.payload.revision < current.person.payload.revision ||
      current.person.payload.revokedDeviceIds.some(id => !value.payload.revokedDeviceIds.includes(id)))) throw new Error("Person revocation confirmation rollback")
    return { ...current, person: value }
  }, guard)
}

export function confirmCredentialTransitionScope(pending: ReplicaCredentialFreeze, profile: LocalProfile,
  scopeId: string, value: RustyScopePolicyReceipt, guard: () => void): Promise<CredentialTransitionJournal> {
  value = structuredClone(value)
  return changeJournal(pending, profile, async current => {
    if (!current.person) throw new Error("Person revocation must be confirmed before rotating a scope")
    const previous = current.scopes.find(item => item.scopeId === scopeId)
    if (previous) {
      if (!same(previous.receipt, value)) throw new Error("Scope rotation already has another retained confirmation")
      return current
    }
    const next = resource(pending, scopeId).next
    const binding: ScopeEnrollmentBinding = { origin: pending.origin, scopeId, servicePublicKey: pending.servicePublicKey,
      personId: pending.personId, deviceId: profile.device.deviceId, revoked: false,
      readTokenHash: await sha256Base64Url(encoder.encode(next.readToken)), writeTokenHash: await sha256Base64Url(encoder.encode(next.writeToken)),
      ...(next.purpose === "identity" ? {} : { minimumWriterVersion: 2 as const }) }
    const request = await readScopeEnrollmentIntent(binding)
    if (!request) throw new Error("Original scope enrollment request must remain durable until its confirmation is saved")
    await verifySavedScopeEnrollmentConfirmation(next, profile, request, value)
    return { ...current, scopes: [...current.scopes, { scopeId, request, receipt: value }] }
  }, guard)
}

export function confirmCredentialTransitionWorker(pending: ReplicaCredentialFreeze, profile: LocalProfile,
  route: ReplicaWriterWorker, scopeId: string, phase: "frozen" | "rotated", value: AutomationInstanceIdentityProof,
  guard: () => void): Promise<CredentialTransitionJournal> {
  route = structuredClone(route); value = structuredClone(value)
  return changeJournal(pending, profile, async current => {
    const key = workerKey({ route, scopeId })
    const index = current.workers.findIndex(worker => workerKey(worker) === key)
    const worker = current.workers[index]
    if (!worker) throw new Error("Worker was not captured before credential transition")
    await workerDescription(worker, value, false)
    const workers = [...current.workers]
    workers[index] = { ...worker, [phase]: value }
    return { ...current, workers }
  }, guard)
}

/** Publish confirmed preferences, retained local cursors, journal phase and freeze removal in one transaction. */
export async function activateCredentialTransitionJournal(profile: LocalProfile, origin: string,
  guard: () => void): Promise<CredentialTransitionJournal> {
  profile = structuredClone(profile)
  origin = blindOrigin(origin)
  const key = await credentialTransitionJournalKey(profile.identity.personId, origin)
  return withLocalStateWriteLock(key, async () => {
    guard()
    const [raw, profileRaw] = await Promise.all([readLocal(key), currentProfileRaw(profile)])
    if (raw === null || encoder.encode(raw).length > 32 * 1024 * 1024) throw new Error("Credential transition journal is unavailable")
    const journal = await validateJournal(JSON.parse(raw), profile)
    if (journal.freeze.origin !== origin) throw new Error("Credential transition journal origin mismatch")
    if (journal.activated) return journal
    assertReadyToActivate(journal)
    const revisions = Object.fromEntries(journal.scopes.map(item => [item.scopeId, item.receipt.payload.revision]))
    const { plan, configs } = await planReplicaCredentialActivation(profile.identity.personId, journal.freeze, revisions)
    const personBinding = { origin, servicePublicKey: journal.freeze.servicePublicKey,
      resourceKind: "person" as const, resourceId: profile.identity.personId }
    const management = new RustyManagementRepository(profile.identity.personId)
    const authorityPlan = await management.planImport([{ binding: personBinding, capability: journal.person! }])
    const knownPerson = await management.read(personBinding)
    if (knownPerson?.pending) throw new Error("Person policy is pending during credential activation")
    if (knownPerson?.capability && knownPerson.capability.payload.revision >= journal.person!.payload.revision) {
      const cap = await verifyRustyManagementCapability(knownPerson.capability, personBinding, { personId: profile.identity.personId,
        deviceId: profile.device.deviceId, resourceKind: "person", resourceId: profile.identity.personId,
        operation: "management.update", minimumRevision: journal.person!.payload.revision })
      if (!cap.revokedDeviceIds.includes(journal.freeze.revokedDeviceId)) throw new Error("Current person policy does not retain target revocation")
    }
    const freezeKey = await replicaCredentialFreezeKey(profile.identity.personId, origin)
    const frozen = await readLocal(freezeKey)
    if (frozen === null || !same(parseReplicaCredentialFreeze(frozen, profile.identity.personId, origin), journal.freeze)) throw new Error("Credential freeze changed before activation")
    const activated = await validateJournal({ ...journal, activated: configs }, profile)
    guard()
    if (!await compareAndSwapLocal({ conditions: [...plan.conditions, ...authorityPlan.conditions, { key, value: raw }, { key: freezeKey, value: frozen }, { key: profileKey, value: profileRaw }],
      writes: [...plan.writes, ...authorityPlan.writes, { key, value: JSON.stringify(activated) }, { key: freezeKey, value: null }] }, guard)) {
      throw new Error("Credential activation changed before commit; original transition retained")
    }
    identityDevicePreferencesChanged(profile.identity.personId)
    return activated
  })
}

/** Credentials installed is distinct from a fresh-epoch storage receipt. Keep recovery state until every scope has one. */
export async function completeCredentialTransitionJournal(profile: LocalProfile, origin: string,
  guard: () => void): Promise<void> {
  profile = structuredClone(profile); origin = blindOrigin(origin)
  const owner = profile.identity.personId
  const key = await credentialTransitionJournalKey(owner, origin)
  await withLocalStateWriteLock(key, async () => {
    const [raw, profileRaw, stateRaw] = await Promise.all([readLocal(key), currentProfileRaw(profile), readLocal(privateReplicaStateStorageKey(owner))])
    if (raw === null) return
    if (encoder.encode(raw).length > 32 * 1024 * 1024) throw new Error("Credential transition journal exceeds storage bound")
    const journal = await validateJournal(JSON.parse(raw), profile)
    if (!journal.activated) throw new Error("Credential transition has not activated")
    const configurations = await getPrivateReplicaConfigurations(owner)
    for (const config of journal.activated) {
      guard()
      const current = configurations.find(item => item.origin === origin && item.scopeId === config.scopeId)
      if (!current || privateReplicaBinding(owner, current) !== privateReplicaBinding(owner, config)) throw new Error("Activated credential revision changed before fresh-epoch confirmation")
      const progress = await getPrivateReplicaProgress(owner, current)
      if (progress.pending || !progress.lastUploaded) throw new Error("Fresh-epoch Rusty snapshot has not been acknowledged")
    }
    const freezeKey = await replicaCredentialFreezeKey(owner, origin)
    const archiveKey = `${key}.completed.${journal.freeze.id}`
    const archived = await readLocal(archiveKey)
    if (archived !== null && archived !== raw) throw new Error("Completed transition audit already contains different evidence")
    guard()
    if (!await compareAndSwapLocal({ conditions: [{ key, value: raw }, { key: profileKey, value: profileRaw },
      { key: privateReplicaStateStorageKey(owner), value: stateRaw }, { key: freezeKey, value: null }, { key: archiveKey, value: archived }],
      writes: [{ key, value: null }, { key: archiveKey, value: raw }] }, guard)) throw new Error("Fresh-epoch acknowledgment changed before completion; retry required")
  })
}
