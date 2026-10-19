import { privateReplicaConflictSourceDifference } from "./privateReplicaConflictSource"
import type { useTincanban } from '../state'
import { canonicalizeJson, sha256Base64Url, type LocalProfile } from '../domain/identity'
import { assertSigningContextCurrent } from '../domain/signingContext'
import { verifyAutomationInstanceIdentity, type AutomationInstanceIdentityProof } from '../domain/automationInstanceIdentity'
import { compareAndSwapLocal, readLocal, type LocalStatePlan } from '../localDb'
import { withLocalStateWriteLock } from '../localStateLock'
import { parseReplicaState, type ReplicaState } from '@meta-uber/mesh-replication/replica-engine'
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { blindObjectId, blindProducerHeaders, discoverBlindKeeper, verifyBlindReceipt, type BlindReceipt } from './blindClient'
import { fetchBlind, readBlindJson } from './rustyHttp'
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindReplicaConfig, PrivateReplicaConfig } from './blindReplication'
import { assertRetainsReplicaContentKeys, contentKeysForEpoch } from "./replicaContentKeys"
import { createWorkspaceAttachmentIndex } from "./attachmentIndexScope"
import { privateReplicaBinding } from './privateReplicaBinding'
import { buildReplicaCredentialConflictRecovery } from './replicaCredentialConflictRecovery'
import { parseReplicaCredentialConflictFreeze, type ReplicaCredentialConflictFreeze } from './replicaCredentialConflictFreeze'
import { replicaCredentialFreezeKey } from './replicaCredentialFreeze'
import { workspaceOwnerSigningContext } from './workspaceOwnerSigning'
import { approveRustyScope, readRustyScopePolicyRevision, verifySavedScopeEnrollmentConfirmation } from './rustyEnrollment'
import { completeScopeEnrollmentIntent, readScopeEnrollmentIntent, type ScopeEnrollmentBinding, type ScopeEnrollmentIntent } from './rustyEnrollmentJournal'
import { capturePrivateReplicaConflict, planPrivateReplicaConflictActivation, getPrivateReplicaProgress, privateReplicaStateStorageKey } from './privateReplicaRepository'
import { discoverWorkspaceReplicaWorkers } from './workspaceReplicaWorkers'
import { parseReplicaWriterWorkers, type ReplicaWriterWorker } from './replicaWriterWorkersState'
import { assertAutomationKeyHistorySupported, assertAutomationStorageRotationSupported, prepareAutomationStorageRotation, readAutomationInstance, rotateAutomationStorageCredentials } from '../app/automationInstanceClient'
import type { RustyScopePolicyReceipt } from '../product-replica'
import { identityDevicePreferencesChanged } from './identityDevicePreferenceEvents'
import { record, traceDiagnosticOperation } from './telemetry'

type ConflictCapture = Awaited<ReturnType<typeof capturePrivateReplicaConflict>>
type Worker = { route: ReplicaWriterWorker; before: AutomationInstanceIdentityProof; frozen?: AutomationInstanceIdentityProof; rotated?: AutomationInstanceIdentityProof }
type Journal = { kind: 'rusty-credential-conflict-recovery'; version: 1; freeze: ReplicaCredentialConflictFreeze;
  capture: ConflictCapture; workers?: Worker[]; policy?: { request: ScopeEnrollmentIntent; receipt: RustyScopePolicyReceipt };
  drained?: { progress?: ReplicaState<BlindObject>; receipt?: BlindReceipt }; activated?: PrivateReplicaConfig }
const same = (a: unknown, b: unknown) => canonicalizeJson(JSON.parse(JSON.stringify({ value: a }))) === canonicalizeJson(JSON.parse(JSON.stringify({ value: b })))
const profileKey = 'tincanban.local_profile.v1'
const pin = (config: Pick<PrivateReplicaConfig, "origin" | "scopeId" | "keyEpoch" | "servicePublicKey">) => ({ origin: config.origin, scopeId: config.scopeId, keyEpoch: config.keyEpoch, servicePublicKey: config.servicePublicKey })
const unavailable = async (): Promise<never> => { throw new Error('Conflict recovery cannot manufacture old replica content') }

export async function continueCredentialConflictRecovery(ports: {
  freezeWorkers: () => Promise<void>; confirmPolicy: () => Promise<void>; drainOriginal: () => Promise<void>;
  rotateWorkers: () => Promise<void>; activate: () => Promise<void>; confirmSnapshot: () => Promise<void>;
}, trace?: CredentialRecoveryTrace): Promise<void> {
  await traceRecoveryPhase(trace, "freezeWorkers", ports.freezeWorkers)
  await traceRecoveryPhase(trace, "confirmPolicy", ports.confirmPolicy)
  await traceRecoveryPhase(trace, "drainOriginal", ports.drainOriginal)
  await traceRecoveryPhase(trace, "rotateWorkers", ports.rotateWorkers)
  await traceRecoveryPhase(trace, "activate", ports.activate)
  await traceRecoveryPhase(trace, "confirmSnapshot", ports.confirmSnapshot)
}
type CredentialRecoveryTrace = { workspaceId: string; serverHost: string; transitionId: string }
async function traceRecoveryPhase<T>(trace: CredentialRecoveryTrace | undefined, phase: string,
  operation: () => Promise<T>): Promise<T> {
  if (!trace) return operation()
  const detail = { phase, "workspace.id": trace.workspaceId, "server.address": trace.serverHost,
    "recovery.transition_id": trace.transitionId }
  recordRecoveryPhase("started", detail)
  try {
    const result = await traceDiagnosticOperation(`rusty.credential-recovery.${phase}`, detail, () => operation())
    recordRecoveryPhase("completed", detail)
    return result
  } catch (error) {
    recordRecoveryPhase("failed", { ...detail, error })
    throw error
  }
}
function recordRecoveryPhase(outcome: "started" | "completed" | "failed", detail: Record<string, unknown>) {
  try { record(`rusty.credential-recovery.phase.${outcome}`, detail, outcome === "failed" ? "error" : "info") }
  catch { /* Diagnostic failures must not change recovery ordering. */ }
}
async function enrollmentBinding(freeze: ReplicaCredentialConflictFreeze): Promise<ScopeEnrollmentBinding> {
  const next = freeze.proposal.next
  return { origin: freeze.origin, scopeId: freeze.scopeId, servicePublicKey: next.servicePublicKey,
    personId: freeze.personId, deviceId: freeze.signerDeviceId, revoked: false,
    readTokenHash: await sha256Base64Url(new TextEncoder().encode(next.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(next.writeToken)),
    ...(next.purpose === 'identity' ? {} : { minimumWriterVersion: 2 as const }) }
}
async function workerDescription(worker: Worker, proof: AutomationInstanceIdentityProof) {
  const issuedAt = proof?.signed?.payload?.issuedAt
  if (!Number.isSafeInteger(issuedAt)) throw new Error('Invalid retained Worker proof time')
  return (await verifyAutomationInstanceIdentity(proof, { ...worker.route, requestNonce: proof.signed.payload.requestNonce }, issuedAt)).description
}
function sameApproval(left: Awaited<ReturnType<typeof workerDescription>>, right: Awaited<ReturnType<typeof workerDescription>>) {
  const fields = (value: typeof left) => [value.workspaceId, value.boardId, value.definitionId, value.executorPersonId,
    value.grantId, value.expiresAt, value.state, value.adoptionRequired]
  if (!same(fields(left), fields(right))) throw new Error('Conflict recovery changed Worker approval')
}
async function validateConflictWorker(journal: Journal, worker: Worker): Promise<void> {
  const freeze = journal.freeze
      const before = await workerDescription(worker, worker.before)
      if (!before.storage || !freeze.proposal.previousVariants.some(config => same(pin(config), pin(before.storage!)))) throw new Error('Worker uses an uncaptured storage variant')
      if (worker.frozen) {
        const frozen = await workerDescription(worker, worker.frozen)
        sameApproval(before, frozen)
        if (!same(frozen.storage, before.storage) || frozen.storageTransition?.transitionId !== freeze.id) throw new Error('Worker freeze is not confirmed')
      }
      if (worker.rotated) {
        const rotated = await workerDescription(worker, worker.rotated)
        sameApproval(before, rotated)
        if (!worker.frozen || !journal.policy || !rotated.storage || !same(pin(rotated.storage), pin(freeze.proposal.next)) ||
          rotated.storage.policyRevision !== journal.policy.receipt.payload.revision || rotated.storageTransition) throw new Error('Worker rotation differs from confirmed recovery')
      }
}

async function validateConflictWorkers(journal: Journal): Promise<void> {
  const freeze = journal.freeze
  if (journal.workers) {
    if (freeze.proposal.next.purpose === 'identity' && journal.workers.length) throw new Error('Identity recovery cannot contain Workers')
    const workspaceId = freeze.proposal.next.purpose === 'identity' ? '' : freeze.proposal.next.workspaceId
    if (journal.workers.length) parseReplicaWriterWorkers(journal.workers.map(worker => worker.route), workspaceId)
    for (const worker of journal.workers) await validateConflictWorker(journal, worker)
  }
}

async function validateConflictDrain(journal: Journal): Promise<void> {
  const freeze = journal.freeze
  const pending = journal.capture.progress?.pending
  if (journal.drained) {
    if (!journal.policy) throw new Error('Outbox confirmation requires the signed replacement policy')
    if (pending) {
      const receipt = journal.drained.receipt
      if (!receipt || receipt.payload.policyRevision > journal.policy.receipt.payload.revision || receipt.payload.policyRevision < 1) throw new Error('Original pending receipt is missing or from an unknown policy')
      await verifyBlindReceipt(receipt, { ...freeze.proposal.next, policyRevision: receipt.payload.policyRevision }, pending.object, pending.requestId)
      const expected = { ...journal.capture.progress!, generation: journal.capture.progress!.generation + 1,
        lastUploaded: pending.hash, ...(pending.revision === undefined ? {} : { uploadedRevision: pending.revision }), ...(pending.identity === undefined ? {} : { contentIdentity: pending.identity }) }
      delete expected.pending
      if (!same(expected, journal.drained.progress)) throw new Error('Drained outbox progress changed the original ciphertext request')
    } else if (!same(journal.drained.progress, journal.capture.progress) || journal.drained.receipt) throw new Error('Recovery manufactured an original upload receipt')
  }
}

function validateConflictActivation(journal: Journal): void {
  const freeze = journal.freeze
  const portable = (config: PrivateReplicaConfig) => { const copy = { ...config }; delete copy.preferenceRevision; return { ...copy, cursor: 0, lastUploaded: '' } }
  if (journal.activated && (!journal.drained || !journal.workers || journal.workers.some(worker => !worker.rotated) || !same(portable(journal.activated), portable(freeze.proposal.next)) ||
    journal.activated.cursor !== (journal.capture.progress?.cursor ?? journal.capture.progressRecord?.cursor ?? 0))) {
    throw new Error('Recovery activated before exact policy/outbox/Worker confirmation')
  }
}

function assertConflictKeysRetained(journal: Journal): void {
  const freeze = journal.freeze
  for (const previous of [...journal.capture.previousVariants, ...(journal.capture.progressConfig ? [journal.capture.progressConfig] : [])]) assertRetainsReplicaContentKeys(previous, freeze.proposal.next)
}

async function validateJournal(input: unknown, profile: LocalProfile): Promise<Journal> {
  const journal = structuredClone(input) as Journal
  if (!journal || journal.kind !== 'rusty-credential-conflict-recovery' || journal.version !== 1 ||
    Object.keys(journal).some(key => !['kind', 'version', 'freeze', 'capture', 'workers', 'policy', 'drained', 'activated'].includes(key))) throw new Error('Invalid conflict recovery journal')
  const freeze = parseReplicaCredentialConflictFreeze(journal.freeze, profile.identity.personId, journal.freeze.origin)
  if (freeze.signerDeviceId !== profile.device.deviceId || !same(journal.capture.sourceWire, freeze.proposal.sourceWire)) throw new Error('Conflict recovery signer or source evidence changed')
  assertConflictKeysRetained(journal)
  if (journal.policy && (!journal.workers || journal.workers.some(worker => !worker.frozen))) throw new Error('Policy changed before every Worker freeze confirmed')
  if (journal.capture.progress) {
    if (!journal.capture.progressConfig) throw new Error('Original outbox credential binding is missing')
    parseReplicaState(journal.capture.progress, privateReplicaBinding(freeze.personId, journal.capture.progressConfig))
    if (journal.capture.progress.pending) contentKeysForEpoch(freeze.proposal.next, journal.capture.progress.pending.object.keyEpoch)
  }
  await validateConflictWorkers(journal)
  if (journal.policy) await verifySavedScopeEnrollmentConfirmation(freeze.proposal.next, profile, journal.policy.request, journal.policy.receipt)
  await validateConflictDrain(journal)
  validateConflictActivation(journal)
  return journal
}

/** Safe UI summary retains the explicit resume action after credentials activate but before fresh-snapshot confirmation. */
export async function readPendingRustyCredentialConflict(profile: LocalProfile, originInput: string) {
  const origin = blindOrigin(originInput)
  const key = (await replicaCredentialFreezeKey(profile.identity.personId, origin)).replace('tincanban.replica-credential-freeze.v1.', 'tincanban.replica-credential-conflict.v1.')
  const raw = await readLocal(key)
  if (raw === null) return undefined
  if (new TextEncoder().encode(raw).byteLength > 32 * 1024 * 1024) throw new Error('Conflict recovery journal exceeds storage bound')
  const journal = await validateJournal(JSON.parse(raw), profile)
  const next = journal.freeze.proposal.next
  return { origin, scopeId: next.scopeId, workspaceIds: next.purpose === 'identity' ? [] : [next.workspaceId],
    identityState: next.purpose === 'identity', activated: Boolean(journal.activated) }
}

type ConflictExecution = {
  app: ReturnType<typeof useTincanban>; profile: LocalProfile; freeze: ReplicaCredentialConflictFreeze; capture: ConflictCapture;
  journal: () => Journal; live: () => Promise<void>; save: (changed: Journal, plan?: LocalStatePlan) => Promise<void>;
  finishSnapshot: () => Promise<void>;
}

function conflictRecoverySteps(state: ConflictExecution) {
  const { app, profile, freeze, capture, live, save, finishSnapshot } = state
  const next = freeze.proposal.next, origin = freeze.origin, scopeId = freeze.scopeId, personId = freeze.personId
  return {
      freezeWorkers: async () => {
        if (!state.journal().workers) {
          const workers: Worker[] = []
          if (next.purpose !== 'identity') {
            const candidates = freeze.proposal.previousVariants.filter((config): config is BlindReplicaConfig => config.purpose !== 'identity')
            const routes = await discoverWorkspaceReplicaWorkers(app, candidates[0]!, live, candidates)
            for (const route of routes) { await assertAutomationStorageRotationSupported(route.origin); if (next.historicalContentKeyVariants) await assertAutomationKeyHistorySupported(route.origin); const before = await readAutomationInstance(profile, route, { ensureCurrent: live }); workers.push({ route, before: before.proof }) }
          }
          await save({ ...state.journal(), workers })
        }
        for (const worker of state.journal().workers!) {
          if (worker.frozen) continue
          const before = await workerDescription(worker, worker.before)
          const frozen = await prepareAutomationStorageRotation(profile, { ...worker.route, storage: pin(before.storage!), transitionId: freeze.id }, { ensureCurrent: live })
          await save({ ...state.journal(), workers: state.journal().workers!.map(value => same(value.route, worker.route) ? { ...value, frozen: frozen.proof } : value) })
        }
      },
      confirmPolicy: async () => {
        const policy = state.journal().policy
        if (policy) { await completeScopeEnrollmentIntent(policy.request.binding, policy.request.body, live); return }
        await approveRustyScope(next, profile, false, { expectedPolicyRevision: freeze.proposal.expectedPolicyRevision, requireExactRetry: true,
          ...(next.purpose === 'identity' ? {} : { minimumWriterVersion: 2 }), ensureCurrent: live, confirmed: async receipt => {
            const request = await readScopeEnrollmentIntent(await enrollmentBinding(freeze))
            if (!request) throw new Error('Original replacement policy request is unavailable')
            await save({ ...state.journal(), policy: { request, receipt } })
          } })
      },
      drainOriginal: async () => {
        if (state.journal().drained) return
        const pending = capture.progress?.pending
        if (!pending) { await save({ ...state.journal(), drained: { progress: capture.progress } }); return }
        await live()
        const objectId = await blindObjectId(pending.object)
        const receipt = await readBlindJson<BlindReceipt>(await fetchBlind(`${origin}/v2/scopes/${scopeId}/objects/${objectId}?writerVersion=2&observedSequence=${pending.observedSequence ?? 0}`, {
          method: 'PUT', signal: AbortSignal.timeout(30000), headers: { ...blindProducerHeaders(next), Authorization: `Bearer ${next.writeToken}`, 'Content-Type': 'application/json', 'X-Rusty-Request-Id': pending.requestId }, body: JSON.stringify(pending.object) }), 16384)
        const progress = { ...capture.progress!, generation: capture.progress!.generation + 1, lastUploaded: pending.hash, ...(pending.revision === undefined ? {} : { uploadedRevision: pending.revision }), ...(pending.identity === undefined ? {} : { contentIdentity: pending.identity }) }
        delete progress.pending
        await save({ ...state.journal(), drained: { progress, receipt } })
      },
      rotateWorkers: async () => {
        if (next.purpose === 'identity') return
        for (const worker of state.journal().workers!) {
          if (worker.rotated) continue
          const before = await workerDescription(worker, worker.before)
          const rotated = await rotateAutomationStorageCredentials(profile, { ...worker.route, storage: pin(before.storage!), transitionId: freeze.id, credentials: next, receipt: state.journal().policy!.receipt }, { ensureCurrent: live })
          await save({ ...state.journal(), workers: state.journal().workers!.map(value => same(value.route, worker.route) ? { ...value, rotated: rotated.proof } : value) })
        }
      },
      activate: async () => {
        await live()
        const activation = await planPrivateReplicaConflictActivation(personId, capture, next, state.journal().drained!, freeze)
        await save({ ...state.journal(), activated: activation.config }, activation.plan)
        identityDevicePreferencesChanged(personId)
      },
      confirmSnapshot: finishSnapshot,
  }
}

const identityBinding = (value: LocalProfile) => canonicalizeJson([value.identity.personId, value.identity.publicKey, value.device.deviceId, value.device.publicKey, value.certificate])

async function prepareConflictRecovery(profile: LocalProfile, scopeId: string, journalKey: string, guardIdentity: () => void) {
    guardIdentity()
    const raw = await readLocal(journalKey)
    if (raw && new TextEncoder().encode(raw).byteLength > 32 * 1024 * 1024) throw new Error('Conflict recovery journal exceeds storage bound')
    const journal = raw ? await validateJournal(JSON.parse(raw), profile) : undefined
    if (journal && journal.freeze.scopeId !== scopeId) throw new Error('Resume the already pending connection recovery first')
    return { raw, journal }
}

async function prepareConflictAuthority(app: ReturnType<typeof useTincanban>, profile: LocalProfile, origin: string,
  scopeId: string, workspaceId: string, capture: ConflictCapture, guardIdentity: () => void) {
    const personId = profile.identity.personId
    const profileRaw = await readLocal(profileKey)
    if (!profileRaw || identityBinding(JSON.parse(profileRaw) as LocalProfile) !== identityBinding(profile)) throw new Error('Stored identity changed before recovery')
    const ownerWorkspaceIds = [...new Set([workspaceId, ...capture.previousVariants.flatMap(config => config.purpose === 'identity' ? [] : [config.workspaceId])])]
    const contexts: Array<Awaited<ReturnType<typeof workspaceOwnerSigningContext>>> = []
    for (const id of ownerWorkspaceIds) {
      const document = await app.readWorkspaceDoc(id)
      guardIdentity()
      if (!document || document.id !== id || document.ownerPersonId !== personId) throw new Error('Only the current Owner can recover this connection')
      contexts.push(await workspaceOwnerSigningContext(profile, id, 'rusty-credential-conflict-recovery', { origin, scopeId }))
    }
    const guard = async () => { guardIdentity(); for (const context of contexts) await assertSigningContextCurrent(context); guardIdentity() }
    await guard()
    const service = await discoverBlindKeeper(origin)
    await guard()
    if (service.scopeManagement !== 1 || service.scopeEnrollmentRetry !== 1 || service.writerPolicy?.maximumWriterVersion !== 2) throw new Error('Update Rusty before connection recovery')
    return { guard, service, profileRaw }
}

/** Explicit Owner action. Origin freeze, exact source/outbox and uncertain confirmations survive restarts. */
export async function recoverRustyCredentialConflict(app: ReturnType<typeof useTincanban>, originInput: string,
  scopeId: string, workspaceId: string, ensureCurrent: () => void): Promise<void> {
  const origin = blindOrigin(originInput), active = app.getCurrentProfile()
  if (!active) throw new Error('Current identity is unavailable')
  const profile = structuredClone(active), personId = profile.identity.personId
  const freezeKey = await replicaCredentialFreezeKey(personId, origin)
  const journalKey = freezeKey.replace('tincanban.replica-credential-freeze.v1.', 'tincanban.replica-credential-conflict.v1.')
  const guardIdentity = () => { ensureCurrent(); const current = app.getCurrentProfile(); if (!current || identityBinding(current) !== identityBinding(profile)) throw new Error('Identity changed during conflict recovery') }
  const trace: CredentialRecoveryTrace = { workspaceId, serverHost: new URL(origin).host, transitionId: '' }
  await withLocalStateWriteLock(`credential-conflict-recovery:${personId}:${origin}`, async () => {
    let { raw, journal } = await traceRecoveryPhase(trace, 'readRecoveryJournal',
      () => prepareConflictRecovery(profile, scopeId, journalKey, guardIdentity))
    if (journal) trace.transitionId = journal.freeze.id
    const capture = journal?.capture ?? await traceRecoveryPhase(trace, 'captureOriginal',
      () => capturePrivateReplicaConflict(personId, origin, scopeId))
    const prepared = await traceRecoveryPhase(trace, 'verifyOwnerAndService',
      () => prepareConflictAuthority(app, profile, origin, scopeId, workspaceId, capture, guardIdentity))
    const { guard, service } = prepared
    const profileRaw = prepared.profileRaw
    if (!journal) {
      // Additively expose legacy locators under stable encryption bindings before credentials move.
      for (const config of [...capture.previousVariants, ...(capture.progressConfig ? [capture.progressConfig] : [])]) {
        if (config.purpose !== 'identity') await createWorkspaceAttachmentIndex(personId, config, guardIdentity).read()
      }
      await guard()
      const expectedPolicyRevision = await traceRecoveryPhase(trace, 'readPolicyRevision',
        () => readRustyScopePolicyRevision({ origin, scopeId, servicePublicKey: service.servicePublicKey }, profile, guard))
      const random = () => encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32)))
      const proposal = buildReplicaCredentialConflictRecovery(capture.sourceWire, { origin, scopeId, servicePublicKey: service.servicePublicKey,
        expectedPolicyRevision, freshContentKey: random(), freshReadToken: random(), freshWriteToken: random(),
        extraRetainedConfigs: capture.progressConfig ? [capture.progressConfig] : [] })
      const freeze: ReplicaCredentialConflictFreeze = { kind: 'rusty-credential-conflict-freeze', version: 2, id: crypto.randomUUID(), personId,
        signerDeviceId: profile.device.deviceId, origin, scopeId, proposal }
      trace.transitionId = freeze.id
      journal = { kind: 'rusty-credential-conflict-recovery', version: 1, freeze, capture }
      parseReplicaCredentialConflictFreeze(freeze, personId, origin)
      const nextRaw = JSON.stringify(journal)
      await guard()
      await traceRecoveryPhase(trace, 'persistFreeze', async () => {
        if (!await compareAndSwapLocal({ conditions: [...capture.sourceConditions, { key: journalKey, value: null }, { key: freezeKey, value: null }, { key: profileKey, value: profileRaw }],
          writes: [{ key: freezeKey, value: JSON.stringify(freeze) }, { key: journalKey, value: nextRaw }] }, guardIdentity)) throw new Error('Conflict source or outbox changed before freeze; retry required')
      })
      raw = nextRaw
    }
    if (journal.freeze.proposal.next.servicePublicKey !== service.servicePublicKey) throw new Error('Rusty service pin changed during saved recovery')
    const freeze = journal.freeze, frozenRaw = JSON.stringify(freeze)
    const live = async () => {
      await guard()
      if (await readLocal(freezeKey) !== (journal!.activated ? null : frozenRaw)) throw new Error('Recovery freeze changed')
      if (!journal!.activated) {
        const difference = privateReplicaConflictSourceDifference(
          await capturePrivateReplicaConflict(personId, origin, scopeId, freeze), journal!.capture)
        if (difference) throw new Error(`Exact conflict source or original outbox changed during recovery (${difference})`)
      }
      await guard()
    }
    const save = async (changed: Journal, plan?: LocalStatePlan) => {
      await live(); await validateJournal(changed, profile)
      const nextRaw = JSON.stringify(changed)
      if (new TextEncoder().encode(nextRaw).byteLength > 32 * 1024 * 1024) throw new Error('Conflict recovery journal exceeds storage bound')
      if (!await compareAndSwapLocal({ conditions: [...(plan?.conditions ?? []), { key: journalKey, value: raw }, { key: profileKey, value: profileRaw }, { key: freezeKey, value: journal!.activated ? null : frozenRaw }],
        writes: [...(plan?.writes ?? []), { key: journalKey, value: nextRaw }, ...(changed.activated && !journal!.activated ? [{ key: freezeKey, value: null }] : [])] }, guardIdentity)) throw new Error('Recovery journal changed; original evidence retained for retry')
      raw = nextRaw; journal = changed
    }
    trace.transitionId = freeze.id
    if (journal.activated) return traceRecoveryPhase(trace, "confirmSnapshot", finishSnapshot)
    await continueCredentialConflictRecovery(conflictRecoverySteps({ app, profile, freeze, capture, live, save,
      journal: () => journal!, finishSnapshot }), trace)
    async function finishSnapshot() {
      const config = journal!.activated
      if (!config) return unavailable()
      await live()
      if (config.purpose === 'identity') {
        const { createIdentityReplica } = await import('./identityReplicaStore')
        if (!await createIdentityReplica(config, profile, guardIdentity).push()) throw new Error('Profile still changing; resume fresh-key confirmation')
      } else {
        const { createBlindReplica } = await import('./blindReplicaStore')
        await createBlindReplica(config, app, guardIdentity, async () => {}).flushCurrentSnapshot()
      }
      await live()
      const stateKey = privateReplicaStateStorageKey(personId), stateRaw = await readLocal(stateKey)
      const progress = await getPrivateReplicaProgress(personId, config)
      if (progress.pending || !progress.lastUploaded) throw new Error('Fresh-key snapshot receipt is still pending')
      const archiveKey = `${journalKey}.completed.${freeze.id}`, archived = await readLocal(archiveKey)
      if (archived !== null && archived !== raw) throw new Error('Recovery audit archive differs')
      if (!await compareAndSwapLocal({ conditions: [{ key: journalKey, value: raw }, { key: freezeKey, value: null }, { key: profileKey, value: profileRaw }, { key: archiveKey, value: archived }, { key: stateKey, value: stateRaw }],
        writes: [{ key: journalKey, value: null }, { key: archiveKey, value: raw }] }, guardIdentity)) throw new Error('Recovery completion changed; retained audit available for retry')
    }
  })
}
