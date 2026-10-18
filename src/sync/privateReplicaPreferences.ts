import { canonicalizeJson } from "../domain/identity"
import { parsePrivateReplicaConfig } from "./blindReplicaConfig"
import type { BlindReplicaConfig, PrivateReplicaConfig } from "./blindReplication"
import { blindOrigin } from "./blindOrigin"
import type { ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import type { BlindObject } from "./blindEnvelope"
import type { RustyScopePolicyReceipt } from "./rustyScopePolicy"
import type { ReplicaWriterWorker } from "./replicaWriterWorkersState"
import { assertRetainsReplicaContentKeys } from "./replicaContentKeys"

type Clock = Record<string, number>
type Dot = { actorId: string; counter: number }
type ReplicaPurpose = "workspace" | "identity"
type Operation = { dot: Dot; context: Clock; purpose: ReplicaPurpose; config: PrivateReplicaConfig | null }
type Entry = { origin: string; scopeId: string; operations: Operation[] }
type Progress = { revision: string; cursor: number; lastUploaded: string; replication?: ReplicaState<BlindObject> }
export type PrivateReplicaWire = { version: 3 | 4 | 5; personId: string; clock: Clock; entries: Entry[] }
export type ReplicaWriterUpgrade = { id: string; config: BlindReplicaConfig; confirmed?: RustyScopePolicyReceipt; workers?: ReplicaWriterWorker[];
  localActivated?: true }
export type PrivateReplicaState = PrivateReplicaWire & { actorId: string; progress: Record<string, Progress>;
  writerUpgrades?: Record<string, ReplicaWriterUpgrade> }
const entryKey = (entry: Pick<Entry, "origin" | "scopeId">) => `${entry.origin}/${entry.scopeId}`
const dotKey = (dot: Dot) => `${dot.actorId}:${dot.counter}`
const copy = <T>(value: T): T => structuredClone(value)

function portableConfig(config: PrivateReplicaConfig, expectedPersonId?: string): PrivateReplicaConfig {
  const value = { ...parsePrivateReplicaConfig(JSON.stringify(config), expectedPersonId) }
  delete value.preferenceRevision
  return { ...value, cursor: 0, lastUploaded: "" }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value as object) as object | null
  return prototype === Object.prototype || prototype === null
}

function validateActor(actorId: unknown): asserts actorId is string {
  if (typeof actorId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(actorId) ||
    ["__proto__", "constructor", "prototype"].includes(actorId)) throw new Error("Invalid private-state actor")
}

function validatePerson(personId: unknown): asserts personId is string {
  if (typeof personId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(personId) ||
    ["__proto__", "constructor", "prototype"].includes(personId)) throw new Error("Invalid private-state person")
}

function validateClock(value: unknown): Clock {
  if (!isPlainRecord(value) || Object.keys(value).length > 256) throw new Error("Invalid private-state clock")
  const clock = value as Clock
  for (const [actor, counter] of Object.entries(clock)) {
    validateActor(actor)
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid private-state counter")
  }
  return Object.fromEntries(Object.entries(clock).sort(([a], [b]) => a.localeCompare(b)))
}

export function emptyPrivateReplicaState(personId: string, actorId: string): PrivateReplicaState {
  validateActor(actorId)
  validatePerson(personId)
  return { version: 3, personId, actorId, clock: {}, entries: [], progress: {} }
}

export function parsePrivateReplicaWire(value: unknown): PrivateReplicaWire {
  const wire = isPlainRecord(value) ? value : undefined
  if (!wire || (wire.version !== 3 && wire.version !== 4 && wire.version !== 5) || !Array.isArray(wire.entries) || wire.entries.length > 128) {
    throw new Error("Invalid private replica state")
  }
  validatePerson(wire.personId)
  const version = wire.version
  const clock = validateClock(wire.clock)
  const dotEntries = new Map<string, string>()
  const rawEntries = (wire.entries as unknown[]).map(value => parseWireEntry(value, clock, dotEntries, wire.personId as string, version >= 4, version >= 5))
  validateCausalOperations(rawEntries.flatMap(entry => entry.operations))
  for (const entry of rawEntries) validateCausalContentKeys(entry.operations)
  const entries = rawEntries.map(entry => ({ ...entry, operations: maximalOperations(entry.operations) }))
  if (new Set(entries.map(entryKey)).size !== entries.length) throw new Error("Duplicate private replica scope")
  return { version: wire.version === 5 ? 5 : wire.version === 4 ? 4 : 3, personId: wire.personId, clock, entries: entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b))) }
}

function parseWireEntry(value: unknown, clock: Clock, dotEntries: Map<string, string>, personId: string, keyHistory: boolean, keyVariants: boolean): Entry {
  if (!isPlainRecord(value) || typeof value.origin !== "string" || typeof value.scopeId !== "string" ||
    !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 32) {
    throw new Error("Invalid private replica entry")
  }
  const entry = { origin: value.origin, scopeId: value.scopeId }
  if (blindOrigin(entry.origin) !== entry.origin || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.scopeId)) {
    throw new Error("Invalid private replica scope")
  }
  return { ...entry, operations: (value.operations as unknown[]).map(operation => parseWireOperation(operation, entry, clock, dotEntries, personId, keyHistory, keyVariants)) }
}

function parseWireOperation(value: unknown, entry: Pick<Entry, "origin" | "scopeId">, clock: Clock,
  dotEntries: Map<string, string>, personId: string, keyHistory: boolean, keyVariants: boolean): Operation {
  const operation = wireOperationRecord(value)
  const purpose = parseOperationPurpose(operation)
  const dot = parseOperationDot(operation.dot)
  const context = validateClock(operation.context)
  validateCausalRevision(dot, context, clock)
  const config = parseOperationConfig(operation.config, purpose, entry, personId, keyHistory, keyVariants)
  const revisionKey = dotKey(dot)
  const owner = dotEntries.get(revisionKey)
  if (owner && owner !== entryKey(entry)) throw new Error("Duplicate private-state dot across scopes")
  dotEntries.set(revisionKey, entryKey(entry))
  return { dot, context, purpose, config }
}

function parseOperationPurpose(operation: Record<string, unknown>): ReplicaPurpose {
  const purpose = operation.purpose
  if (purpose !== "workspace" && purpose !== "identity") throw new Error("Invalid private replica purpose")
  return purpose
}

function parseOperationConfig(value: unknown, purpose: ReplicaPurpose, entry: Pick<Entry, "origin" | "scopeId">,
  personId: string, keyHistory: boolean, keyVariants: boolean): PrivateReplicaConfig | null {
  if (value === null) return null
  if (!keyVariants && isPlainRecord(value) && Object.hasOwn(value, "historicalContentKeyVariants")) {
    throw new Error("Ambiguous private key history requires wire version 5; upgrade the required schema")
  }
  if (!keyHistory && isPlainRecord(value) && Object.hasOwn(value, "historicalContentKeys")) {
    throw new Error("Private key history requires wire version 4; upgrade the required schema")
  }
  const config = portableConfig(parsePrivateReplicaConfig(serialize(value), personId), personId)
  if (config.purpose !== purpose) throw new Error("Private replica purpose does not match its operation")
  if (entryKey(config) !== entryKey(entry)) throw new Error("Private replica scope mismatch")
  return config
}

function wireOperationRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.keys(value).some(key => !["dot", "context", "config", "purpose"].includes(key))) {
    throw new Error("Invalid private replica operation")
  }
  return value
}

function parseOperationDot(value: unknown): Dot {
  if (!isPlainRecord(value) || Object.keys(value).some(key => !["actorId", "counter"].includes(key))) {
    throw new Error("Invalid private replica operation dot")
  }
  validateActor(value.actorId)
  if (typeof value.counter !== "number" || !Number.isSafeInteger(value.counter) || value.counter < 1) {
    throw new Error("Invalid private replica operation dot")
  }
  return { actorId: value.actorId, counter: value.counter }
}

function validateCausalRevision(dot: Dot, context: Clock, clock: Clock): void {
  if ((context[dot.actorId] ?? 0) >= dot.counter || (clock[dot.actorId] ?? 0) < dot.counter ||
    Object.entries(context).some(([actor, count]) => (clock[actor] ?? 0) < count)) {
    throw new Error("Invalid private replica causal revision")
  }
}

function maximalOperations(operations: Operation[]): Operation[] {
  const values = new Map<string, Operation>()
  for (const operation of operations) {
    const previous = values.get(dotKey(operation.dot))
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(operation)) throw new Error("Conflicting private-state dot equivocation")
    values.set(dotKey(operation.dot), operation)
  }
  const all = [...values.values()]
  const maximal = all.filter(operation => !all.some(other => (other.context[operation.dot.actorId] ?? 0) >= operation.dot.counter))
    .sort((a, b) => dotKey(a.dot).localeCompare(dotKey(b.dot)))
  if (all.length && !maximal.length) throw new Error("Invalid cyclic private-state context")
  if (maximal.length > 32) throw new Error("Too many concurrent private replica operations")
  return maximal
}

function validateCausalOperations(operations: Operation[]): void {
  const byDot = new Map(operations.map(operation => [dotKey(operation.dot), operation]))
  const byActor = new Map<string, Operation[]>()
  for (const operation of operations) byActor.set(operation.dot.actorId,
    [...(byActor.get(operation.dot.actorId) ?? []), operation])
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("Invalid cyclic private-state context")
    if (visited.has(key)) return
    visiting.add(key)
    const operation = byDot.get(key)!
    for (const [actor, counter] of Object.entries(operation.context)) {
      for (const dependency of byActor.get(actor) ?? []) {
        if (dependency.dot.counter <= counter) {
          visit(dotKey(dependency.dot))
          assertTransitiveContext(operation.context, dependency.context)
        }
      }
    }
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of byDot.keys()) visit(key)
}

function assertTransitiveContext(context: Clock, dependencyContext: Clock): void {
  for (const [actor, counter] of Object.entries(dependencyContext)) {
    if ((context[actor] ?? 0) < counter) throw new Error("Contradictory private-state causal context")
  }
}

function validateUniqueDots(entries: Entry[]): void {
  const owners = new Map<string, string>()
  for (const entry of entries) for (const operation of entry.operations) {
    const key = dotKey(operation.dot)
    const owner = owners.get(key)
    if (owner && owner !== entryKey(entry)) throw new Error("Duplicate private-state dot across scopes")
    owners.set(key, entryKey(entry))
  }
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error("Invalid private replica value")
  return text
}

export function portableReplicaState(state: PrivateReplicaState): PrivateReplicaWire {
  return parsePrivateReplicaWire(copy({ version: state.version, personId: state.personId, clock: state.clock, entries: state.entries }))
}

export function mergePrivateReplicaState(state: PrivateReplicaState, incoming: unknown): PrivateReplicaState {
  const wire = parsePrivateReplicaWire(incoming)
  if (wire.personId !== state.personId) throw new Error("Private replica identity mismatch")
  const next = copy(state)
  next.version = Math.max(next.version, wire.version) as PrivateReplicaWire["version"]
  for (const [actor, counter] of Object.entries(wire.clock)) next.clock[actor] = Math.max(counter, next.clock[actor] ?? 0)
  const entries = new Map(next.entries.map(entry => [entryKey(entry), entry]))
  for (const entry of wire.entries) {
    const previous = entries.get(entryKey(entry))
    entries.set(entryKey(entry), { ...entry, operations: [...(previous?.operations ?? []), ...entry.operations] })
  }
  if (entries.size > 128) throw new Error("Too many private replica scopes")
  const combined = [...entries.values()]
  validateUniqueDots(combined)
  validateCausalOperations(combined.flatMap(entry => entry.operations))
  for (const entry of combined) validateCausalContentKeys(entry.operations)
  next.entries = combined.map(entry => ({ ...entry, operations: maximalOperations(entry.operations) }))
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
  validateUniqueDots(next.entries)
  validateCausalOperations(next.entries.flatMap(entry => entry.operations))
  next.clock = validateClock(next.clock)
  return next
}

function selectedConfig(entry: Entry): PrivateReplicaConfig | undefined {
  if (entry.operations.some(operation => operation.config === null)) return
  const configs = entry.operations.map(operation => operation.config!)
  // Policy revisions and the writer floor advance independently on enrolled devices.
  // They do not rotate keys. Preserve causal evidence while joining only these monotonic fields.
  const credentials = configs.map(config => {
    const { policyRevision, ...value } = config
    void policyRevision
    if (value.purpose !== "identity") delete value.minimumWriterVersion
    return canonicalizeJson(value)
  })
  if (new Set(credentials).size !== 1) return
  const selected = { ...configs[0]!, policyRevision: Math.max(...configs.map(config => config.policyRevision)) }
  if (selected.purpose !== "identity" && configs.some(config => config.purpose !== "identity" && config.minimumWriterVersion === 2)) {
    selected.minimumWriterVersion = 2
  }
  return selected
}

function assertRetainedResourceKeys(previous: PrivateReplicaConfig, next: PrivateReplicaConfig): void {
  const subject = (config: PrivateReplicaConfig) => config.purpose === "identity" ? config.personId : config.workspaceId
  if (previous.origin === next.origin && previous.scopeId === next.scopeId && previous.purpose === next.purpose &&
    subject(previous) === subject(next) && previous.servicePublicKey === next.servicePublicKey) {
    assertRetainsReplicaContentKeys(previous, next)
  }
}

function validateCausalContentKeys(operations: Operation[]): void {
  for (const next of operations) {
    if (!next.config) continue
    for (const previous of operations) {
      if (previous.config && (next.context[previous.dot.actorId] ?? 0) >= previous.dot.counter) {
        assertRetainedResourceKeys(previous.config, next.config)
      }
    }
  }
}

function entryRevision(entry: Entry): string { return entry.operations.map(operation => dotKey(operation.dot)).sort().join("|") }

export function replicaPreferenceConflicts(state: PrivateReplicaState): Array<{ origin: string; scopeId: string }> {
  return state.entries.filter(entry => new Set(entry.operations.map(operation => operation.purpose)).size > 1 ||
    (!entry.operations.some(operation => operation.config === null) && !selectedConfig(entry)))
    .map(({ origin, scopeId }) => ({ origin, scopeId }))
}

export function effectivePrivateReplicaConfigs(state: PrivateReplicaState): PrivateReplicaConfig[] {
  return state.entries.flatMap(entry => {
    const config = selectedConfig(entry)
    if (!config) return []
    const preferenceRevision = entryRevision(entry)
    const progress = state.progress[entryKey(entry)]
    return [{ ...copy(config), preferenceRevision, ...(progress?.revision === preferenceRevision
      ? { cursor: progress.cursor, lastUploaded: progress.lastUploaded } : { cursor: 0, lastUploaded: "" }) }]
  })
}

export function effectiveReplicaConfigs(state: PrivateReplicaState): BlindReplicaConfig[] {
  return effectivePrivateReplicaConfigs(state).filter((config): config is BlindReplicaConfig => config.purpose === "workspace")
}

export function effectiveIdentityReplicaConfigs(state: PrivateReplicaState, personId: string): Extract<PrivateReplicaConfig, { purpose: "identity" }>[] {
  return effectivePrivateReplicaConfigs(state).filter((config): config is Extract<PrivateReplicaConfig, { purpose: "identity" }> =>
    config.purpose === "identity" && config.personId === personId)
}

export function changeReplicaPreference(state: PrivateReplicaState, config: PrivateReplicaConfig, removed = false): PrivateReplicaState {
  const portable = portableConfig(config, state.personId)
  const purpose = portable.purpose ?? "workspace"
  return applyPreferenceOperation(state, portable, removed ? null : portable, purpose)
}

function assertPreviousKeysRetained(previous: Entry | undefined, config: PrivateReplicaConfig | null): void {
  if (!config) return
  for (const operation of previous?.operations ?? []) {
    if (operation.config) assertRetainedResourceKeys(operation.config, config)
  }
}

function samePreference(previous: Entry, config: PrivateReplicaConfig | null, purpose: ReplicaPurpose): boolean {
  return config === null ? previous.operations.every(operation => operation.config === null && operation.purpose === purpose)
    : canonicalizeJson(selectedConfig(previous)) === canonicalizeJson(config)
}

function applyPreferenceOperation(state: PrivateReplicaState, portable: Pick<Entry, "origin" | "scopeId">,
  config: PrivateReplicaConfig | null, purpose: ReplicaPurpose): PrivateReplicaState {
  const previous = state.entries.find(entry => entryKey(entry) === entryKey(portable))
  assertPreviousKeysRetained(previous, config)
  if (previous && samePreference(previous, config, purpose)) return copy(state)
  const next = copy(state)
  const counter = (next.clock[next.actorId] ?? 0) + 1
  if (!Number.isSafeInteger(counter)) throw new Error("Private replica revision is exhausted")
  const operation = { dot: { actorId: next.actorId, counter }, context: copy(next.clock), purpose, config }
  if (config?.historicalContentKeyVariants) next.version = 5
  else if (config?.historicalContentKeys && next.version < 4) next.version = 4
  next.clock[next.actorId] = counter
  next.entries = [...next.entries.filter(entry => entryKey(entry) !== entryKey(portable)),
    { origin: portable.origin, scopeId: portable.scopeId, operations: [operation] }].sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
  if (next.entries.length > 128) throw new Error("Too many private replica scopes")
  delete next.progress[entryKey(portable)]
  return next
}

export function updateReplicaProgress(state: PrivateReplicaState, config: PrivateReplicaConfig): PrivateReplicaState {
  const normalized = portableConfig(config, state.personId)
  const selected = effectivePrivateReplicaConfigs(state).find(value => entryKey(value) === entryKey(normalized))
  if (!selected || config.preferenceRevision !== selected.preferenceRevision ||
    canonicalizeJson(portableConfig(selected, state.personId)) !== canonicalizeJson(normalized)) throw new Error("Rusty credential revision changed during replication")
  const checked = parsePrivateReplicaConfig(JSON.stringify(config), state.personId)
  const next = copy(state)
  const previous = state.progress[entryKey(normalized)]
  const replication = previous?.replication
  if (replication?.pending && checked.lastUploaded !== previous.lastUploaded) throw new Error("Pending Rusty upload must be confirmed before replacing progress")
  next.progress[entryKey(normalized)] = { revision: selected.preferenceRevision!, cursor: checked.cursor, lastUploaded: checked.lastUploaded,
    ...(replication ? { replication: { ...replication, generation: replication.generation + 1,
      cursor: checked.cursor, lastUploaded: checked.lastUploaded,
      uploadedRevision: checked.lastUploaded === previous.lastUploaded ? replication.uploadedRevision : undefined } } : {}) }
  return next
}
