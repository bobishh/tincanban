import { canonicalizeJson } from "../domain/identity"
import { compareAndSwapLocal,readLocal,type LocalStatePlan } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { parsePrivateReplicaConfig,parseReplicaConfig } from "./blindReplicaConfig"
import type { BlindReplicaConfig,IdentityReplicaConfig,PrivateReplicaConfig } from "./blindReplication"
import { emptyReplicaState,parseReplicaState,type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { type BlindObject } from "./blindEnvelope"
import { privateReplicaBinding } from "./privateReplicaBinding"
import { verifyRustyWriterPolicyReceipt } from "./rustyScopePolicy"
import { parseReplicaWriterWorkers } from "./replicaWriterWorkersState"
import { replicaCredentialFreezeCondition,replicaCredentialOriginCondition,type ReplicaCredentialFreeze } from "./replicaCredentialFreezeState"
import { replicaCredentialFreezeKey } from "./replicaCredentialFreezeState"
import { parseReplicaCredentialConflictFreeze,type ReplicaCredentialConflictFreeze } from "./replicaCredentialConflictFreeze"
import { assertRetainsReplicaContentKeys } from "./replicaContentKeys"
import { verifyBlindReceipt,type BlindReceipt } from "./blindClient"
import {
changeReplicaPreference,effectiveIdentityReplicaConfigs,effectivePrivateReplicaConfigs,effectiveReplicaConfigs,mergePrivateReplicaState,
parsePrivateReplicaWire,portableReplicaState,replicaPreferenceConflicts,updateReplicaProgress,
type PrivateReplicaState,type PrivateReplicaWire,type ReplicaWriterUpgrade
} from "./privateReplicaPreferences"
export { privateReplicaBinding } from "./privateReplicaBinding"

import { stateKey,legacySnapshotKey,settingsKey,preferenceKey,scopeKey,isPlainRecord,parseState,assertNoWriterUpgrade,matchingConfig,legacyRecordsFromRaw,legacySourcesFingerprint,mergeNovelLegacyRecords,serialize,changedCredentialOrigins,mutate,read } from "./privateReplicaRepositoryState"
export { stateKey as privateReplicaStateStorageKey } from "./privateReplicaRepositoryState"

export async function getReplicaConfigurations(owner: string): Promise<BlindReplicaConfig[]> { return effectiveReplicaConfigs(await read(owner)) }
export async function getPrivateReplicaConfigurations(owner: string): Promise<PrivateReplicaConfig[]> {
  return effectivePrivateReplicaConfigs(await read(owner))
}
export async function getIdentityReplicaConfigurations(owner: string): Promise<IdentityReplicaConfig[]> {
  return effectiveIdentityReplicaConfigs(await read(owner), owner)
}
export async function exportPrivateReplicaState(owner: string) { return portableReplicaState(await read(owner)) }
export async function getReplicaPreferenceConflicts(owner: string) { return replicaPreferenceConflicts(await read(owner)) }
export type PrivateReplicaConflictSummary = { origin: string; scopeId: string; workspaceIds: string[]; identityState: boolean }
export async function getPrivateReplicaConflictSummaries(owner: string): Promise<PrivateReplicaConflictSummary[]> {
  const state = await read(owner)
  const conflicts = new Set(replicaPreferenceConflicts(state).map(scopeKey))
  return state.entries.filter(entry => conflicts.has(scopeKey(entry))).map(entry => ({ origin: entry.origin, scopeId: entry.scopeId,
    workspaceIds: [...new Set(entry.operations.flatMap(operation => operation.config && operation.config.purpose !== "identity"
      ? [operation.config.workspaceId] : []))].sort(),
    identityState: entry.operations.some(operation => operation.purpose === "identity") }))
}

export type PrivateReplicaConflictCapture = {
  sourceWire: PrivateReplicaWire
  sourceRevision: string
  previousVariants: PrivateReplicaConfig[]
  progress?: ReplicaState<BlindObject>
  progressConfig?: PrivateReplicaConfig
  progressRecord?: PrivateReplicaState["progress"][string]
  sourceConditions: LocalStatePlan["conditions"]
}

function progressKeyHistory(fields: unknown[]): Record<string, unknown> {
  const history: Record<string, unknown> = {}
  for (const extra of fields.slice(12)) {
    if (!isPlainRecord(extra) || Object.keys(extra).length !== 1) throw new Error("Invalid original replica key history")
    const name = Object.keys(extra)[0]!
    if (!["historicalContentKeys", "historicalContentKeyVariants"].includes(name) || Object.hasOwn(history, name)) {
      throw new Error("Invalid original replica key history")
    }
    history[name] = extra[name]
  }
  return history
}

function modernProgressConfig(owner: string, origin: string, scopeId: string, fields: unknown[],
  record: PrivateReplicaState["progress"][string]): PrivateReplicaConfig {
  if (fields.length < 12 || fields.length > 14 || fields[3] !== origin || fields[4] !== scopeId ||
      (fields[1] !== "workspace" && fields[1] !== "identity")) throw new Error("Original replica scope binding changed")
  return parsePrivateReplicaConfig(JSON.stringify({ purpose: fields[1], ...(fields[1] === "identity"
    ? { personId: fields[2] } : { workspaceId: fields[2] }), origin, scopeId, keyEpoch: fields[5], policyRevision: fields[6],
    servicePublicKey: fields[7], readToken: fields[8], writeToken: fields[9], contentKey: fields[10], preferenceRevision: fields[11],
    ...progressKeyHistory(fields), cursor: record.cursor, lastUploaded: record.lastUploaded }), owner)
}

function configFromProgressBinding(owner: string, origin: string, scopeId: string,
  record: PrivateReplicaState["progress"][string]): PrivateReplicaConfig {
  const binding = record.replication?.binding
  if (!binding) throw new Error("Original replica credential binding is missing")
  const parsed: unknown = JSON.parse(binding)
  if (!Array.isArray(parsed) || parsed[0] !== owner) throw new Error("Original replica identity binding changed")
  const fields: unknown[] = parsed
  const legacy = fields.length === 11 && fields[1] === origin && fields[2] === scopeId
  const config = legacy ? parsePrivateReplicaConfig(JSON.stringify({ purpose: "workspace", origin, scopeId,
    workspaceId: fields[3], keyEpoch: fields[4], policyRevision: fields[5], servicePublicKey: fields[6], readToken: fields[7],
    writeToken: fields[8], contentKey: fields[9], preferenceRevision: fields[10], cursor: record.cursor, lastUploaded: record.lastUploaded }), owner)
    : modernProgressConfig(owner, origin, scopeId, fields, record)
  if ((legacy ? canonicalizeJson(fields) : privateReplicaBinding(owner, config)) !== binding) throw new Error("Noncanonical original replica binding")
  if (config.preferenceRevision !== record.revision) throw new Error("Original replica progress revision changed")
  return config
}

function conflictEntry(state: PrivateReplicaState, origin: string, scopeId: string) {
  const entry = state.entries.find(entry => entry.origin === origin && entry.scopeId === scopeId)
  if (!entry || !replicaPreferenceConflicts(state).some(entry => entry.origin === origin && entry.scopeId === scopeId) ||
    entry.operations.some(operation => !operation.config || operation.config.removalPending) || state.writerUpgrades?.[scopeKey(entry)]) {
    throw new Error("An unresolved active credential conflict without a writer upgrade is required")
  }
  return entry
}

function assertCapturedPending(progress: ReplicaState<BlindObject> | undefined, scopeId: string, config: PrivateReplicaConfig | undefined): void {
  if (progress?.pending && (progress.pending.object.scopeId !== scopeId || progress.pending.object.keyEpoch > config!.keyEpoch)) {
    throw new Error("Original outbox encrypted resource binding changed")
  }
}

/** Capture one physical outbox, including its original binding even if causal preferences no longer select it. */
export async function capturePrivateReplicaConflict(owner: string, origin: string, scopeId: string): Promise<PrivateReplicaConflictCapture> {
  await read(owner)
  const keys = [stateKey(owner), settingsKey(owner), preferenceKey(owner), legacySnapshotKey(owner)]
  const values = await Promise.all(keys.map(key => readLocal(key)))
  const [raw, settings, preferences, snapshot] = values
  if (raw == null || snapshot !== await legacySourcesFingerprint(owner, settings ?? null, preferences ?? null)) {
    throw new Error("Private replica source changed during conflict capture")
  }
  const state = parseState(raw, owner), sourceWire = portableReplicaState(state)
  const entry = conflictEntry(state, origin, scopeId)
  const previousVariants = entry.operations.map(operation => ({ ...structuredClone(operation.config!),
    preferenceRevision: `${operation.dot.actorId}:${operation.dot.counter}` }))
  const progressRecord = state.progress[scopeKey(entry)]
  const progressConfig = progressRecord?.replication ? configFromProgressBinding(owner, origin, scopeId, progressRecord) : undefined
  const progress = progressConfig && progressRecord?.replication
    ? parseReplicaState<BlindObject>({ ...progressRecord.replication, binding: privateReplicaBinding(owner, progressConfig) }, privateReplicaBinding(owner, progressConfig)) : undefined
  assertCapturedPending(progress, scopeId, progressConfig)
  return { sourceWire, sourceRevision: canonicalizeJson([sourceWire.personId, sourceWire.clock, entry]), previousVariants,
    ...(progressRecord ? { progressRecord: structuredClone(progressRecord) } : {}), ...(progress ? { progress, progressConfig } : {}),
    sourceConditions: keys.map((key, index) => ({ key, value: values[index]! })) }
}

async function assertConflictOutboxDrained(capture: PrivateReplicaConflictCapture, replacement: PrivateReplicaConfig,
  drained: { progress?: ReplicaState<BlindObject>; receipt?: BlindReceipt }): Promise<void> {
  const original = capture.progress, pending = original?.pending
  let expected = original && structuredClone(original)
  if (pending) {
    const receipt = drained.receipt
    if (!receipt || !Number.isSafeInteger(receipt.payload.policyRevision) || receipt.payload.policyRevision < 1 ||
      receipt.payload.policyRevision > replacement.policyRevision || original!.generation === Number.MAX_SAFE_INTEGER) {
      throw new Error("Signed original outbox confirmation is required")
    }
    await verifyBlindReceipt(receipt, { ...replacement, policyRevision: receipt.payload.policyRevision }, pending.object, pending.requestId)
    expected = { ...original!, generation: original!.generation + 1, lastUploaded: pending.hash,
      ...(pending.revision === undefined ? {} : { uploadedRevision: pending.revision }),
      ...(pending.identity === undefined ? {} : { contentIdentity: pending.identity }) }
    delete expected.pending
  } else if (drained.receipt) throw new Error("Recovery manufactured an original outbox receipt")
  if (canonicalizeJson(expected ?? null) !== canonicalizeJson(drained.progress ?? null)) throw new Error("Original outbox drain progress changed")
}

function installRecoveredProgress(next: PrivateReplicaState, owner: string, config: PrivateReplicaConfig,
  capture: PrivateReplicaConflictCapture, prior: ReplicaState<BlindObject> | undefined): void {
  const cursor = prior?.cursor ?? capture.progressRecord?.cursor ?? 0
  if (prior?.generation === Number.MAX_SAFE_INTEGER) throw new Error("Replica generation is exhausted")
  const replication = { ...emptyReplicaState<BlindObject>(privateReplicaBinding(owner, config), cursor, ""), generation: prior ? prior.generation + 1 : 0,
    ...(prior?.contentIdentity ? { contentIdentity: prior.contentIdentity } : {}) }
  next.progress[scopeKey(config)] = { revision: config.preferenceRevision!, cursor, lastUploaded: "", replication }
}

/** Only exact signed drain evidence permits replacing conflicting credentials; activation never fabricates a new outbox. */
export async function planPrivateReplicaConflictActivation(owner: string, capture: PrivateReplicaConflictCapture,
  replacement: PrivateReplicaConfig, drained: { progress?: ReplicaState<BlindObject>; receipt?: BlindReceipt },
  freeze: ReplicaCredentialConflictFreeze): Promise<{ config: PrivateReplicaConfig; plan: LocalStatePlan }> {
  capture = structuredClone(capture); replacement = structuredClone(replacement); drained = structuredClone(drained)
  freeze = parseReplicaCredentialConflictFreeze(freeze, owner, replacement.origin)
  const current = await capturePrivateReplicaConflict(owner, replacement.origin, replacement.scopeId)
  if (canonicalizeJson(current) !== canonicalizeJson(capture) || canonicalizeJson(capture.sourceWire) !== canonicalizeJson(freeze.proposal.sourceWire) ||
    capture.sourceRevision !== freeze.proposal.sourceRevision || canonicalizeJson(replacement) !== canonicalizeJson(freeze.proposal.next)) {
    throw new Error("Credential recovery source or exact proposal changed")
  }
  const freezeKey = await replicaCredentialFreezeKey(owner, replacement.origin), frozenRaw = await readLocal(freezeKey)
  if (!frozenRaw || canonicalizeJson(parseReplicaCredentialConflictFreeze(frozenRaw, owner, replacement.origin)) !== canonicalizeJson(freeze)) {
    throw new Error("Credential conflict freeze changed before activation")
  }
  for (const previous of [...capture.previousVariants, ...(capture.progressConfig ? [capture.progressConfig] : [])]) {
    assertRetainsReplicaContentKeys(previous, replacement)
  }
  await assertConflictOutboxDrained(capture, replacement, drained)
  const stateRaw = capture.sourceConditions.find(condition => condition.key === stateKey(owner))?.value
  if (!stateRaw) throw new Error("Exact private replica source is missing")
  const next = changeReplicaPreference(parseState(stateRaw, owner), replacement)
  const config = effectivePrivateReplicaConfigs(next).find(value => scopeKey(value) === scopeKey(replacement))
  if (!config?.preferenceRevision) throw new Error("Credential conflict recovery did not select one causal successor")
  installRecoveredProgress(next, owner, config, capture, drained.progress)
  const encoded = JSON.stringify(next)
  parseState(encoded, owner)
  const activated = effectivePrivateReplicaConfigs(next).find(value => scopeKey(value) === scopeKey(config))!
  return { config: activated, plan: { conditions: [...capture.sourceConditions, { key: freezeKey, value: frozenRaw }],
    writes: [{ key: stateKey(owner), value: encoded }] } }
}

export async function setReplicaPreference(owner: string, config: PrivateReplicaConfig, removed = false) {
  const checked = parsePrivateReplicaConfig(serialize(config), owner)
  const freeze = await replicaCredentialFreezeCondition(owner, checked)
  const before = await read(owner)
  const after = await mutate(owner, state => {
    assertNoWriterUpgrade(state, checked)
    return reconcileReplicaProgress(state, changeReplicaPreference(state, checked, removed))
  }, undefined, [freeze])
  return canonicalizeJson(portableReplicaState(before)) !== canonicalizeJson(portableReplicaState(after))
}

export async function receivePrivateReplicaState(owner: string, incoming: unknown) {
  const wire = parsePrivateReplicaWire(incoming)
  if (wire.personId !== owner) throw new Error("Private replica identity mismatch")
  const before = await read(owner)
  await withLocalStateWriteLock(stateKey(owner), async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await compareAndSwapLocal(await planPrivateReplicaImport(owner, wire))) return
    }
    throw new Error("Private replica import changed repeatedly; retry required")
  })
  const after = await read(owner)
  return canonicalizeJson(portableReplicaState(before)) !== canonicalizeJson(portableReplicaState(after))
}

function storageContext(config: PrivateReplicaConfig): string {
  return canonicalizeJson([config.purpose ?? "workspace", config.purpose === "identity" ? config.personId : config.workspaceId,
    config.origin, config.scopeId, config.keyEpoch, config.servicePublicKey, config.contentKey,
    config.readToken, config.writeToken, config.removalPending ?? false])
}

function compatibleWriterPolicy(previous: PrivateReplicaConfig, next: PrivateReplicaConfig): boolean {
  return next.policyRevision >= previous.policyRevision &&
    (previous.purpose === "identity" || previous.minimumWriterVersion !== 2 ||
      (next.purpose !== "identity" && next.minimumWriterVersion === 2))
}

function writerUpgradeSelection(state: PrivateReplicaState, config: BlindReplicaConfig): BlindReplicaConfig {
  const selected = effectiveReplicaConfigs(state).find(value => scopeKey(value) === scopeKey(config))
  const exact = selected && privateReplicaBinding(state.personId, selected) === privateReplicaBinding(state.personId, config)
  if (!selected || (!exact && (selected.minimumWriterVersion !== 2 || !compatibleWriterPolicy(config, selected) ||
    storageContext(config) !== storageContext(selected)))) throw new Error("Writer upgrade credential revision changed or conflicted")
  return selected
}

/** Policy-only causal updates keep the same encrypted outbox valid; key/token changes require explicit migration. */
function reconcileReplicaProgress(previous: PrivateReplicaState, next: PrivateReplicaState): PrivateReplicaState {
  const configurations = effectivePrivateReplicaConfigs(next)
  for (const config of effectivePrivateReplicaConfigs(previous)) {
    const key = scopeKey(config)
    const progress = previous.progress[key]
    const updated = configurations.find(value => scopeKey(value) === key)
    if (!progress || progress.revision !== config.preferenceRevision || !updated || updated.preferenceRevision === config.preferenceRevision) continue
    const sameContext = storageContext(config) === storageContext(updated) && compatibleWriterPolicy(config, updated)
    if (!sameContext) {
      if (progress.replication?.pending) throw new Error("Pending Rusty outbox requires explicit credential migration")
      continue
    }
    const replication = progress.replication ? { ...progress.replication, binding: privateReplicaBinding(previous.personId, updated),
      generation: progress.replication.generation + 1 } : undefined
    next.progress[key] = { ...progress, revision: updated.preferenceRevision!, ...(replication ? { replication } : {}) }
  }
  return next
}

export async function persistPrivateReplicaProgress(owner: string, config: PrivateReplicaConfig, ensureIdentity: () => void = () => {}) {
  const freeze = await replicaCredentialFreezeCondition(owner, config)
  return effectiveReplicaConfigs(await mutate(owner, state => {
    matchingConfig(state, config)
    return updateReplicaProgress(state, config)
  }, ensureIdentity, [freeze]))
}

export async function getPrivateReplicaProgress(owner: string, config: PrivateReplicaConfig,
  maintenance?: ReplicaCredentialFreeze): Promise<ReplicaState<BlindObject>> {
  await replicaCredentialFreezeCondition(owner, config, maintenance)
  const state = await read(owner)
  const selected = matchingConfig(state, config)
  const saved = state.progress[scopeKey(config)]
  const progress = saved?.revision === selected.preferenceRevision ? saved : undefined
  const binding = privateReplicaBinding(owner, selected)
  return progress?.replication ? parseReplicaState<BlindObject>(progress.replication, binding)
    : emptyReplicaState(binding, selected.cursor, selected.lastUploaded)
}

/** Freeze one exact device-local writer before any remote policy mutation. Portable preferences exclude this intent. */
export async function prepareReplicaWriterUpgrade(owner: string, config: BlindReplicaConfig,
  ensureIdentity: () => void = () => {}): Promise<ReplicaWriterUpgrade> {
  config = parseReplicaConfig(serialize(config))
  const freeze = await replicaCredentialFreezeCondition(owner, config)
  const state = await mutate(owner, current => {
    const selected = matchingConfig(current, config, true)
    if (selected.purpose === "identity" || config.minimumWriterVersion !== undefined || config.removalPending) throw new Error("Workspace writer upgrade is not applicable")
    const key = scopeKey(config)
    const previous = current.writerUpgrades?.[key]
    if (previous) {
      if (privateReplicaBinding(owner, previous.config) !== privateReplicaBinding(owner, config)) throw new Error("Writer upgrade intent revision changed")
      return current
    }
    if (current.progress[key]?.replication?.pending) throw new Error("Pending Rusty upload must be acknowledged before writer upgrade")
    return { ...current, writerUpgrades: { ...current.writerUpgrades, [key]: { id: crypto.randomUUID(), config: selected as BlindReplicaConfig } } }
  }, ensureIdentity, [freeze])
  return structuredClone(state.writerUpgrades![scopeKey(config)]!)
}

export async function readReplicaWriterUpgrade(owner: string, config: BlindReplicaConfig): Promise<ReplicaWriterUpgrade | undefined> {
  return structuredClone((await read(owner)).writerUpgrades?.[scopeKey(config)])
}

/** Add newly discovered routes before remote maintenance; retries cannot forget an already captured Worker. */
export async function captureReplicaWriterWorkers(owner: string, upgrade: ReplicaWriterUpgrade, incoming: unknown,
  ensureIdentity: () => void = () => {}): Promise<ReplicaWriterUpgrade> {
  upgrade = structuredClone(upgrade)
  const freeze = await replicaCredentialFreezeCondition(owner, upgrade.config)
  const workers = parseReplicaWriterWorkers(incoming, upgrade.config.workspaceId)
  const key = scopeKey(upgrade.config)
  const state = await mutate(owner, current => {
    if (canonicalizeJson(current.writerUpgrades?.[key] ?? null) !== canonicalizeJson(upgrade)) throw new Error("Writer upgrade intent changed before Worker capture")
    writerUpgradeSelection(current, upgrade.config)
    const captured = new Map([...(upgrade.workers ?? []), ...workers].map(worker =>
      [canonicalizeJson([worker.origin, worker.definitionId, worker.executorPersonId, worker.integrationId]), worker]))
    const union = parseReplicaWriterWorkers([...captured.values()], upgrade.config.workspaceId)
    return { ...current, writerUpgrades: { ...current.writerUpgrades, [key]: { ...upgrade, workers: union } } }
  }, ensureIdentity, [freeze])
  return structuredClone(state.writerUpgrades![key]!)
}

/** Retain the exact verified policy confirmation before refreshing any dependent Worker. */
export async function confirmReplicaWriterUpgrade(owner: string, upgrade: ReplicaWriterUpgrade, value: unknown,
  ensureIdentity: () => void = () => {}): Promise<ReplicaWriterUpgrade> {
  upgrade = structuredClone(upgrade)
  const freeze = await replicaCredentialFreezeCondition(owner, upgrade.config)
  const capturedReceipt = structuredClone(value)
  ensureIdentity()
  const receipt = await verifyRustyWriterPolicyReceipt(capturedReceipt, upgrade.config, owner,
    Math.max(upgrade.config.policyRevision, upgrade.confirmed?.payload.revision ?? 0))
  ensureIdentity()
  const key = scopeKey(upgrade.config)
  const state = await mutate(owner, current => {
    if (canonicalizeJson(current.writerUpgrades?.[key] ?? null) !== canonicalizeJson(upgrade)) throw new Error("Writer upgrade intent changed before confirmation")
    writerUpgradeSelection(current, upgrade.config)
    return { ...current, writerUpgrades: { ...current.writerUpgrades, [key]: { ...upgrade, confirmed: receipt } } }
  }, ensureIdentity, [freeze])
  return structuredClone(state.writerUpgrades![key]!)
}

/** Caller has verified Rusty's signed floor-2 receipt. Publish new causal credentials and retained progress in one transaction. */
function assertConfirmedWriterRevision(revision: number, currentRevision: number, upgrade: ReplicaWriterUpgrade): void {
  const noOpConfirmed = upgrade.confirmed?.payload.minimumWriterVersion === 2 && upgrade.confirmed.payload.revision === revision
  if (!Number.isSafeInteger(revision) || revision < currentRevision || (revision === currentRevision && !noOpConfirmed)) {
    throw new Error("Writer upgrade policy revision did not confirm current credentials")
  }
}

export async function completeReplicaWriterUpgrade(owner: string, upgrade: ReplicaWriterUpgrade, policyRevision: number,
  ensureIdentity: () => void = () => {}): Promise<BlindReplicaConfig> {
  return finishReplicaWriterUpgrade(owner, upgrade, policyRevision, ensureIdentity, false)
}

/** Rusty's verified receipt activates this device independently of automation availability. */
export async function activateReplicaWriterUpgrade(owner: string, upgrade: ReplicaWriterUpgrade, policyRevision: number,
  ensureIdentity: () => void = () => {}): Promise<BlindReplicaConfig> {
  const receipt = await verifyRustyWriterPolicyReceipt(upgrade.confirmed, upgrade.config, owner, policyRevision)
  if (receipt.payload.revision !== policyRevision) throw new Error("Writer activation requires the exact signed policy revision")
  ensureIdentity()
  return finishReplicaWriterUpgrade(owner, upgrade, policyRevision, ensureIdentity, true)
}

async function finishReplicaWriterUpgrade(owner: string, upgrade: ReplicaWriterUpgrade, policyRevision: number,
  ensureIdentity: () => void, retainMaintenance: boolean): Promise<BlindReplicaConfig> {
  upgrade = structuredClone(upgrade)
  const freeze = await replicaCredentialFreezeCondition(owner, upgrade.config)
  const config = parseReplicaConfig(serialize(upgrade.config))
  assertConfirmedWriterRevision(policyRevision, config.policyRevision, upgrade)
  if (policyRevision === config.policyRevision) await verifyRustyWriterPolicyReceipt(upgrade.confirmed!, config, owner, config.policyRevision)
  const key = scopeKey(config)
  const state = await mutate(owner, current => {
    const pending = current.writerUpgrades?.[key]
    if (!pending || canonicalizeJson(pending) !== canonicalizeJson(upgrade)) throw new Error("Writer upgrade intent is no longer pending")
    const selected = writerUpgradeSelection(current, config)
    const progress = current.progress[key]
    assertConfirmedWriterRevision(policyRevision, selected.policyRevision, upgrade)
    if (upgrade.localActivated) {
      return finishActiveWriterMaintenance(current, selected, policyRevision, key, retainMaintenance)
    }
    if (progress?.replication?.pending) throw new Error("Pending Rusty upload prevents writer upgrade completion")
    const next = changeReplicaPreference(current, { ...selected, policyRevision, minimumWriterVersion: 2 } as BlindReplicaConfig)
    const [updated] = effectiveReplicaConfigs(next).filter(value => scopeKey(value) === key)
    if (!updated) throw new Error("Writer upgrade preference conflict")
    if (progress) {
      if (progress.revision !== selected.preferenceRevision) throw new Error("Writer upgrade progress revision changed")
      const replication = progress.replication ? { ...progress.replication, binding: privateReplicaBinding(owner, updated),
        generation: progress.replication.generation + 1 } : undefined
      next.progress[key] = { ...progress, revision: updated.preferenceRevision!, ...(replication ? { replication } : {}) }
    }
    if (retainMaintenance) next.writerUpgrades![key] = { ...upgrade, localActivated: true }
    else delete next.writerUpgrades![key]
    if (!Object.keys(next.writerUpgrades!).length) delete next.writerUpgrades
    return next
  }, ensureIdentity, [freeze])
  return effectiveReplicaConfigs(state).find(value => scopeKey(value) === key)!
}

function finishActiveWriterMaintenance(current: PrivateReplicaState, selected: BlindReplicaConfig, policyRevision: number,
  key: string, retainMaintenance: boolean): PrivateReplicaState {
  if (selected.minimumWriterVersion !== 2 || selected.policyRevision !== policyRevision) throw new Error("Activated writer policy changed before maintenance completion")
  if (retainMaintenance) return current
  const next = structuredClone(current)
  delete next.writerUpgrades![key]
  if (!Object.keys(next.writerUpgrades!).length) delete next.writerUpgrades
  return next
}

/** Prepare a portable private-state merge against exact v2 and legacy bytes; never writes during planning. */
export async function planPrivateReplicaImport(owner: string, incoming: unknown): Promise<LocalStatePlan> {
  const incomingSnapshot = structuredClone(incoming)
  const wire = parsePrivateReplicaWire(incomingSnapshot)
  if (wire.personId !== owner) throw new Error("Private replica identity mismatch")

  const keys = [stateKey(owner), settingsKey(owner), preferenceKey(owner), legacySnapshotKey(owner)]
  const [stateRaw, settingsRaw, preferencesRaw, snapshotRaw] = await Promise.all(keys.map(key => readLocal(key)))
  const snapshot = await legacySourcesFingerprint(owner, settingsRaw, preferencesRaw)
  let state = stateRaw === null ? legacyRecordsFromRaw(owner, settingsRaw, preferencesRaw) : parseState(stateRaw, owner)
  const originalEntries = stateRaw === null ? [] : state.entries
  if (stateRaw !== null && snapshot !== snapshotRaw) state = mergeNovelLegacyRecords(state, owner, settingsRaw, preferencesRaw)
  const next = reconcileReplicaProgress(state, mergePrivateReplicaState(state, wire))
  const changedOrigins = changedCredentialOrigins(originalEntries, next.entries)
  const freezes = await Promise.all(changedOrigins.map(origin => replicaCredentialOriginCondition(owner, origin)))
  next.migrated = true
  const encoded = JSON.stringify(next)
  parseState(encoded, owner)
  const selected = effectiveReplicaConfigs(next)
  const changed = effectiveReplicaConfigs(state).filter(config => {
    const updated = selected.find(value => scopeKey(value) === scopeKey(config))
    return updated && updated.preferenceRevision !== config.preferenceRevision
  })
  const migrations = changed.length ? await import("./attachmentIndexScope").then(module =>
    Promise.all(changed.map(config => module.planWorkspaceAttachmentIndexMigration(owner, config)))) : []
  return {
    conditions: [...keys.map((key, index) => ({ key, value: [stateRaw, settingsRaw, preferencesRaw, snapshotRaw][index] })), ...freezes,
      ...migrations.flatMap(plan => plan.conditions)],
    writes: [...(encoded === stateRaw ? [] : [{ key: stateKey(owner), value: encoded }]),
      ...(snapshot === snapshotRaw ? [] : [{ key: legacySnapshotKey(owner), value: snapshot }]), ...migrations.flatMap(plan => plan.writes)],
  }
}

function installActivatedResourceProgress(next: PrivateReplicaState, owner: string, selected: PrivateReplicaConfig,
  progress: PrivateReplicaState["progress"][string] | undefined): void {
    const activated = effectivePrivateReplicaConfigs(next).find(config => scopeKey(config) === scopeKey(selected))
    if (!activated?.preferenceRevision) throw new Error("Credential activation produced a conflict")
    const binding = privateReplicaBinding(owner, activated)
    const previousReplica = progress?.replication
    if (previousReplica?.generation === Number.MAX_SAFE_INTEGER) throw new Error("Replica generation is exhausted")
    const replication = { ...emptyReplicaState<BlindObject>(binding, progress?.cursor ?? selected.cursor, ""),
      generation: previousReplica ? previousReplica.generation + 1 : 0,
      ...(previousReplica?.contentIdentity ? { contentIdentity: previousReplica.contentIdentity } : {}) }
    next.progress[scopeKey(selected)] = { revision: activated.preferenceRevision, cursor: replication.cursor, lastUploaded: "", replication }
}

function activateFrozenResource(owner: string, state: PrivateReplicaState, next: PrivateReplicaState,
  current: PrivateReplicaConfig[], resource: ReplicaCredentialFreeze["resources"][number], revision: number | undefined): PrivateReplicaState {
    const previous = resource.previous
    const selected = current.find(config => scopeKey(config) === scopeKey(previous))
    if (!selected || privateReplicaBinding(owner, selected) !== privateReplicaBinding(owner, previous) ||
      state.writerUpgrades?.[scopeKey(previous)]) throw new Error("Frozen credential revision or writer policy changed")
    if (!Number.isSafeInteger(revision) || revision! <= previous.policyRevision) throw new Error("Confirmed scope policy did not advance")
    const progress = state.progress[scopeKey(previous)]
    if (progress && progress.revision !== selected.preferenceRevision || progress?.replication?.pending) {
      throw new Error("Pending or changed Rusty outbox prevents credential activation")
    }
    const replacement: PrivateReplicaConfig = resource.next.purpose === "identity"
      ? { ...resource.next, policyRevision: revision! }
      : { ...resource.next, policyRevision: revision!, minimumWriterVersion: 2 }
    next = changeReplicaPreference(next, replacement)
    installActivatedResourceProgress(next, owner, previous, progress)
    return next
}

/** A verified transition activates every captured scope together; old outboxes must already be acknowledged. */
export async function planReplicaCredentialActivation(owner: string, pending: ReplicaCredentialFreeze,
  revisions: Record<string, number>): Promise<{ plan: LocalStatePlan; configs: PrivateReplicaConfig[] }> {
  pending = structuredClone(pending)
  revisions = structuredClone(revisions)
  if (pending.personId !== owner || Object.keys(revisions).length !== pending.resources.length) throw new Error("Credential activation must cover every frozen scope")
  await read(owner)
  const keys = [stateKey(owner), settingsKey(owner), preferenceKey(owner), legacySnapshotKey(owner)]
  const [raw, settings, preferences, snapshot] = await Promise.all(keys.map(key => readLocal(key)))
  if (raw === null || snapshot !== await legacySourcesFingerprint(owner, settings, preferences)) throw new Error("Previous credentials changed during the frozen transition")
  const state = parseState(raw, owner)
  const current = effectivePrivateReplicaConfigs(state).filter(config => config.origin === pending.origin)
  if (current.length !== pending.resources.length) throw new Error("Frozen scope set changed before activation")
  let next = structuredClone(state)
  const freezes: LocalStatePlan["conditions"] = []
  for (const resource of pending.resources) {
    freezes.push(await replicaCredentialFreezeCondition(owner, resource.previous, pending))
    next = activateFrozenResource(owner, state, next, current, resource, revisions[resource.previous.scopeId])
  }
  const encoded = JSON.stringify(next)
  parseState(encoded, owner)
  return { plan: { conditions: [...keys.map((key, index) => ({ key, value: [raw, settings, preferences, snapshot][index] })), ...freezes],
    writes: [{ key: stateKey(owner), value: encoded }] },
  configs: effectivePrivateReplicaConfigs(next).filter(config => config.origin === pending.origin) }
}

/** One transaction publishes cursor, acknowledgment and exact outbox under the current credential revision. */
export async function persistPrivateReplicaState(owner: string, config: PrivateReplicaConfig, expectedGeneration: number,
  incoming: ReplicaState<BlindObject>, ensureIdentity: () => void = () => {}, maintenance?: ReplicaCredentialFreeze) {
  const freeze = await replicaCredentialFreezeCondition(owner, config, maintenance)
  const updated = await mutate(owner, state => {
    const selected = matchingConfig(state, config)
    const binding = privateReplicaBinding(owner, selected)
    const next = parseReplicaState<BlindObject>(incoming, binding)
    const previous = state.progress[scopeKey(config)]?.replication
    if ((previous?.generation ?? 0) !== expectedGeneration || next.generation !== expectedGeneration + 1 || next.cursor < selected.cursor) {
      throw new Error("Replica progress generation changed during persistence")
    }
    const copy = structuredClone(state)
    copy.progress[scopeKey(config)] = { revision: selected.preferenceRevision!, cursor: next.cursor, lastUploaded: next.lastUploaded, replication: next }
    return copy
  }, ensureIdentity, [freeze])
  return effectiveReplicaConfigs(updated)
}
