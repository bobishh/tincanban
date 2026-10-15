import { BLOB_CHUNK_BYTES } from "@meta-uber/mesh-blob"
import { blindHash, blindObjectId, canonicalBlindJson } from "./blindClient"
import type { BlindObject } from "./blindEnvelope"
import type { AttachmentProgress, AttachmentTransferRepository } from "./attachmentTransfer"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { ID_PATTERN, STATE_LIMIT, attachmentObjectKey, hasExactKeys, validateObject, validateProgress, parseProgress } from "./attachmentRepositoryData"
import type { AttachmentPreparationRepository } from "./attachmentPreparationData"
import { createAttachmentPreparationRepository } from "./attachmentPreparationRepository"

const OBJECT_LIMIT = 34
const encoder = new TextEncoder()
function fail(message: string): never { throw new Error(message) }

function assertProgressTransition(previous: AttachmentProgress, next: AttachmentProgress): void {
  if (previous.binding !== next.binding || canonicalBlindJson(previous.descriptor) !== canonicalBlindJson(next.descriptor) ||
    canonicalBlindJson(previous.locator) !== canonicalBlindJson(next.locator) || canonicalBlindJson(previous.objects) !== canonicalBlindJson(next.objects)) {
    throw new Error("Attachment transfer identity and object plan are immutable")
  }
  const received = new Set(next.received)
  if (previous.received.some(id => !received.has(id))) throw new Error("Attachment received progress must be monotonic")
  for (const [id, receipt] of Object.entries(previous.receipts)) {
    if (!Object.hasOwn(next.receipts, id) || canonicalBlindJson(receipt) !== canonicalBlindJson(next.receipts[id])) {
      throw new Error("Attachment receipts are immutable and must be retained")
    }
  }
}

function assertBindingMigrationTransition(previous: AttachmentProgress, next: AttachmentProgress): void {
  if (next.version !== previous.version || next.generation !== previous.generation + 1 || next.binding === previous.binding ||
    canonicalBlindJson(previous.descriptor) !== canonicalBlindJson(next.descriptor) ||
    canonicalBlindJson(previous.locator) !== canonicalBlindJson(next.locator) ||
    canonicalBlindJson(previous.objects) !== canonicalBlindJson(next.objects) ||
    canonicalBlindJson(previous.receipts) !== canonicalBlindJson(next.receipts) ||
    canonicalBlindJson(previous.received) !== canonicalBlindJson(next.received)) {
    throw new Error("Attachment binding migration may only advance generation and replace binding")
  }
}

async function prepareObjects(records: Array<{ objectId: string; object: BlindObject }>, next: AttachmentProgress): Promise<Map<string, BlindObject>> {
  if (!Array.isArray(records) || records.length > OBJECT_LIMIT) throw new Error("Invalid attachment object batch")
  const unique = new Map<string, BlindObject>()
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record) || !hasExactKeys(record, ["objectId", "object"]) ||
      typeof record.objectId !== "string" || !ID_PATTERN.test(record.objectId) || unique.has(record.objectId)) throw new Error("Invalid attachment object batch")
    const object = validateObject(record.object)
    if (await blindObjectId(object) !== record.objectId) throw new Error("Attachment object ID does not match ciphertext")
    if (!next.objects.some(item => item.objectId === record.objectId)) throw new Error("Attachment object is outside transfer plan")
    unique.set(record.objectId, object)
  }
  return unique
}

async function commitLocal(stateKey: string, expected: number | null, next: AttachmentProgress,
  objects: Map<string, BlindObject>, ensureCurrent: () => void): Promise<void> {
  const storageHash = stateKey.slice("tincanban.attachment-transfer.v1.".length)
  const objectKeys = [...objects.keys()].map(id => attachmentObjectKey(storageHash, id))
  const keys = [stateKey, ...objectKeys]
  const currentRaw = await Promise.all(keys.map(key => readLocal(key)))
  const currentState = parseProgress(currentRaw[0] ?? null)
  if ((currentState?.generation ?? null) !== expected) throw new Error("Attachment generation conflict")
  if (currentState) assertProgressTransition(currentState, next)
  const conditions = keys.map((key, index) => ({ key, value: currentRaw[index] ?? null }))
  const writes = [{ key: stateKey, value: JSON.stringify(next) }]
  for (const [index, [id, object]] of [...objects.entries()].entries()) {
    const raw = currentRaw[index + 1] ?? null
    if (raw === null) {
      writes.push({ key: attachmentObjectKey(storageHash, id), value: JSON.stringify(object) })
      continue
    }
    let saved: unknown
    try { saved = JSON.parse(raw) as unknown } catch { throw new Error("Invalid stored attachment object") }
    const validated = validateObject(saved)
    if (await blindObjectId(validated) !== id || canonicalBlindJson(validated) !== canonicalBlindJson(object)) {
      throw new Error("Attachment object ID already contains different ciphertext")
    }
  }
  ensureCurrent()
  if (!await compareAndSwapLocal({ conditions, writes }, ensureCurrent)) throw new Error("Attachment repository changed during commit")
}

/** Durable local transfer metadata plus immutable encrypted object records. */
export function createAttachmentRepository(storageId: string, ensureCurrent: () => void): AttachmentTransferRepository & {
  preparation: AttachmentPreparationRepository
  migrateBinding: (expected: number, previousBinding: string, next: AttachmentProgress) => Promise<void>
} {
  const storageSnapshot = storageId
  if (typeof storageSnapshot !== "string" || !storageSnapshot.trim() || storageSnapshot.length > 2048) throw new Error("Invalid attachment storage ID")
  const stateKeyPromise = blindHash(encoder.encode(storageSnapshot)).then(hash => `tincanban.attachment-transfer.v1.${hash}`)

  return {
    preparation: createAttachmentPreparationRepository(stateKeyPromise, ensureCurrent),
    async read() {
      ensureCurrent()
      const key = await stateKeyPromise
      const raw = await readLocal(key)
      const state = parseProgress(raw)
      ensureCurrent()
      return state
    },
    async object(idInput) {
      const id = idInput
      if (typeof id !== "string" || !ID_PATTERN.test(id)) return fail("Invalid attachment object ID")
      ensureCurrent()
      const stateKey = await stateKeyPromise
      const storageHash = stateKey.slice("tincanban.attachment-transfer.v1.".length)
      const raw = await readLocal(attachmentObjectKey(storageHash, id))
      if (raw === null) { ensureCurrent(); return null }
      if (encoder.encode(raw).byteLength > Math.ceil((BLOB_CHUNK_BYTES + 16) * 4 / 3) + 2048) return fail("Stored attachment object exceeds size bound")
      let value: unknown
      try { value = JSON.parse(raw) as unknown } catch { return fail("Invalid stored attachment object") }
      const object = validateObject(value)
      if (await blindObjectId(object) !== id) return fail("Stored attachment object integrity failure")
      ensureCurrent()
      return object
    },
    async commit(expectedInput, nextInput, recordsInput = []) {
      const expected = expectedInput
      const nextSnapshot = structuredClone(nextInput)
      const records = structuredClone(recordsInput)
      ensureCurrent()
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new Error("Invalid attachment generation")
      if (nextSnapshot.generation !== (expected ?? -1) + 1) throw new Error("Attachment generation conflict")
      const next = validateProgress(nextSnapshot)
      if (encoder.encode(JSON.stringify(next)).byteLength > STATE_LIMIT) throw new Error("Attachment progress exceeds storage bound")
      const objects = await prepareObjects(records, next)
      ensureCurrent()
      const stateKey = await stateKeyPromise
      await commitLocal(stateKey, expected, next, objects, ensureCurrent)
    },

    async migrateBinding(expectedInput, previousBindingInput, nextInput) {
      const expected = expectedInput
      const previousBinding = previousBindingInput
      const nextSnapshot = structuredClone(nextInput)
      ensureCurrent()
      if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER ||
        typeof previousBinding !== "string" || !ID_PATTERN.test(previousBinding) ||
        nextSnapshot.generation !== expected + 1) throw new Error("Attachment binding migration generation or binding conflict")
      const next = validateProgress(nextSnapshot)
      if (encoder.encode(JSON.stringify(next)).byteLength > STATE_LIMIT) throw new Error("Attachment progress exceeds storage bound")
      if (next.binding === previousBinding) throw new Error("Attachment binding migration must replace its binding")
      const stateKey = await stateKeyPromise
      ensureCurrent()
      const currentRaw = await readLocal(stateKey)
      ensureCurrent()
      const current = parseProgress(currentRaw)
      if (!current || current.generation !== expected || current.binding !== previousBinding) {
        throw new Error("Attachment binding migration generation or binding conflict")
      }
      assertBindingMigrationTransition(current, next)
      ensureCurrent()
      const applied = await compareAndSwapLocal({ conditions: [{ key: stateKey, value: currentRaw }],
        writes: [{ key: stateKey, value: JSON.stringify(next) }] }, ensureCurrent)
      if (!applied) throw new Error("Attachment repository changed during binding migration")
    },
  }
}
