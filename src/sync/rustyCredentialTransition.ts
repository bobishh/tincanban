import type { useTincanban } from "../state"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { assertSigningContextCurrent } from "../domain/signingContext"
import { defaultStorage } from "../storage"
import { discoverBlindKeeper } from "./blindClient"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { getPrivateReplicaConfigurations } from "./privateReplicaRepository"
import { prepareReplicaCredentialFreeze, readReplicaCredentialFreeze, type ReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { drainFrozenReplica } from "./replicaCredentialDrain"
import { workspaceOwnerSigningContext } from "./workspaceOwnerSigning"
import { ensureRustyPersonPolicy, updateRustyManagementPolicy } from "./rustyManagementClient"
import { approveRustyScope } from "./rustyEnrollment"
import { ensureWorkspaceReplicaWriter } from "./workspaceReplicaWriter"
import { discoverWorkspaceReplicaWorkers } from "./workspaceReplicaWorkers"
import { assertAutomationStorageRotationSupported, prepareAutomationStorageRotation, readAutomationInstance,
  rotateAutomationStorageCredentials } from "../app/automationInstanceClient"
import { activateCredentialTransitionJournal, beginCredentialTransitionJournal, captureCredentialTransitionWorkers,
  completeCredentialTransitionJournal, readCompletedDeviceRevocation, confirmCredentialTransitionPerson, confirmCredentialTransitionScope,
  confirmCredentialTransitionWorker, readCredentialTransitionJournal, type CredentialTransitionJournal } from "./replicaCredentialTransitionJournal"
import { withLocalStateWriteLock } from "../localStateLock"
import type { PrivateReplicaConfig } from "./blindReplication"
import { completeScopeEnrollmentIntent } from "./rustyEnrollmentJournal"
import { traceDiagnosticOperation } from "./telemetry"

type TransitionApp = ReturnType<typeof useTincanban>
function pin(config: PrivateReplicaConfig) {
  return { origin: config.origin, scopeId: config.scopeId, keyEpoch: config.keyEpoch, servicePublicKey: config.servicePublicKey }
}

/** Explicit server-wide identity action. Workspace-only removal does not call this operation. */
export async function revokeRustyIdentityDevice(app: TransitionApp, origin: string, deviceId: string,
  ensureCurrent: () => void): Promise<void> {
  origin = blindOrigin(origin)
  const current = app.getCurrentProfile()
  if (!current) throw new Error("Current identity is unavailable")
  const profile = structuredClone(current)
  const owner = profile.identity.personId
  const identityBinding = (value: LocalProfile) => canonicalizeJson([value.identity.personId, value.identity.publicKey,
    value.device.deviceId, value.device.publicKey, value.certificate])
  const guardIdentity = () => {
    ensureCurrent()
    const active = app.getCurrentProfile()
    if (!active || identityBinding(active) !== identityBinding(profile)) throw new Error("Identity changed during Rusty access removal")
  }
  return traceDiagnosticOperation("rusty.device-removal", { "server.address": new URL(origin).host },
    () => withLocalStateWriteLock(`rusty-device-revocation:${owner}:${origin}`,
      () => revokeLockedIdentityDevice({ app, origin, profile, deviceId, guardIdentity })))
}

type TransitionSeed = { app: TransitionApp; origin: string; profile: LocalProfile; deviceId: string; guardIdentity: () => void }
type WorkerCohort = { scopeId: string; workers: Parameters<typeof captureCredentialTransitionWorkers>[3] }
type TransitionPhase = TransitionSeed & { pending: ReplicaCredentialFreeze;
  service: Awaited<ReturnType<typeof discoverBlindKeeper>>; guard: () => Promise<void>; preparedCohorts?: WorkerCohort[] }

async function revokeLockedIdentityDevice(seed: TransitionSeed) {
  const { app, profile, origin, deviceId, guardIdentity } = seed
  guardIdentity()
  let journal = await readCredentialTransitionJournal(profile, origin)
  if (journal && journal.freeze.revokedDeviceId !== deviceId) throw new Error("Resume the already pending device-access transition first")
  if (!journal) {
    const completedPin = await readCompletedDeviceRevocation(profile, origin, deviceId, guardIdentity)
    guardIdentity()
    if (completedPin) {
      const current = (await getPrivateReplicaConfigurations(profile.identity.personId)).filter(config => config.origin === origin)
      guardIdentity()
      if (current.some(config => config.servicePublicKey !== completedPin)) throw new Error("Rusty service pin changed after recorded device removal")
      return
    }
  }
  if (journal?.activated) return finishActivatedTransition(app, profile, origin, journal, guardIdentity)
  const phase = await prepareTransitionPhase(seed, journal)
  journal ??= await beginCredentialTransitionJournal(phase.pending, profile, guardIdentity)
  if (!journal.person) journal = await confirmTransitionPerson(phase, journal)
  journal = await confirmTransitionScopes(phase, journal)
  await rotateTransitionWorkers(phase, journal)
  await phase.guard()
  // Refresh signed current authority immediately before portable activation.
  const person = await ensureRustyPersonPolicy(phase.service, profile, true, { ensureCurrent: phase.guard })
  if (!person) throw new Error("Current person authority is unavailable")
  await confirmCredentialTransitionPerson(phase.pending, profile, person, guardIdentity)
  journal = await activateCredentialTransitionJournal(profile, origin, guardIdentity)
  await phase.guard()
  await finishActivatedTransition(app, profile, origin, journal, guardIdentity)
}

async function prepareTransitionPhase(seed: TransitionSeed, journal: CredentialTransitionJournal | undefined): Promise<TransitionPhase> {
  const { app, profile, origin, deviceId, guardIdentity } = seed
  const owner = profile.identity.personId
  const root = await defaultStorage.loadPersonalRoot()
  guardIdentity()
  if (deviceId === profile.device.deviceId || root?.identity.personId !== owner || !root.devices[deviceId])
    throw new Error("Choose another registered device of this identity")
  const service = await discoverBlindKeeper(origin)
  guardIdentity()
  assertTransitionService(service)
  const configurations = (await getPrivateReplicaConfigurations(owner)).filter(config => config.origin === origin)
  if (!configurations.length || configurations.some(config => config.servicePublicKey !== service.servicePublicKey || config.removalPending))
    throw new Error("Current pinned Rusty connections are required")
  const workspaceIds = [...new Set(configurations.flatMap(config => config.purpose === "identity" ? [] : [config.workspaceId]))]
  const contexts = await Promise.all(workspaceIds.map(async workspaceId => {
    const doc = await app.readWorkspaceDoc(workspaceId)
    guardIdentity()
    if (doc.id !== workspaceId || doc.ownerPersonId !== owner)
      throw new Error("Only the current Owner of every connected board can revoke this identity's Rusty access")
    return workspaceOwnerSigningContext(profile, workspaceId, "rusty-credential-transition", { origin, revokedDeviceId: deviceId })
  }))
  const guard = async () => {
    guardIdentity()
    for (const context of contexts) await assertSigningContextCurrent(context)
    guardIdentity()
  }
  await guard()
  if (!journal && !await readReplicaCredentialFreeze(owner, origin)) {
    await ensureRustyPersonPolicy(service, profile, true, { ensureCurrent: guard })
    await upgradeTransitionWriters(seed, configurations)
    await guard()
  }
  let preparedCohorts: WorkerCohort[] | undefined
  const pending = journal?.freeze ?? await prepareReplicaCredentialFreeze(profile, origin, service.servicePublicKey, deviceId, guardIdentity,
    async configurations => { preparedCohorts = await inspectTransitionWorkers(seed, configurations, guard) })
  if (pending.servicePublicKey !== service.servicePublicKey) throw new Error("Rusty service pin changed during access removal")
  return { ...seed, service, guard, pending, ...(preparedCohorts ? { preparedCohorts } : {}) }
}

function assertTransitionService(service: Awaited<ReturnType<typeof discoverBlindKeeper>>) {
  if (service.personManagement !== 1 || service.scopeManagement !== 1 || service.scopeEnrollmentRetry !== 1 ||
      service.writerPolicy?.maximumWriterVersion !== 2) throw new Error("Update Rusty before removing device access")
}

async function upgradeTransitionWriters(seed: TransitionSeed, configurations: PrivateReplicaConfig[]) {
  for (const config of configurations) {
    if (config.purpose === "identity" || config.minimumWriterVersion === 2) continue
    const { createBlindReplica } = await import("./blindReplicaStore")
    await createBlindReplica(config, seed.app, seed.guardIdentity, async () => {}).drainPending()
    const upgraded = await ensureWorkspaceReplicaWriter(seed.app, config, seed.guardIdentity)
    if (upgraded.minimumWriterVersion !== 2) throw new Error("Finish Rusty writer compatibility before revoking a device")
  }
}

async function inspectTransitionWorkers(seed: TransitionSeed, configurations: readonly PrivateReplicaConfig[], guard: () => Promise<void>) {
  return traceDiagnosticOperation("rusty.device-removal.preflight", { "server.address": new URL(seed.origin).host }, async () => {
    const cohorts: WorkerCohort[] = []
    for (const config of configurations) {
      if (config.purpose === "identity") continue
      const routes = await discoverWorkspaceReplicaWorkers(seed.app, config, guard)
      const workers: WorkerCohort["workers"] = []
      for (const route of routes) {
        await assertAutomationStorageRotationSupported(route.origin)
        await guard()
        const before = await readAutomationInstance(seed.profile, route, { ensureCurrent: guard })
        workers.push({ route, before: before.proof })
      }
      cohorts.push({ scopeId: config.scopeId, workers })
    }
    return cohorts
  })
}

async function captureTransitionWorkers(phase: TransitionPhase, initial: CredentialTransitionJournal) {
  const { pending, profile, guard, guardIdentity } = phase
  let journal = initial
  const cohorts = phase.preparedCohorts ?? await inspectTransitionWorkers(phase, pending.resources.map(resource => resource.previous), guard)
  for (const cohort of cohorts) {
    journal = await captureCredentialTransitionWorkers(pending, profile, cohort.scopeId, cohort.workers, guardIdentity)
  }
  return journal
}

async function confirmTransitionPerson(phase: TransitionPhase, initial: CredentialTransitionJournal) {
  const { pending, profile, guard, guardIdentity, service, deviceId, origin } = phase
  const journal = await captureTransitionWorkers(phase, initial)
  for (const worker of journal.workers) {
    if (worker.frozen) continue
    const selected = pending.resources.find(item => item.previous.scopeId === worker.scopeId)!
    const frozen = await prepareAutomationStorageRotation(profile, { ...worker.route, storage: pin(selected.previous), transitionId: pending.id },
      { ensureCurrent: guard })
    await confirmCredentialTransitionWorker(pending, profile, worker.route, worker.scopeId, "frozen", frozen.proof, guardIdentity)
  }
  for (const selected of pending.resources) await drainFrozenReplica(pending, selected.previous, guard)
  await guard()
  let person = await ensureRustyPersonPolicy(service, profile, true, { ensureCurrent: guard })
  if (!person) throw new Error("Explicit person authority is required")
  if (!person.payload.revokedDeviceIds.includes(deviceId)) {
    person = await updateRustyManagementPolicy({ origin, servicePublicKey: service.servicePublicKey, resourceKind: "person", resourceId: profile.identity.personId }, profile,
      { operations: person.payload.operations, revokedDeviceIds: [...new Set([...person.payload.revokedDeviceIds, deviceId])].sort() }, { ensureCurrent: guard })
  }
  return confirmCredentialTransitionPerson(pending, profile, person, guardIdentity)
}

async function confirmTransitionScopes(phase: TransitionPhase, initial: CredentialTransitionJournal) {
  const { pending, profile, guard, guardIdentity } = phase
  let journal = initial
  for (const selected of pending.resources) {
    const confirmed = journal.scopes.find(item => item.scopeId === selected.previous.scopeId)
    if (confirmed) {
      // Resume cleanup after a confirmed enrollment lost its final local reply.
      await completeScopeEnrollmentIntent(confirmed.request.binding, confirmed.request.body, guard)
      continue
    }
    await guard()
    await approveRustyScope(selected.next, profile, false, { requireExactRetry: true, expectedPolicyRevision: selected.previous.policyRevision,
      ...(selected.previous.purpose === "identity" ? {} : { minimumWriterVersion: 2 }), ensureCurrent: guard,
      confirmed: async receipt => {
        await guard()
        journal = await confirmCredentialTransitionScope(pending, profile, selected.previous.scopeId, receipt, guardIdentity)
      } })
  }
  return journal
}

async function rotateTransitionWorkers(phase: TransitionPhase, initial: CredentialTransitionJournal) {
  const { pending, profile, guard, guardIdentity } = phase
  let journal = initial
  for (const worker of journal.workers) {
    if (worker.rotated) continue
    const selected = pending.resources.find(item => item.previous.scopeId === worker.scopeId)!
    if (selected.next.purpose === "identity") throw new Error("Identity scope cannot have a Worker")
    const confirmation = journal.scopes.find(item => item.scopeId === worker.scopeId)!
    const credentials = { ...selected.next, policyRevision: confirmation.receipt.payload.revision, minimumWriterVersion: 2 as const }
    const rotated = await rotateAutomationStorageCredentials(profile, { ...worker.route, storage: pin(selected.previous),
      transitionId: pending.id, credentials, receipt: confirmation.receipt }, { ensureCurrent: guard })
    journal = await confirmCredentialTransitionWorker(pending, profile, worker.route, worker.scopeId, "rotated", rotated.proof, guardIdentity)
  }
}

async function finishActivatedTransition(app: TransitionApp, profile: LocalProfile, origin: string,
  journal: CredentialTransitionJournal, guard: () => void): Promise<void> {
  if (!journal.activated) throw new Error("Credential transition has not activated")
  const configurations = await getPrivateReplicaConfigurations(profile.identity.personId)
  for (const captured of journal.activated) {
    guard()
    const config = configurations.find(value => value.origin === origin && value.scopeId === captured.scopeId)
    if (!config) throw new Error("Activated Rusty connection is unavailable")
    if (config.purpose === "identity") {
      const { createIdentityReplica } = await import("./identityReplicaStore")
      if (!await createIdentityReplica(config, profile, guard).push()) throw new Error("Private profile is still changing; resume fresh-epoch confirmation")
    } else {
      const { createBlindReplica } = await import("./blindReplicaStore")
      await createBlindReplica(config, app, guard, async () => {}).flushCurrentSnapshot()
    }
    guard()
  }
  await completeCredentialTransitionJournal(profile, origin, guard)
}
