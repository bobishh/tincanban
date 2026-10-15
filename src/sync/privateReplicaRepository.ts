import { canonicalizeJson } from "../domain/identity"
import { compareAndSwapLocal, readLocal, updateLocal, type LocalStatePlan } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { parsePrivateReplicaConfig, parseReplicaConfig } from "./blindReplicaConfig"
import type { BlindReplicaConfig, IdentityReplicaConfig, PrivateReplicaConfig } from "./blindReplication"
import { emptyReplicaState, parseReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { decodeBlindBytes, type BlindObject } from "./blindEnvelope"
import { privateReplicaBinding } from "./privateReplicaBinding"
import { parseRustyScopePolicyReceipt, verifyRustyWriterPolicyReceipt } from "./rustyScopePolicy"
import { parseReplicaWriterWorkers } from "./replicaWriterWorkersState"
export { privateReplicaBinding } from "./privateReplicaBinding"
import { changeReplicaPreference, effectiveIdentityReplicaConfigs, effectivePrivateReplicaConfigs, effectiveReplicaConfigs, emptyPrivateReplicaState, mergePrivateReplicaState,
  parsePrivateReplicaWire, portableReplicaState, removeReplicaPreference, replicaPreferenceConflicts, updateReplicaProgress,
  type PrivateReplicaState, type ReplicaWriterUpgrade } from "./privateReplicaPreferences"

const stateKey = (owner: string) => `tincanban.private-replica-state.v2.${owner}`
const settingsKey = (owner: string) => `tincanban.blind-replicas.v1.${owner}`
const preferenceKey = (owner: string) => `tincanban.device-replica-preferences.v1.${owner}`
const scopeKey = (value: { origin: string; scopeId: string }) => `${value.origin}/${value.scopeId}`
type LegacyPreference = { origin: string; scopeId: string; changedAt: number; config: BlindReplicaConfig | null }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value as object) as object | null
  return prototype === Object.prototype || prototype === null
}

function parseState(raw: string, owner: string): PrivateReplicaState {
  const value = JSON.parse(raw) as PrivateReplicaState
  const wire = parsePrivateReplicaWire(value)
  if (wire.personId !== owner || typeof value.actorId !== "string" || !value.progress || typeof value.progress !== "object" ||
    Array.isArray(value.progress) || value.migrated !== true) throw new Error("Invalid private replica repository")
  const progress = validateProgress(value.progress, wire.entries)
  const state = { ...emptyPrivateReplicaState(owner, value.actorId), ...wire, progress, migrated: true }
  if (value.writerUpgrades !== undefined) state.writerUpgrades = parseWriterUpgrades(value.writerUpgrades, wire.entries)
  for (const config of effectivePrivateReplicaConfigs(state)) parsePrivateReplicaConfig(JSON.stringify(config), owner)
  migrateLegacyReplicaBindings(state, owner)
  return state
}

function parseWriterUpgrades(value: unknown, entries: PrivateReplicaState["entries"]): Record<string, ReplicaWriterUpgrade> {
  if (!isPlainRecord(value) || Object.keys(value).length > 128) throw new Error("Invalid writer upgrade journal")
  const upgrades: Record<string, ReplicaWriterUpgrade> = {}
  for (const [key, raw] of Object.entries(value)) {
    const parsed = parseWriterUpgrade(raw)
    if (scopeKey(parsed.config) !== key || !entries.some(entry => scopeKey(entry) === key)) throw new Error("Invalid writer upgrade intent scope")
    upgrades[key] = parsed
  }
  return upgrades
}

function parseWriterUpgrade(raw: unknown): ReplicaWriterUpgrade {
  if (!isPlainRecord(raw) || Object.keys(raw).some(field => !["id", "config", "confirmed", "workers"].includes(field)) || typeof raw.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id)) throw new Error("Invalid writer upgrade intent")
  const config = parseReplicaConfig(serialize(raw.config))
  if (config.minimumWriterVersion !== undefined || config.removalPending || !config.preferenceRevision) throw new Error("Invalid writer upgrade intent scope")
  const confirmed = parseWriterUpgradeConfirmation(raw.confirmed, config)
  const workers = raw.workers === undefined ? undefined : parseReplicaWriterWorkers(raw.workers, config.workspaceId)
  return { id: raw.id, config, ...(confirmed ? { confirmed } : {}), ...(workers ? { workers } : {}) }
}

function parseWriterUpgradeConfirmation(value: unknown, config: BlindReplicaConfig) {
  if (value === undefined) return undefined
  const receipt = parseRustyScopePolicyReceipt(value)
  const payload = receipt.payload
  if (payload.scopeId !== config.scopeId || payload.minimumWriterVersion !== 2 || payload.revoked ||
    payload.revision <= config.policyRevision) throw new Error("Invalid confirmed writer upgrade intent")
  return receipt
}

function migrateLegacyReplicaBindings(state: PrivateReplicaState, owner: string): void {
  for (const config of effectivePrivateReplicaConfigs(state)) {
    const key = scopeKey(config)
    const progress = state.progress[key]
    if (!progress?.replication || progress.revision !== config.preferenceRevision) continue
    const binding = privateReplicaBinding(owner, config)
    let replica = progress.replication
    if (replica.binding !== binding) {
      const matchesLegacyWorkspaceBinding = config.purpose !== "identity" && replica.binding === canonicalizeJson([
        owner, config.origin, config.scopeId, config.workspaceId, config.keyEpoch, config.policyRevision,
        config.servicePublicKey, config.readToken, config.writeToken, config.contentKey, config.preferenceRevision,
      ])
      if (!matchesLegacyWorkspaceBinding) throw new Error("Invalid or changed replica binding")
      replica = { ...replica, binding }
      progress.replication = replica
    }
    progress.replication = parseReplicaState<BlindObject>(replica, binding)
  }
}

function validateProgress(value: unknown, entries: PrivateReplicaState["entries"]): PrivateReplicaState["progress"] {
  if (!isPlainRecord(value)) throw new Error("Invalid private replica progress")
  const records = Object.entries(value)
  if (records.length > 128) throw new Error("Too many private replica progress records")
  const knownEntries = new Set(entries.map(scopeKey))
  const progress: PrivateReplicaState["progress"] = {}
  for (const [key, record] of records) {
    if (key.length > 4_352 || !knownEntries.has(key)) throw new Error("Invalid private replica progress scope")
    progress[key] = parseProgressRecord(record)
  }
  return progress
}

function parseProgressRecord(value: unknown): PrivateReplicaState["progress"][string] {
  if (!isPlainRecord(value) || Object.keys(value).length < 3 || Object.keys(value).length > 4 ||
    Object.keys(value).some(field => !["revision", "cursor", "lastUploaded", "replication"].includes(field))) {
    throw new Error("Invalid private replica progress fields")
  }
  const revision = value.revision
  const cursor = value.cursor
  const lastUploaded = value.lastUploaded
  if (!isProgressRevision(revision) || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 ||
    typeof lastUploaded !== "string" || !(lastUploaded === "" || /^[A-Za-z0-9_-]{43}$/.test(lastUploaded))) {
    throw new Error("Invalid private replica progress")
  }
  const replication = value.replication === undefined ? undefined : parseStoredReplica(value.replication, cursor, lastUploaded)
  return { revision, cursor, lastUploaded, ...(replication ? { replication } : {}) }
}

function parseStoredReplica(value: unknown, cursor: number, lastUploaded: string): ReplicaState<BlindObject> {
  if (!isPlainRecord(value) || typeof value.binding !== "string") throw new Error("Invalid local replica progress")
  const state = parseReplicaState<BlindObject>(value, value.binding)
  if (state.cursor !== cursor || state.lastUploaded !== lastUploaded) throw new Error("Divergent local replica progress")
  const pending = state.pending
  if (pending) {
    const object = pending.object
    if (!object || object.version !== 1 || typeof object.scopeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(object.scopeId) ||
      !Number.isSafeInteger(object.keyEpoch) || object.keyEpoch < 1 || decodeBlindBytes(object.nonce).length !== 12 ||
      decodeBlindBytes(object.ciphertext).length !== pending.bytes + 16) throw new Error("Invalid local encrypted outbox")
  }
  return state
}

function assertNoWriterUpgrade(state: PrivateReplicaState, config: Pick<PrivateReplicaConfig, "origin" | "scopeId">): void {
  if (state.writerUpgrades?.[scopeKey(config)]) throw new Error("Rusty writer policy upgrade is pending; retry the upgrade before replication")
}

function matchingConfig(state: PrivateReplicaState, config: PrivateReplicaConfig, allowUpgrade = false): PrivateReplicaConfig {
  if (!allowUpgrade) assertNoWriterUpgrade(state, config)
  const normalized = parsePrivateReplicaConfig(JSON.stringify(config), state.personId)
  const selected = effectivePrivateReplicaConfigs(state).find(value => scopeKey(value) === scopeKey(normalized) &&
    (value.purpose ?? "workspace") === (normalized.purpose ?? "workspace"))
  if (!selected || privateReplicaBinding(state.personId, selected) !== privateReplicaBinding(state.personId, normalized)) {
    throw new Error("Rusty credential revision changed during replication")
  }
  return selected
}

function isProgressRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 &&
    value.split("|").every(part => /^[A-Za-z0-9:_-]{1,128}:[1-9]\d*$/.test(part))
}

async function legacyRecords(owner: string): Promise<PrivateReplicaState> {
  const [saved, preferences] = await Promise.all([readLocal(settingsKey(owner)), readLocal(preferenceKey(owner))])
  return legacyRecordsFromRaw(owner, saved, preferences)
}

function legacyRecordsFromRaw(owner: string, saved: string | null, preferences: string | null): PrivateReplicaState {
  const configs = parseLegacyConfigs(JSON.parse(saved ?? "[]"))
  const records = parseLegacyPreferences(JSON.parse(preferences ?? "[]"))
  const byScope = new Map<string, LegacyPreference>(configs.map(config => [scopeKey(config), { origin: config.origin, scopeId: config.scopeId, changedAt: 1, config }]))
  for (const record of records) byScope.set(scopeKey(record), record)
  return migrateLegacyRecords(owner, configs, [...byScope.values()])
}

function parseLegacyConfigs(value: unknown): BlindReplicaConfig[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid older-format private replica state")
  return (value as unknown[]).map(item => parseReplicaConfig(serialize(item)))
}

function parseLegacyPreferences(value: unknown): LegacyPreference[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid older-format private replica state")
  return (value as unknown[]).map(parseLegacyPreference)
}

function parseLegacyPreference(value: unknown): LegacyPreference {
  if (!isPlainRecord(value) || typeof value.origin !== "string" || typeof value.scopeId !== "string" ||
    typeof value.changedAt !== "number" || !Number.isSafeInteger(value.changedAt) || value.changedAt < 1) {
    throw new Error("Invalid older-format replica preference")
  }
  const config = value.config === null ? null : parseReplicaConfig(serialize(value.config))
  const record = { origin: value.origin, scopeId: value.scopeId, changedAt: value.changedAt, config }
  if (config && scopeKey(config) !== scopeKey(record)) throw new Error("Older-format replica scope mismatch")
  return record
}

function migrateLegacyRecords(owner: string, configs: BlindReplicaConfig[], records: LegacyPreference[]): PrivateReplicaState {
  let state = emptyPrivateReplicaState(owner, crypto.randomUUID())
  for (const record of [...records].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)))) {
    if (!record.config) { state = removeReplicaPreference(state, record.origin, record.scopeId); continue }
    state = changeReplicaPreference(state, record.config)
    const effective = effectiveReplicaConfigs(state).find(value => scopeKey(value) === scopeKey(record))!
    const old = configs.find(value => scopeKey(value) === scopeKey(record))
    const portable = (value: BlindReplicaConfig) => ({ ...value, cursor: 0, lastUploaded: "", preferenceRevision: undefined })
    if (old && canonicalizeJson(portable(old)) === canonicalizeJson(portable(record.config))) {
      state = updateReplicaProgress(state, { ...effective, cursor: old.cursor, lastUploaded: old.lastUploaded })
    }
  }
  return { ...state, migrated: true }
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error("Invalid private replica value")
  return text
}

async function mutate(owner: string, change: (current: PrivateReplicaState) => PrivateReplicaState,
  ensureIdentity: () => void = () => {}): Promise<PrivateReplicaState> {
  if (!owner || owner.length > 128) throw new Error("Invalid private replica identity")
  return withLocalStateWriteLock(stateKey(owner), async () => {
    ensureIdentity()
    const initial = await readLocal(stateKey(owner)) ? undefined : await legacyRecords(owner)
    const raw = await updateLocal(stateKey(owner), current => {
      ensureIdentity()
      const next = change(current ? parseState(current, owner) : initial!)
      const encoded = JSON.stringify(next)
      parseState(encoded, owner)
      ensureIdentity()
      return encoded
    })
    return parseState(raw, owner)
  })
}

async function read(owner: string): Promise<PrivateReplicaState> {
  const raw = await readLocal(stateKey(owner))
  if (!raw) return mutate(owner, state => state)
  const parsed = parseState(raw, owner)
  return JSON.stringify(parsed) === raw ? parsed : mutate(owner, state => state)
}

export async function getReplicaConfigurations(owner: string): Promise<BlindReplicaConfig[]> { return effectiveReplicaConfigs(await read(owner)) }
export async function getPrivateReplicaConfigurations(owner: string): Promise<PrivateReplicaConfig[]> {
  return effectivePrivateReplicaConfigs(await read(owner))
}
export async function getIdentityReplicaConfigurations(owner: string): Promise<IdentityReplicaConfig[]> {
  return effectiveIdentityReplicaConfigs(await read(owner), owner)
}
export async function exportPrivateReplicaState(owner: string) { return portableReplicaState(await read(owner)) }
export async function getReplicaPreferenceConflicts(owner: string) { return replicaPreferenceConflicts(await read(owner)) }

export async function setReplicaPreference(owner: string, config: PrivateReplicaConfig, removed = false) {
  const checked = parsePrivateReplicaConfig(serialize(config), owner)
  const before = await read(owner)
  const after = await mutate(owner, state => {
    assertNoWriterUpgrade(state, checked)
    return changeReplicaPreference(state, checked, removed)
  })
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
  return effectiveReplicaConfigs(await mutate(owner, state => {
    assertNoWriterUpgrade(state, config)
    return updateReplicaProgress(state, config)
  }, ensureIdentity))
}

export async function getPrivateReplicaProgress(owner: string, config: PrivateReplicaConfig): Promise<ReplicaState<BlindObject>> {
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
  }, ensureIdentity)
  return structuredClone(state.writerUpgrades![scopeKey(config)]!)
}

export async function readReplicaWriterUpgrade(owner: string, config: BlindReplicaConfig): Promise<ReplicaWriterUpgrade | undefined> {
  return structuredClone((await read(owner)).writerUpgrades?.[scopeKey(config)])
}

/** Add newly discovered routes before remote maintenance; retries cannot forget an already captured Worker. */
export async function captureReplicaWriterWorkers(owner: string, upgrade: ReplicaWriterUpgrade, incoming: unknown,
  ensureIdentity: () => void = () => {}): Promise<ReplicaWriterUpgrade> {
  upgrade = structuredClone(upgrade)
  const workers = parseReplicaWriterWorkers(incoming, upgrade.config.workspaceId)
  const key = scopeKey(upgrade.config)
  const state = await mutate(owner, current => {
    if (canonicalizeJson(current.writerUpgrades?.[key] ?? null) !== canonicalizeJson(upgrade)) throw new Error("Writer upgrade intent changed before Worker capture")
    writerUpgradeSelection(current, upgrade.config)
    const captured = new Map([...(upgrade.workers ?? []), ...workers].map(worker =>
      [canonicalizeJson([worker.origin, worker.definitionId, worker.executorPersonId, worker.integrationId]), worker]))
    const union = parseReplicaWriterWorkers([...captured.values()], upgrade.config.workspaceId)
    return { ...current, writerUpgrades: { ...current.writerUpgrades, [key]: { ...upgrade, workers: union } } }
  }, ensureIdentity)
  return structuredClone(state.writerUpgrades![key]!)
}

/** Retain the exact verified policy confirmation before refreshing any dependent Worker. */
export async function confirmReplicaWriterUpgrade(owner: string, upgrade: ReplicaWriterUpgrade, value: unknown,
  ensureIdentity: () => void = () => {}): Promise<ReplicaWriterUpgrade> {
  upgrade = structuredClone(upgrade)
  const capturedReceipt = structuredClone(value)
  ensureIdentity()
  const receipt = await verifyRustyWriterPolicyReceipt(capturedReceipt, upgrade.config, owner,
    Math.max(upgrade.config.policyRevision + 1, upgrade.confirmed?.payload.revision ?? 0))
  ensureIdentity()
  const key = scopeKey(upgrade.config)
  const state = await mutate(owner, current => {
    if (canonicalizeJson(current.writerUpgrades?.[key] ?? null) !== canonicalizeJson(upgrade)) throw new Error("Writer upgrade intent changed before confirmation")
    writerUpgradeSelection(current, upgrade.config)
    return { ...current, writerUpgrades: { ...current.writerUpgrades, [key]: { ...upgrade, confirmed: receipt } } }
  }, ensureIdentity)
  return structuredClone(state.writerUpgrades![key]!)
}

/** Caller has verified Rusty's signed floor-2 receipt. Publish new causal credentials and retained progress in one transaction. */
export async function completeReplicaWriterUpgrade(owner: string, upgrade: ReplicaWriterUpgrade, policyRevision: number,
  ensureIdentity: () => void = () => {}): Promise<BlindReplicaConfig> {
  upgrade = structuredClone(upgrade)
  const config = parseReplicaConfig(serialize(upgrade.config))
  if (!Number.isSafeInteger(policyRevision) || policyRevision <= config.policyRevision) throw new Error("Writer upgrade policy revision did not advance")
  const key = scopeKey(config)
  const state = await mutate(owner, current => {
    const pending = current.writerUpgrades?.[key]
    if (!pending || canonicalizeJson(pending) !== canonicalizeJson(upgrade)) throw new Error("Writer upgrade intent is no longer pending")
    const selected = writerUpgradeSelection(current, config)
    const progress = current.progress[key]
    if (policyRevision <= selected.policyRevision) throw new Error("Writer upgrade policy revision did not advance current credentials")
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
    delete next.writerUpgrades![key]
    if (!Object.keys(next.writerUpgrades!).length) delete next.writerUpgrades
    return next
  }, ensureIdentity)
  return effectiveReplicaConfigs(state).find(value => scopeKey(value) === key)!
}

/** Prepare a portable private-state merge against exact v2 and legacy bytes; never writes during planning. */
export async function planPrivateReplicaImport(owner: string, incoming: unknown): Promise<LocalStatePlan> {
  const snapshot = structuredClone(incoming)
  const wire = parsePrivateReplicaWire(snapshot)
  if (wire.personId !== owner) throw new Error("Private replica identity mismatch")

  const keys = [stateKey(owner), settingsKey(owner), preferenceKey(owner)]
  const [stateRaw, settingsRaw, preferencesRaw] = await Promise.all(keys.map(key => readLocal(key)))
  const state = stateRaw === null ? legacyRecordsFromRaw(owner, settingsRaw, preferencesRaw) : parseState(stateRaw, owner)
  const next = reconcileReplicaProgress(state, mergePrivateReplicaState(state, wire))
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
    conditions: [...keys.map((key, index) => ({ key, value: [stateRaw, settingsRaw, preferencesRaw][index] })),
      ...migrations.flatMap(plan => plan.conditions)],
    writes: [...(encoded === stateRaw ? [] : [{ key: stateKey(owner), value: encoded }]), ...migrations.flatMap(plan => plan.writes)],
  }
}

/** One transaction publishes cursor, acknowledgment and exact outbox under the current credential revision. */
export async function persistPrivateReplicaState(owner: string, config: PrivateReplicaConfig, expectedGeneration: number,
  incoming: ReplicaState<BlindObject>, ensureIdentity: () => void = () => {}) {
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
  }, ensureIdentity)
  return effectiveReplicaConfigs(updated)
}
