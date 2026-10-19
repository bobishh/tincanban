import { decodeBlindBytes, encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"

export type ReplicaContentKeys = {
  keyEpoch: number
  contentKey: string
  historicalContentKeys?: Record<string, string>
  historicalContentKeyVariants?: Record<string, string[]>
}

const maximumHistoricalKeys = 256
const maximumEpochCandidates = 32
const base64Url = /^[A-Za-z0-9_-]+$/

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function snapshotRecord(value: unknown): Record<string, unknown> {
  if (!plainRecord(value)) throw new Error("Invalid Rusty content-key history")
  for (const key of ["historicalContentKeys", "historicalContentKeyVariants"]) {
    if (value[key] !== undefined && !plainRecord(value[key])) throw new Error("Invalid Rusty content-key history")
  }
  let snapshot: unknown
  try { snapshot = structuredClone(value) } catch { throw new Error("Invalid Rusty content-key history") }
  if (!plainRecord(snapshot)) throw new Error("Invalid Rusty content-key history")
  return snapshot
}
function canonicalKey(value: unknown): string {
  if (typeof value !== "string" || !base64Url.test(value)) throw new Error("Invalid Rusty content key")
  try {
    const decoded = decodeBlindBytes(value)
    if (decoded.byteLength !== 32) throw new Error("Invalid Rusty content key length")
    return encodeBlindBytes(decoded)
  } catch { throw new Error("Invalid Rusty content key") }
}
function positiveSafeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
function historicalEpoch(value: string, activeEpoch: number): number {
  const epoch = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !positiveSafeEpoch(epoch) || String(epoch) !== value || epoch >= activeEpoch) throw new Error("Invalid historical Rusty key epoch")
  return epoch
}
function keyCandidates(value: unknown, contentKey: string): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > maximumEpochCandidates) throw new Error("Invalid historical key candidate count")
  const keys = value.map(canonicalKey).sort()
  if (new Set(keys).size !== keys.length || keys.includes(contentKey)) throw new Error("Duplicate historical Rusty key candidate")
  return keys
}
export function parseReplicaContentKeys(input: unknown): ReplicaContentKeys {
  const value = snapshotRecord(input)
  if (!positiveSafeEpoch(value.keyEpoch)) throw new Error("Invalid Rusty content-key epoch")
  const contentKey = canonicalKey(value.contentKey)
  const parsed: ReplicaContentKeys = { keyEpoch: value.keyEpoch, contentKey }
  const unique = value.historicalContentKeys === undefined ? {} : snapshotRecord(value.historicalContentKeys)
  const ambiguous = value.historicalContentKeyVariants === undefined ? {} : snapshotRecord(value.historicalContentKeyVariants)
  const historicalContentKeys: Record<string, string> = {}, historicalContentKeyVariants: Record<string, string[]> = {}
  let total = 0
  for (const epoch of Object.keys(unique).sort((a, b) => Number(a) - Number(b))) {
    historicalEpoch(epoch, parsed.keyEpoch)
    const key = canonicalKey(unique[epoch])
    if (key === contentKey) throw new Error("Historical Rusty content key duplicates the active key")
    historicalContentKeys[epoch] = key
    total++
  }
  for (const epoch of Object.keys(ambiguous).sort((a, b) => Number(a) - Number(b))) {
    historicalEpoch(epoch, parsed.keyEpoch)
    if (Object.hasOwn(unique, epoch)) throw new Error("Historical key epoch cannot be both unique and ambiguous")
    const keys = keyCandidates(ambiguous[epoch], contentKey)
    historicalContentKeyVariants[epoch] = keys
    total += keys.length
  }
  if (total > maximumHistoricalKeys) throw new Error("Rusty content-key history limit exceeded")
  if (Object.keys(historicalContentKeys).length) parsed.historicalContentKeys = historicalContentKeys
  if (Object.keys(historicalContentKeyVariants).length) parsed.historicalContentKeyVariants = historicalContentKeyVariants
  return parsed
}
export function contentKeysForEpoch(input: ReplicaContentKeys, epoch: number): string[] {
  const keys = parseReplicaContentKeys(input)
  if (positiveSafeEpoch(epoch)) {
    if (epoch === keys.keyEpoch) return [keys.contentKey]
    const unique = keys.historicalContentKeys?.[String(epoch)]
    if (unique !== undefined) return [unique]
    const candidates = keys.historicalContentKeyVariants?.[String(epoch)]
    if (candidates) return [...candidates]
  }
  throw new Error(`Update required: Rusty content key for epoch ${String(epoch)} is unavailable`)
}
export function contentKeyForEpoch(input: ReplicaContentKeys, epoch: number): string {
  const candidates = contentKeysForEpoch(input, epoch)
  if (candidates.length !== 1) throw new Error(`Ambiguous Rusty key epoch ${epoch}; use the authenticated candidate reader`)
  return candidates[0]!
}
/** The callback must perform authenticated decryption only; parse admitted plaintext after it succeeds. */
export async function openWithReplicaContentKeys<T>(input: ReplicaContentKeys, epoch: number,
  decrypt: (contentKey: string) => Promise<T>): Promise<T> {
  const candidates = contentKeysForEpoch(input, epoch)
  let failure: unknown
  for (const candidate of candidates) {
    try { return await decrypt(candidate) } catch (error) { failure = error }
  }
  throw failure
}
export function replicaContentKeyEntries(input: ReplicaContentKeys): Array<[number, string]> {
  const keys = parseReplicaContentKeys(input)
  return [[keys.keyEpoch, keys.contentKey], ...Object.entries(keys.historicalContentKeys ?? {}).map(([epoch, key]): [number, string] => [Number(epoch), key]),
    ...Object.entries(keys.historicalContentKeyVariants ?? {}).flatMap(([epoch, candidates]) => candidates.map((key): [number, string] => [Number(epoch), key]))]
}
/** Causal replacement retains every candidate needed by accepted or pending ciphertext, including same-epoch conflicts. */
export function assertRetainsReplicaContentKeys(previous: ReplicaContentKeys, next: ReplicaContentKeys): void {
  const before = parseReplicaContentKeys(previous), after = parseReplicaContentKeys(next)
  if (after.keyEpoch < before.keyEpoch) throw new Error("Rusty content-key epoch cannot move backwards")
  for (const [epoch, key] of replicaContentKeyEntries(before)) {
    let retained: string[] = []
    try { retained = contentKeysForEpoch(after, epoch) } catch { /* Missing candidates are reported as retention failures. */ }
    if (!retained.includes(key)) throw new Error(`Rusty credential update must retain every content-key candidate for epoch ${epoch}`)
  }
}
/** Derive a fresh active epoch; this is a proposal, never authority to resolve a credential conflict. */
export function mergeReplicaContentKeyVariants(inputs: readonly ReplicaContentKeys[], nextKey: string): ReplicaContentKeys {
  if (!inputs.length || inputs.length > 64) throw new Error("Invalid Rusty credential candidate count")
  const keys = inputs.map(parseReplicaContentKeys)
  const epoch = Math.max(...keys.map(value => value.keyEpoch))
  if (epoch === Number.MAX_SAFE_INTEGER) throw new Error("Rusty content-key epoch cannot safely advance")
  const contentKey = canonicalKey(nextKey), byEpoch = new Map<number, Set<string>>()
  for (const previous of keys) for (const [oldEpoch, key] of replicaContentKeyEntries(previous)) {
    if (key === contentKey) throw new Error("New Rusty content key must not reuse a retained key")
    const candidates = byEpoch.get(oldEpoch) ?? new Set<string>()
    candidates.add(key); byEpoch.set(oldEpoch, candidates)
  }
  const historicalContentKeys: Record<string, string> = {}, historicalContentKeyVariants: Record<string, string[]> = {}
  for (const [oldEpoch, candidates] of [...byEpoch].sort(([a], [b]) => a - b)) {
    const values = [...candidates].sort()
    if (values.length === 1) historicalContentKeys[String(oldEpoch)] = values[0]!
    else historicalContentKeyVariants[String(oldEpoch)] = values
  }
  return parseReplicaContentKeys({ keyEpoch: epoch + 1, contentKey, historicalContentKeys, historicalContentKeyVariants })
}
export function rotateReplicaContentKeys(current: ReplicaContentKeys, nextKey: string): ReplicaContentKeys {
  return mergeReplicaContentKeyVariants([current], nextKey)
}
