import { canonicalizeJson } from "../domain/identity"
import { compareAndSwapLocal,readLocal,type LocalStatePlan } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { parsePrivateReplicaConfig,parseReplicaConfig } from "./blindReplicaConfig"
import type { BlindReplicaConfig,PrivateReplicaConfig } from "./blindReplication"
import { parseReplicaState,type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { decodeBlindBytes,type BlindObject } from "./blindEnvelope"
import { privateReplicaBinding } from "./privateReplicaBinding"
import { parseRustyScopePolicyReceipt } from "./rustyScopePolicy"
import { parseReplicaWriterWorkers } from "./replicaWriterWorkersState"
import { replicaCredentialOriginCondition } from "./replicaCredentialFreezeState"
import {
effectivePrivateReplicaConfigs,effectiveReplicaConfigs,emptyPrivateReplicaState,mergePrivateReplicaState,
parsePrivateReplicaWire,portableReplicaState,updateReplicaProgress,
type PrivateReplicaState,type PrivateReplicaWire,type ReplicaWriterUpgrade
} from "./privateReplicaPreferences"

export const stateKey = (owner: string) => `tincanban.private-replica-state.v2.${owner}`
export const legacySnapshotKey = (owner: string) => `tincanban.private-replica-legacy-snapshot.v1.${owner}`
export const settingsKey = (owner: string) => `tincanban.blind-replicas.v1.${owner}`
export const preferenceKey = (owner: string) => `tincanban.device-replica-preferences.v1.${owner}`
export const scopeKey = (value: { origin: string; scopeId: string }) => `${value.origin}/${value.scopeId}`
type LegacyPreference = { origin: string; scopeId: string; changedAt: number; config: BlindReplicaConfig | null }
const legacyFingerprintCache = new Map<string, { settings: string | null; preferences: string | null; fingerprint: string }>()

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value as object) as object | null
  return prototype === Object.prototype || prototype === null
}

export function parseState(raw: string, owner: string): PrivateReplicaState {
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

export function assertNoWriterUpgrade(state: PrivateReplicaState, config: Pick<PrivateReplicaConfig, "origin" | "scopeId">): void {
  if (state.writerUpgrades?.[scopeKey(config)]) throw new Error("Rusty writer policy upgrade is pending; retry the upgrade before replication")
}

export function matchingConfig(state: PrivateReplicaState, config: PrivateReplicaConfig, allowUpgrade = false): PrivateReplicaConfig {
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

export function legacyRecordsFromRaw(owner: string, saved: string | null, preferences: string | null): PrivateReplicaState {
  const configs = parseLegacyConfigs(JSON.parse(saved ?? "[]"))
  const records = parseLegacyPreferences(JSON.parse(preferences ?? "[]"))
  return migrateLegacyRecords(owner, configs, records)
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
  const settings = configs.map(config => ({ origin: config.origin, scopeId: config.scopeId, changedAt: 1, config }))
  // Neither older store proves causality over the other. Preserve candidates without inventing timestamp precedence.
  for (const source of [settings, records]) state = mergePrivateReplicaState(state, legacyReplicaWire(owner, source))
  for (const effective of effectiveReplicaConfigs(state)) {
    const originals = configs.filter(config => scopeKey(config) === scopeKey(effective) &&
      canonicalizeJson(legacyPortableConfig(config)) === canonicalizeJson(legacyPortableConfig(effective)))
    if (!originals.length) continue
    const cursor = Math.min(...originals.map(config => config.cursor))
    const acknowledgments = new Set(originals.map(config => config.lastUploaded))
    state = updateReplicaProgress(state, { ...effective, cursor, lastUploaded: acknowledgments.size === 1 ? originals[0]!.lastUploaded : "" })
  }
  return { ...state, migrated: true }
}

export async function legacySourcesFingerprint(owner: string, settings: string | null, preferences: string | null): Promise<string> {
  const cached = legacyFingerprintCache.get(owner)
  if (cached?.settings === settings && cached.preferences === preferences) return cached.fingerprint
  const bytes = new TextEncoder().encode(JSON.stringify([settings, preferences]))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const fingerprint = `v1:${Array.from(digest, value => value.toString(16).padStart(2, "0")).join("")}`
  if (legacyFingerprintCache.size >= 64 && !legacyFingerprintCache.has(owner)) {
    const oldest = legacyFingerprintCache.keys().next().value
    if (oldest !== undefined) legacyFingerprintCache.delete(oldest)
  }
  legacyFingerprintCache.delete(owner)
  legacyFingerprintCache.set(owner, { settings, preferences, fingerprint })
  return fingerprint
}

export function mergeNovelLegacyRecords(state: PrivateReplicaState, owner: string, settings: string | null,
  preferences: string | null): PrivateReplicaState {
  const observed = portableReplicaState(legacyRecordsFromRaw(owner, settings, preferences))
  const known = new Map(state.entries.map(entry => [scopeKey(entry), new Set(entry.operations.map(operation =>
    canonicalizeJson([operation.purpose, operation.config])))]))
  const entries = observed.entries.flatMap(entry => {
    const existing = known.get(scopeKey(entry)) ?? new Set<string>()
    const operations = entry.operations.filter(operation => !existing.has(canonicalizeJson([operation.purpose, operation.config])))
    return operations.length ? [{ ...entry, operations }] : []
  })
  return entries.length ? mergePrivateReplicaState(state, { ...observed, entries }) : state
}

function legacyPortableConfig(config: BlindReplicaConfig): BlindReplicaConfig {
  const next = { ...config, cursor: 0, lastUploaded: "" }
  delete next.preferenceRevision
  return next
}

function legacyReplicaWire(owner: string, records: LegacyPreference[]): PrivateReplicaWire {
  const actorId = crypto.randomUUID()
  const entries = new Map<string, PrivateReplicaWire["entries"][number]>()
  let counter = 0
  let version: 3 | 4 | 5 = 3
  for (const record of records) {
    const key = scopeKey(record)
    const entry = entries.get(key) ?? { origin: record.origin, scopeId: record.scopeId, operations: [] }
    const config = record.config ? legacyPortableConfig(record.config) : null
    if (entry.operations.some(operation => canonicalizeJson(operation.config) === canonicalizeJson(config))) continue
    counter++
    entry.operations.push({ dot: { actorId, counter }, context: {}, purpose: "workspace", config })
    if (config?.historicalContentKeyVariants) version = 5
    else if (config?.historicalContentKeys && version !== 5) version = 4
    entries.set(key, entry)
  }
  return { version, personId: owner, clock: counter ? { [actorId]: counter } : {}, entries: [...entries.values()] }
}

export function serialize(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error("Invalid private replica value")
  return text
}

export function changedCredentialOrigins(previous: PrivateReplicaWire["entries"], next: PrivateReplicaWire["entries"]): string[] {
  const before = new Map(previous.map(entry => [scopeKey(entry), canonicalizeJson(entry)]))
  const after = new Map(next.map(entry => [scopeKey(entry), canonicalizeJson(entry)]))
  return [...new Set([...previous, ...next].filter(entry => before.get(scopeKey(entry)) !== after.get(scopeKey(entry)))
    .map(entry => entry.origin))]
}

export async function mutate(owner: string, change: (current: PrivateReplicaState) => PrivateReplicaState,
  ensureIdentity: () => void = () => {}, preconditions: LocalStatePlan["conditions"] = []): Promise<PrivateReplicaState> {
  if (!owner || owner.length > 128) throw new Error("Invalid private replica identity")
  return withLocalStateWriteLock(stateKey(owner), async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      ensureIdentity()
      const key = stateKey(owner)
      const raw = await readLocal(key)
      const previousEntries = raw === null ? [] : parsePrivateReplicaWire(JSON.parse(raw)).entries
      const conditions: LocalStatePlan["conditions"] = [{ key, value: raw }, ...preconditions]
      const settingsId = settingsKey(owner), preferencesId = preferenceKey(owner), snapshotId = legacySnapshotKey(owner)
      const [settings, preferences, previousSnapshot] = await Promise.all([readLocal(settingsId), readLocal(preferencesId), readLocal(snapshotId)])
      const snapshot = await legacySourcesFingerprint(owner, settings, preferences)
      conditions.push({ key: settingsId, value: settings }, { key: preferencesId, value: preferences },
        { key: snapshotId, value: previousSnapshot })
      let current: PrivateReplicaState
      if (raw === null) {
        current = legacyRecordsFromRaw(owner, settings, preferences)
      } else {
        current = parseState(raw, owner)
        if (snapshot !== previousSnapshot) current = mergeNovelLegacyRecords(current, owner, settings, preferences)
      }
      ensureIdentity()
      const next = change(current)
      const encoded = JSON.stringify(next)
      parseState(encoded, owner)
      const freezes = await Promise.all(changedCredentialOrigins(previousEntries, next.entries)
        .map(origin => replicaCredentialOriginCondition(owner, origin)))
      conditions.push(...freezes)
      ensureIdentity()
      const writes: LocalStatePlan["writes"] = encoded === raw ? [] : [{ key, value: encoded }]
      if (snapshot !== previousSnapshot) writes.push({ key: snapshotId, value: snapshot })
      if (await compareAndSwapLocal({ conditions, writes }, ensureIdentity)) return parseState(encoded, owner)
    }
    throw new Error("Private replica state changed repeatedly; retry required")
  })
}

export async function read(owner: string): Promise<PrivateReplicaState> {
  const raw = await readLocal(stateKey(owner))
  if (!raw) return mutate(owner, state => state)
  const [settings, preferences, previousSnapshot] = await Promise.all([
    readLocal(settingsKey(owner)), readLocal(preferenceKey(owner)), readLocal(legacySnapshotKey(owner)),
  ])
  if (await legacySourcesFingerprint(owner, settings, preferences) !== previousSnapshot) return mutate(owner, state => state)
  const parsed = parseState(raw, owner)
  return JSON.stringify(parsed) === raw ? parsed : mutate(owner, state => state)
}
