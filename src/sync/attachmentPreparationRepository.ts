import { BLOB_CHUNK_BYTES } from "@meta-uber/mesh-blob"
import { canonicalBlindJson, blindObjectId } from "./blindClient"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { parseAttachmentPreparation, type AttachmentPreparation, type AttachmentPreparationRepository } from "./attachmentPreparationData"
import { attachmentObjectKey, parseProgress, validateObject, validateProgress } from "./attachmentRepositoryData"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import type { AttachmentProgress } from "./attachmentTransfer"

type ObjectRecord = { objectId: string; object: BlindObject }

function sameIdentity(previous: AttachmentPreparation, next: AttachmentPreparation): boolean {
  return canonicalBlindJson({ ...previous, generation: 0, chunks: [] }) === canonicalBlindJson({ ...next, generation: 0, chunks: [] })
}

function assertAppend(previous: AttachmentPreparation | null, next: AttachmentPreparation, expected: number | null,
  record: ObjectRecord | undefined): void {
  if ((previous?.generation ?? null) !== expected || next.generation !== (expected ?? -1) + 1) throw new Error("Attachment preparation generation conflict")
  if (!previous) {
    if (next.chunks.length !== 0 || record) throw new Error("Attachment preparation must begin before staging chunks")
    return
  }
  if (!sameIdentity(previous, next) || next.chunks.length !== previous.chunks.length + 1 ||
    canonicalBlindJson(next.chunks.slice(0, -1)) !== canonicalBlindJson(previous.chunks)) throw new Error("Prepared attachment prefix is immutable")
  if (!record || record.objectId !== next.chunks.at(-1)!.objectId) throw new Error("Prepared attachment chunk must commit with its prefix")
}

async function captureObjectWrite(hash: string, record: ObjectRecord) {
  const object = validateObject(record.object)
  if (await blindObjectId(object) !== record.objectId) throw new Error("Prepared attachment ciphertext ID mismatch")
  const key = attachmentObjectKey(hash, record.objectId)
  const raw = await readLocal(key)
  if (raw !== null && canonicalBlindJson(validateObject(JSON.parse(raw))) !== canonicalBlindJson(object)) {
    throw new Error("Prepared attachment ciphertext is immutable")
  }
  return { condition: { key, value: raw }, write: { key, value: raw ?? JSON.stringify(object) } }
}

function assertFinish(previous: AttachmentPreparation | null, expected: number, next: AttachmentProgress, record: ObjectRecord): void {
  if (!previous || previous.generation !== expected || previous.chunks.length !== Math.ceil(previous.descriptor.size / BLOB_CHUNK_BYTES)) {
    throw new Error("Attachment preparation incomplete or changed")
  }
  const plan = previous.chunks.map(({ objectId, requestId }) => ({ objectId, requestId }))
    .concat({ objectId: next.locator.manifestId, requestId: previous.manifestRequestId })
  const expectedProgress: AttachmentProgress = { version: 1, generation: 0, binding: previous.binding,
    descriptor: previous.descriptor, locator: { version: 1, blobId: previous.descriptor.blobId,
      transferId: previous.transferId, manifestId: record.objectId }, objects: plan, received: [], receipts: {} }
  if (canonicalBlindJson(next) !== canonicalBlindJson(expectedProgress)) throw new Error("Final attachment plan does not match its prepared prefix")
}

/** Every staged chunk and prefix update share one CAS; final publication consumes that exact prefix. */
export function createAttachmentPreparationRepository(stateKeyPromise: Promise<string>, ensureCurrent: () => void): AttachmentPreparationRepository {
  const keys = async () => {
    const stateKey = await stateKeyPromise
    const hash = stateKey.slice("tincanban.attachment-transfer.v1.".length)
    return { stateKey, hash, preparationKey: `tincanban.attachment-preparation.v1.${hash}` }
  }
  return {
    async read() {
      ensureCurrent()
      const { preparationKey } = await keys()
      const value = parseAttachmentPreparation(await readLocal(preparationKey))
      ensureCurrent()
      return value
    },
    async commit(expected, nextInput, recordInput) {
      const next = parseAttachmentPreparation(JSON.stringify(structuredClone(nextInput)))!
      const record = recordInput ? structuredClone(recordInput) : undefined
      ensureCurrent()
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new Error("Invalid attachment preparation generation")
      const { stateKey, hash, preparationKey } = await keys()
      const previousRaw = await readLocal(preparationKey)
      const previous = parseAttachmentPreparation(previousRaw)
      assertAppend(previous, next, expected, record)
      const conditions = [{ key: stateKey, value: null }, { key: preparationKey, value: previousRaw }]
      const writes: Array<{ key: string; value: string | null }> = [{ key: preparationKey, value: JSON.stringify(next) }]
      if (record) {
        const object = await captureObjectWrite(hash, record)
        conditions.push(object.condition)
        writes.push(object.write)
      }
      ensureCurrent()
      if (!await compareAndSwapLocal({ conditions, writes }, ensureCurrent)) throw new Error("Attachment preparation changed during commit")
    },
    async finish(expected, nextInput, recordInput) {
      const next = validateProgress(structuredClone(nextInput))
      const record = structuredClone(recordInput)
      ensureCurrent()
      const { stateKey, hash, preparationKey } = await keys()
      const raw = await readLocal(preparationKey)
      const previous = parseAttachmentPreparation(raw)
      assertFinish(previous, expected, next, record)
      if (parseProgress(await readLocal(stateKey))) throw new Error("Attachment transfer is already published")
      const object = await captureObjectWrite(hash, record)
      ensureCurrent()
      const applied = await compareAndSwapLocal({ conditions: [{ key: stateKey, value: null }, { key: preparationKey, value: raw },
        object.condition], writes: [{ key: stateKey, value: JSON.stringify(next) },
        object.write, { key: preparationKey, value: null }] }, ensureCurrent)
      if (!applied) throw new Error("Attachment preparation changed during publication")
    },
    async discard(expectedInput) {
      const expected = parseAttachmentPreparation(JSON.stringify(structuredClone(expectedInput)))!
      ensureCurrent()
      const { stateKey, hash, preparationKey } = await keys()
      const raw = await readLocal(preparationKey)
      const previous = parseAttachmentPreparation(raw)
      if (!previous || canonicalBlindJson(previous) !== canonicalBlindJson(expected)) throw new Error("Attachment preparation changed before discard")
      ensureCurrent()
      const applied = await compareAndSwapLocal({ conditions: [{ key: stateKey, value: null }, { key: preparationKey, value: raw }],
        writes: [{ key: preparationKey, value: null }, ...previous.chunks.map(chunk => ({ key: attachmentObjectKey(hash, chunk.objectId), value: null }))] }, ensureCurrent)
      if (!applied) throw new Error("Attachment preparation changed before discard")
    },
  }
}
