import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../domain/identity"
import { captureEncryptedArchiveObject, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import type { HistoryRecoveryRecord } from "./historyRecoveryArchive"

const DATABASE = "tincanban-private-workspace-recovery-v1"
const STORE = "records"
const MAX_OBJECTS = 1_048_576
const MAX_BYTES = 512 * 1024 * 1024
const encoder = new TextEncoder()
type RetainedObject = { kind: "workspace-recovery-encrypted-object"; version: 1; personId: string; scopeId: string;
  ciphertextId: string; digest: string; object: EncryptedArchiveObject }
type ObjectReference = { scopeId: string; ciphertextId: string }
type RetainedIndex = { kind: "workspace-recovery-object-index"; version: 1; personId: string; workspaceId: string;
  recoveryId: string; digest: string; objects: ObjectReference[] }
export type WorkspaceRecoveryObjectIndex = Omit<RetainedIndex, "kind" | "version" | "digest">

function persistence() { return new BrowserMeshStore(DATABASE, [STORE]) }
function validateIdentity(personId: string, workspaceId?: string, recoveryId?: string): void {
  if (typeof personId !== "string" || !personId || personId.length > 512 ||
      workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 256) ||
      recoveryId !== undefined && (typeof recoveryId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryId))) {
    throw new Error("Invalid private recovery object binding")
  }
}
function scopeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function objectId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) }
async function keyFor(kind: "object" | "index", parts: unknown[]): Promise<string> {
  if (kind === "index") {
    const [personId, workspaceId, recoveryId] = parts as [string, string, string]
    const [personHash, workspaceHash, recoveryHash] = await Promise.all([personId, workspaceId, recoveryId].map(value =>
      sha256Base64Url(encoder.encode(value))))
    return `workspace-recovery.objects.v1.index.${personHash}.${workspaceHash}.${recoveryHash}`
  }
  const hash = await sha256Base64Url(encoder.encode(canonicalizeJson([kind, ...parts])))
  return `workspace-recovery.objects.v1.${kind}.${hash}`
}
async function workspaceIndexPrefix(personId: string, workspaceId: string): Promise<string> {
  const [personHash, workspaceHash] = await Promise.all([personId, workspaceId].map(value => sha256Base64Url(encoder.encode(value))))
  return `workspace-recovery.objects.v1.index.${personHash}.${workspaceHash}.`
}
function objectContent(object: EncryptedArchiveObject): string { return canonicalizeJson(object) }
function captureIndex(value: unknown, personId: string, workspaceId: string, recoveryId: string): RetainedIndex {
  const index = structuredClone(value) as RetainedIndex
  if (!index || index.kind !== "workspace-recovery-object-index" || index.version !== 1 || index.personId !== personId ||
      index.workspaceId !== workspaceId || index.recoveryId !== recoveryId || !Array.isArray(index.objects) || typeof index.digest !== "string") {
    throw new Error("Stored recovery object index is malformed")
  }
  const previous = new Set<string>()
  for (const item of index.objects) {
    if (!item || !scopeId(item.scopeId) || !objectId(item.ciphertextId)) throw new Error("Stored recovery object index entry is malformed")
    const key = `${item.scopeId}/${item.ciphertextId}`
    if (previous.has(key)) throw new Error("Stored recovery object index contains duplicates")
    previous.add(key)
  }
  index.objects.sort((left, right) => `${left.scopeId}/${left.ciphertextId}` < `${right.scopeId}/${right.ciphertextId}` ? -1 : 1)
  return index
}

/** Store only validated encrypted archive envelopes. Source keys and access credentials are never persisted here. */
export async function retainWorkspaceRecoveryObjects(personId: string, workspaceId: string, recoveryId: string,
  recordsInput: HistoryRecoveryRecord[], ensureCurrent: () => void): Promise<void> {
  validateIdentity(personId, workspaceId, recoveryId)
  if (!Array.isArray(recordsInput) || recordsInput.length > MAX_OBJECTS * 2 + 512 || typeof ensureCurrent !== "function") {
    throw new Error("Invalid private recovery object input")
  }
  ensureCurrent()
  const records = structuredClone(recordsInput)
  const sources = archiveSourceEpochs(records, workspaceId)
  if (!sources.size && !records.some(record => record.kind === "encrypted-object")) return
  if (!sources.size) throw new Error("Recovery encrypted objects require a matching archive source")
  const ordered = await captureRecoveryObjects(records, sources, ensureCurrent)
  const database = persistence(), references: ObjectReference[] = []
  for (const entry of ordered) {
    ensureCurrent()
    const ref = entry.reference, key = await keyFor("object", [personId, ref.scopeId, ref.ciphertextId])
    const fingerprint = await sha256Base64Url(encoder.encode(entry.canonical))
    ensureCurrent()
    const value: RetainedObject = { kind: "workspace-recovery-encrypted-object", version: 1, personId,
      scopeId: ref.scopeId, ciphertextId: ref.ciphertextId, digest: fingerprint, object: entry.object }
    await database.updateRecords(STORE, [key], current => {
      const old = current[0] as RetainedObject | undefined
      if (old === undefined) return { writes: [{ key, value }], result: undefined }
      if (!old || old.kind !== value.kind || old.version !== 1 || old.personId !== personId || old.scopeId !== ref.scopeId ||
          old.ciphertextId !== ref.ciphertextId || old.digest !== fingerprint || objectContent(captureEncryptedArchiveObject(old.object, ref.scopeId)) !== entry.canonical) {
        throw new Error("Immutable recovery ciphertext already contains different data")
      }
      return { writes: [], result: undefined }
    })
    ensureCurrent()
    references.push(ref)
  }
  references.sort((left, right) => `${left.scopeId}/${left.ciphertextId}` < `${right.scopeId}/${right.ciphertextId}` ? -1 : 1)
  await persistRecoveryIndex(database, personId, workspaceId, recoveryId, references, ensureCurrent)
}

function archiveSourceEpochs(records: HistoryRecoveryRecord[], workspaceId: string): Map<string, Set<number>> {
  const sources = new Map<string, Set<number>>()
  for (const source of records) {
    if (source.kind !== "archive-source") continue
    validateArchiveSource(source, workspaceId)
    const epochs = sources.get(source.scopeId) ?? new Set<number>()
    epochs.add(source.keyEpoch)
    sources.set(source.scopeId, epochs)
  }
  return sources
}
function validateArchiveSource(source: Extract<HistoryRecoveryRecord, {kind:"archive-source"}>, workspaceId: string): void {
  if (source.workspaceId !== workspaceId || !scopeId(source.scopeId) || !Number.isSafeInteger(source.keyEpoch) || source.keyEpoch < 1 ||
      typeof source.id !== "string" || !source.id || source.id.length > 256 || typeof source.key !== "string" ||
      typeof source.signedJson !== "string") throw new Error("Invalid recovery archive source")
  if (!/^[A-Za-z0-9_-]{43}$/.test(source.key)) throw new Error("Invalid recovery archive source key encoding")
  const decoded = fromBase64Url(source.key), valid = decoded.length === 32 && toBase64Url(decoded) === source.key
  decoded.fill(0)
  if (!valid) throw new Error("Invalid recovery archive source key")
}
async function captureRecoveryObjects(records: HistoryRecoveryRecord[], sources: Map<string, Set<number>>,
  ensureCurrent: () => void) {
  const objects = new Map<string, { reference: ObjectReference; object: EncryptedArchiveObject; canonical: string }>()
  let totalBytes = 0
  for (const item of records) {
    if (item.kind !== "encrypted-object") continue
    ensureCurrent()
    if (!scopeId(item.scopeId) || !objectId(item.ciphertextId)) throw new Error("Invalid recovery ciphertext identifier")
    const epochs = sources.get(item.scopeId)
    if (!epochs) throw new Error("Recovery ciphertext has no matching archive source")
    const object = captureEncryptedArchiveObject(item.object, item.scopeId)
    if (!epochs.has(object.keyEpoch)) throw new Error("Recovery ciphertext key epoch does not match its archive source")
    const canonical = objectContent(object), encoded = encoder.encode(canonical)
    if (await sha256Base64Url(encoded) !== item.ciphertextId) throw new Error("Recovery ciphertext ID does not match exact encrypted bytes")
    ensureCurrent()
    const identity = `${item.scopeId}/${item.ciphertextId}`, existing = objects.get(identity)
    if (existing && existing.canonical !== canonical) throw new Error("Recovery ciphertext ID changed within the backup")
    if (!existing) {
      if (objects.size >= MAX_OBJECTS || totalBytes + encoded.byteLength > MAX_BYTES) throw new Error("Recovery encrypted objects exceed size limit")
      totalBytes += encoded.byteLength
      objects.set(identity, { reference: { scopeId: item.scopeId, ciphertextId: item.ciphertextId }, object, canonical })
    }
  }
  return [...objects.values()].sort((left, right) => `${left.reference.scopeId}/${left.reference.ciphertextId}` <
    `${right.reference.scopeId}/${right.reference.ciphertextId}` ? -1 : 1)
}
async function persistRecoveryIndex(database: BrowserMeshStore, personId: string, workspaceId: string, recoveryId: string,
  references: ObjectReference[], ensureCurrent: () => void): Promise<void> {
  const indexKey = await keyFor("index", [personId, workspaceId, recoveryId])
  const payload = { personId, workspaceId, recoveryId, objects: references }
  const indexDigest = await sha256Base64Url(encoder.encode(canonicalizeJson(payload)))
  const index: RetainedIndex = { kind: "workspace-recovery-object-index", version: 1, ...payload, digest: indexDigest }
  ensureCurrent()
  await database.updateRecords(STORE, [indexKey], current => {
    const old = current[0] as RetainedIndex | undefined
    if (old === undefined) return { writes: [{ key: indexKey, value: index }], result: undefined }
    const captured = captureIndex(old, personId, workspaceId, recoveryId)
    const capturedPayload = { personId: captured.personId, workspaceId: captured.workspaceId, recoveryId: captured.recoveryId, objects: captured.objects }
    if (captured.digest !== indexDigest || canonicalizeJson(capturedPayload) !== canonicalizeJson(payload)) {
      throw new Error("Immutable recovery object index already contains different data")
    }
    return { writes: [], result: undefined }
  })
  ensureCurrent()
}

/** Read opaque cached ciphertext by owner, scope, and content ID; this grants no archive authority. */
export async function readWorkspaceRecoveryObject(personId: string, scopeIdInput: string, ciphertextId: string,
  ensureCurrent: () => void): Promise<EncryptedArchiveObject | undefined> {
  validateIdentity(personId)
  if (!scopeId(scopeIdInput) || !objectId(ciphertextId) || typeof ensureCurrent !== "function") throw new Error("Invalid recovery ciphertext lookup")
  ensureCurrent()
  const key = await keyFor("object", [personId, scopeIdInput, ciphertextId])
  ensureCurrent()
  const value = await persistence().get<unknown>(STORE, key)
  ensureCurrent()
  if (value === undefined) return undefined
  const stored = structuredClone(value) as RetainedObject
  if (!stored || stored.kind !== "workspace-recovery-encrypted-object" || stored.version !== 1 || stored.personId !== personId ||
      stored.scopeId !== scopeIdInput || stored.ciphertextId !== ciphertextId || typeof stored.digest !== "string") {
    throw new Error("Stored recovery ciphertext binding mismatch")
  }
  const object = captureEncryptedArchiveObject(stored.object, scopeIdInput)
  const canonical = objectContent(object)
  const actualDigest = await sha256Base64Url(encoder.encode(canonical))
  if (actualDigest !== ciphertextId || actualDigest !== stored.digest) throw new Error("Stored recovery ciphertext integrity check failed")
  ensureCurrent()
  return object
}

/** List immutable object IDs for a single owner/workspace/recovery export. */
export async function listWorkspaceRecoveryObjectIndex(personId: string, workspaceId: string, recoveryId: string,
  ensureCurrent: () => void): Promise<WorkspaceRecoveryObjectIndex | undefined> {
  validateIdentity(personId, workspaceId, recoveryId)
  if (typeof ensureCurrent !== "function") throw new Error("Invalid recovery object index guard")
  ensureCurrent()
  const key = await keyFor("index", [personId, workspaceId, recoveryId])
  ensureCurrent()
  const value = await persistence().get<unknown>(STORE, key)
  ensureCurrent()
  if (value === undefined) return undefined
  const index = captureIndex(value, personId, workspaceId, recoveryId)
  const payload = { personId, workspaceId, recoveryId, objects: index.objects }
  if (await sha256Base64Url(encoder.encode(canonicalizeJson(payload))) !== index.digest) throw new Error("Stored recovery object index integrity check failed")
  ensureCurrent()
  return structuredClone(payload)
}

/** List per-recovery indexes under one owner/workspace binding for later private exports. */
export async function listWorkspaceRecoveryObjectIndexes(personId: string, workspaceId: string,
  ensureCurrent: () => void): Promise<WorkspaceRecoveryObjectIndex[]> {
  validateIdentity(personId, workspaceId)
  if (typeof ensureCurrent !== "function") throw new Error("Invalid recovery object index guard")
  ensureCurrent()
  const prefix = await workspaceIndexPrefix(personId, workspaceId), database = persistence()
  ensureCurrent()
  const indexes: WorkspaceRecoveryObjectIndex[] = []
  let after: string | undefined
  let complete = false
  while (!complete) {
    const page = await database.scan<unknown>(STORE, prefix, after, 64)
    ensureCurrent()
    if (page.entries.length > 64 || page.nextAfter !== null && page.nextAfter !== page.entries.at(-1)?.key) {
      throw new Error("Invalid workspace recovery index page")
    }
    for (const entry of page.entries) {
      const value = captureIndex(entry.value, personId, workspaceId, (entry.value as RetainedIndex).recoveryId)
      const expectedKey = await keyFor("index", [personId, workspaceId, value.recoveryId])
      if (entry.key !== expectedKey) throw new Error("Workspace recovery index key binding mismatch")
      const payload = { personId, workspaceId, recoveryId: value.recoveryId, objects: value.objects }
      if (await sha256Base64Url(encoder.encode(canonicalizeJson(payload))) !== value.digest) {
        throw new Error("Stored recovery object index integrity check failed")
      }
      indexes.push(structuredClone(payload))
    }
    if (page.nextAfter === null) { complete = true; continue }
    if (!page.entries.length) throw new Error("Workspace recovery index scan made no progress")
    after = page.nextAfter
  }
  ensureCurrent()
  return indexes
}
