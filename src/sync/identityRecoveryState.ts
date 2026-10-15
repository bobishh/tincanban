import type { IdentityRecoveryEnvelope } from "@meta-uber/mesh-identity"
import { sha256 } from "@noble/hashes/sha2.js"
import { readLocal, updateLocal } from "../localDb"

const legacyKey = "tincanban.identity_recovery.v1"
const keyPrefix = "tincanban.identity-recovery-evidence.v1."
const recordVersion = 1
const maxEnvelopeCount = 32
const maxRecordBytes = 256 * 1024
const maxEnvelopeBytes = 8 * 1024

type RecoveryRecord = {
  version: 1
  personId: string
  envelopes: IdentityRecoveryEnvelope[]
}

export type IdentityRecoveryImportPlan = {
  conditions: Array<{ key: string; value: string | null }>
  writes: Array<{ key: string; value: string | null }>
}

const recordKey = (personId: string) => `${keyPrefix}${personId}`

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function decodeCanonicalBase64Url(value: unknown, expectedBytes: number, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid recovery ${label}`)
  let decoded: Uint8Array
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4))
    decoded = Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new Error(`Invalid recovery ${label}`)
  }
  const canonical = btoa(String.fromCharCode(...decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
  if (decoded.byteLength !== expectedBytes || canonical !== value) throw new Error(`Invalid recovery ${label}`)
  return decoded
}

function validatePersonId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid recovery person ID")
  decodeCanonicalBase64Url(value, 32, "person ID")
}

function validateEnvelopeParameters(kdf: unknown, cipher: unknown): { kdf: Record<string, unknown>; cipher: Record<string, unknown> } {
  if (!isObject(kdf) || !hasExactKeys(kdf, ["name", "hash", "iterations", "salt"]) ||
    kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || kdf.iterations !== 600_000 ||
    !isObject(cipher) || !hasExactKeys(cipher, ["name", "iv"]) || cipher.name !== "AES-GCM") {
    throw new Error("Invalid recovery envelope parameters")
  }
  decodeCanonicalBase64Url(kdf.salt, 16, "salt")
  decodeCanonicalBase64Url(cipher.iv, 12, "IV")
  return { kdf, cipher }
}

function validateEnvelope(value: unknown, personId: string): IdentityRecoveryEnvelope {
  if (!isObject(value) || !hasExactKeys(value, ["kind", "version", "personId", "security", "kdf", "cipher", "ciphertext"])) {
    throw new Error("Invalid recovery envelope")
  }
  if (value.kind !== "mesh-identity-recovery" || value.version !== 3 || value.personId !== personId ||
    !["legacy", "better", "insane"].includes(String(value.security))) throw new Error("Invalid recovery envelope")
  const kdf = value.kdf
  const cipher = value.cipher
  const parameters = validateEnvelopeParameters(kdf, cipher)
  decodeCanonicalBase64Url(value.ciphertext, 48, "ciphertext")
  const envelope = {
    kind: "mesh-identity-recovery" as const,
    version: 3 as const,
    personId,
    security: value.security as IdentityRecoveryEnvelope["security"],
    kdf: { name: "PBKDF2" as const, hash: "SHA-256" as const, iterations: 600_000 as const, salt: parameters.kdf.salt as string },
    cipher: { name: "AES-GCM" as const, iv: parameters.cipher.iv as string },
    ciphertext: value.ciphertext as string,
  }
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > maxEnvelopeBytes) throw new Error("Recovery envelope is too large")
  return envelope
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

function envelopeId(envelope: IdentityRecoveryEnvelope): string {
  return [...sha256(new TextEncoder().encode(stableJson(envelope)))].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function mergeEnvelopes(personId: string, ...groups: IdentityRecoveryEnvelope[][]): IdentityRecoveryEnvelope[] {
  const unique = new Map<string, IdentityRecoveryEnvelope>()
  for (const envelope of groups.flat()) unique.set(envelopeId(envelope), envelope)
  const ordered = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, envelope]) => envelope)
  if (ordered.length > maxEnvelopeCount) throw new Error("Too many recovery envelopes")
  const record = { version: recordVersion, personId, envelopes: ordered }
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > maxRecordBytes) throw new Error("Recovery evidence is too large")
  return ordered
}

function parseStoredRecord(raw: string | null, personId: string): IdentityRecoveryEnvelope[] {
  if (raw === null) return []
  const value: unknown = JSON.parse(raw)
  if (!isObject(value) || !hasExactKeys(value, ["version", "personId", "envelopes"]) || value.version !== recordVersion ||
    value.personId !== personId || !Array.isArray(value.envelopes)) throw new Error("Stored recovery evidence is invalid")
  if (new TextEncoder().encode(raw).byteLength > maxRecordBytes || value.envelopes.length > maxEnvelopeCount) {
    throw new Error("Stored recovery evidence exceeds limits")
  }
  return value.envelopes.map(envelope => validateEnvelope(envelope, personId))
}

function matchingLegacyEnvelope(raw: string | null, personId: string): IdentityRecoveryEnvelope[] {
  if (raw === null) return []
  const value: unknown = JSON.parse(raw)
  if (!isObject(value)) throw new Error("Stored older-format recovery evidence is invalid")
  if (value.personId !== personId) return []
  return [validateEnvelope(value, personId)]
}

function parseBundle(value: unknown, expectedPersonId: string): IdentityRecoveryEnvelope[] {
  if (!isObject(value) || !hasExactKeys(value, ["personId", "envelopes"]) || value.personId !== expectedPersonId ||
    !Array.isArray(value.envelopes)) throw new Error("Invalid recovery evidence bundle")
  validatePersonId(value.personId)
  if (value.envelopes.length > maxEnvelopeCount) throw new Error("Too many recovery envelopes")
  return value.envelopes.map(envelope => validateEnvelope(envelope, expectedPersonId))
}

export function validateIdentityRecoveryEvidence(personId: string, input: unknown): IdentityRecoveryEnvelope[] {
  validatePersonId(personId)
  return structuredClone(parseBundle(structuredClone(input), personId))
}

export async function planIdentityRecoveryImport(personId: string, input: unknown): Promise<IdentityRecoveryImportPlan> {
  validatePersonId(personId)
  // Clone and validate before any storage read or other asynchronous boundary.
  const incoming = validateIdentityRecoveryEvidence(personId, structuredClone(input))
  const stateKey = recordKey(personId)
  const [stateRaw, legacyRaw] = await Promise.all([readLocal(stateKey), readLocal(legacyKey)])
  const existing = parseStoredRecord(stateRaw, personId)
  const legacy = matchingLegacyEnvelope(legacyRaw, personId)
  const envelopes = mergeEnvelopes(personId, existing, legacy, incoming)
  const serialized = JSON.stringify({ version: recordVersion, personId, envelopes } satisfies RecoveryRecord)
  if (new TextEncoder().encode(serialized).byteLength > maxRecordBytes) throw new Error("Recovery evidence is too large")
  const writes = serialized === stateRaw || (stateRaw === null && envelopes.length === 0)
    ? []
    : [{ key: stateKey, value: serialized }]
  return {
    conditions: [{ key: stateKey, value: stateRaw }, { key: legacyKey, value: legacyRaw }],
    writes,
  }
}

export async function exportIdentityRecoveryEvidence(personId: string): Promise<{ personId: string; envelopes: IdentityRecoveryEnvelope[] }> {
  validatePersonId(personId)
  const stored = await readLocal(recordKey(personId))
  const legacy = matchingLegacyEnvelope(await readLocal(legacyKey), personId)
  const existing = parseStoredRecord(stored, personId)
  const alreadyMigrated = legacy.length > 0 && existing.some(item => envelopeId(item) === envelopeId(legacy[0]!))
  if (!legacy.length || alreadyMigrated) return { personId, envelopes: structuredClone(existing) }
  let envelopes: IdentityRecoveryEnvelope[] = existing
  await updateLocal(recordKey(personId), current => {
    envelopes = mergeEnvelopes(personId, parseStoredRecord(current, personId), legacy)
    const record: RecoveryRecord = { version: recordVersion, personId, envelopes }
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > maxRecordBytes) throw new Error("Recovery evidence is too large")
    return JSON.stringify(record)
  })
  return { personId, envelopes: structuredClone(envelopes) }
}

export async function importIdentityRecoveryEvidence(personId: string, input: unknown): Promise<void> {
  validatePersonId(personId)
  // Snapshot all caller-owned data before the first asynchronous boundary.
  const incoming = validateIdentityRecoveryEvidence(personId, input)
  const legacy = matchingLegacyEnvelope(await readLocal(legacyKey), personId)
  await updateLocal(recordKey(personId), current => {
    const existing = parseStoredRecord(current, personId)
    const envelopes = mergeEnvelopes(personId, existing, legacy, incoming)
    const record: RecoveryRecord = { version: recordVersion, personId, envelopes }
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > maxRecordBytes) throw new Error("Recovery evidence is too large")
    return JSON.stringify(record)
  })
}
