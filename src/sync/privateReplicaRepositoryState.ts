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
effectivePrivateReplicaConfigs,emptyPrivateReplicaState,
parsePrivateReplicaWire,
type PrivateReplicaState,type PrivateReplicaWire,type ReplicaWriterUpgrade
} from "./privateReplicaPreferences"

export const stateKey = (owner: string) => `tincanban.private-replica-state.v2.${owner}`
export const scopeKey = (value: { origin: string; scopeId: string }) => `${value.origin}/${value.scopeId}`
const retiredReplicaPrefixes = ["tincanban.blind-replicas.v1.", "tincanban.device-replica-preferences.v1.",
  "tincanban.private-replica-legacy-snapshot.v1."]
const cleanedOwners = new Set<string>()

/** Retired records are deletion targets only, never input or transaction dependencies. */
async function discardRetiredRecords(owner: string, raw: string): Promise<void> {
  if (cleanedOwners.has(owner)) return
  if (await compareAndSwapLocal({ conditions: [{ key: stateKey(owner), value: raw }],
    writes: retiredReplicaPrefixes.map(prefix => ({ key: prefix + owner, value: null })) })) cleanedOwners.add(owner)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value as object) as object | null
  return prototype === Object.prototype || prototype === null
}

export function parseState(raw: string, owner: string): PrivateReplicaState {
  const value = JSON.parse(raw) as PrivateReplicaState
  const wire = parsePrivateReplicaWire(value)
  if (wire.personId !== owner || typeof value.actorId !== "string" || !value.progress || typeof value.progress !== "object" ||
    Array.isArray(value.progress)) throw new Error("Invalid private replica repository")
  const progress = validateProgress(value.progress, wire.entries)
  const state = { ...emptyPrivateReplicaState(owner, value.actorId), ...wire, progress }
  if (value.writerUpgrades !== undefined) state.writerUpgrades = parseWriterUpgrades(value.writerUpgrades, wire.entries)
  for (const config of effectivePrivateReplicaConfigs(state)) parsePrivateReplicaConfig(JSON.stringify(config), owner)
  validateReplicaBindings(state, owner)
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
  if (!isPlainRecord(raw) || Object.keys(raw).some(field => !["id", "config", "confirmed", "workers", "localActivated"].includes(field)) || typeof raw.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id)) throw new Error("Invalid writer upgrade intent")
  const config = parseReplicaConfig(serialize(raw.config))
  if (config.minimumWriterVersion !== undefined || config.removalPending || !config.preferenceRevision) throw new Error("Invalid writer upgrade intent scope")
  const confirmed = parseWriterUpgradeConfirmation(raw.confirmed, config)
  const workers = raw.workers === undefined ? undefined : parseReplicaWriterWorkers(raw.workers, config.workspaceId)
  if (raw.localActivated !== undefined && (raw.localActivated !== true || !confirmed)) throw new Error("Invalid locally activated writer policy")
  return { id: raw.id, config, ...(confirmed ? { confirmed } : {}), ...(workers ? { workers } : {}),
    ...(raw.localActivated === true ? { localActivated: true as const } : {}) }
}

function parseWriterUpgradeConfirmation(value: unknown, config: BlindReplicaConfig) {
  if (value === undefined) return undefined
  const receipt = parseRustyScopePolicyReceipt(value)
  const payload = receipt.payload
  if (payload.scopeId !== config.scopeId || payload.minimumWriterVersion !== 2 || payload.revoked ||
    payload.revision < config.policyRevision) throw new Error("Invalid confirmed writer upgrade intent")
  return receipt
}

function validateReplicaBindings(state: PrivateReplicaState, owner: string): void {
  for (const config of effectivePrivateReplicaConfigs(state)) {
    const progress = state.progress[scopeKey(config)]
    if (progress?.replication && progress.revision === config.preferenceRevision) {
      parseReplicaState<BlindObject>(progress.replication, privateReplicaBinding(owner, config))
    }
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
  const upgrade = state.writerUpgrades?.[scopeKey(config)]
  if (!allowUpgrade && !upgrade?.localActivated) assertNoWriterUpgrade(state, config)
  const normalized = parsePrivateReplicaConfig(JSON.stringify(config), state.personId)
  const selected = effectivePrivateReplicaConfigs(state).find(value => scopeKey(value) === scopeKey(normalized) &&
    (value.purpose ?? "workspace") === (normalized.purpose ?? "workspace"))
  if (!selected || privateReplicaBinding(state.personId, selected) !== privateReplicaBinding(state.personId, normalized)) {
    throw new Error("Rusty credential revision changed during replication")
  }
  if (!allowUpgrade && upgrade?.localActivated && (selected.purpose === "identity" || selected.minimumWriterVersion !== 2 ||
    !upgrade.confirmed || selected.policyRevision < upgrade.confirmed.payload.revision)) throw new Error("Locally activated writer policy no longer matches storage")
  return selected
}

function isProgressRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192 &&
    value.split("|").every(part => /^[A-Za-z0-9:_-]{1,128}:[1-9]\d*$/.test(part))
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
      const key = stateKey(owner), raw = await readLocal(key)
      const current = raw === null ? emptyPrivateReplicaState(owner, crypto.randomUUID()) : parseState(raw, owner)
      const previousEntries = structuredClone(current.entries)
      const next = change(current)
      const encoded = JSON.stringify(next)
      parseState(encoded, owner)
      const freezes = await Promise.all(changedCredentialOrigins(previousEntries, next.entries)
        .map(origin => replicaCredentialOriginCondition(owner, origin)))
      ensureIdentity()
      if (await compareAndSwapLocal({ conditions: [{ key, value: raw }, ...preconditions, ...freezes],
        writes: encoded === raw ? [] : [{ key, value: encoded }] }, ensureIdentity)) {
        await discardRetiredRecords(owner, encoded)
        return parseState(encoded, owner)
      }
    }
    throw new Error("Private replica state changed repeatedly; retry required")
  })
}

export async function read(owner: string): Promise<PrivateReplicaState> {
  const raw = await readLocal(stateKey(owner))
  if (!raw) return mutate(owner, state => state)
  const parsed = parseState(raw, owner)
  await discardRetiredRecords(owner, raw)
  return parsed
}
