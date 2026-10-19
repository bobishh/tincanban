import { blindHash, canonicalBlindJson } from "./blindClient"
import { mergeAttachmentLocators, parseAttachmentLocators } from "../product-replica"
import type { AttachmentLocator } from "../product-replica"
import { readLocal, updateLocal, type LocalStatePlan } from "../localDb"

const keyPrefix = "tincanban.attachment-index.v1."
const maxRecordBytes = 256 * 1024
const maxStorageIdBytes = 16 * 1024
const encoder = new TextEncoder()

type AttachmentIndexRecord = { version: 1; generation: number; locators: AttachmentLocator[] }

function keyFor(storageId: string): Promise<string> {
  return blindHash(encoder.encode(storageId)).then(hash => `${keyPrefix}${hash}`)
}

function parseRecord(raw: string | null): AttachmentIndexRecord | null {
  if (raw === null) return null
  if (encoder.encode(raw).byteLength > maxRecordBytes) throw new Error("Attachment index exceeds its storage bound")
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error("Invalid attachment index JSON") }
  if (!isRecord(value) || !exactKeys(value, ["version", "generation", "locators"]) || value.version !== 1 ||
    !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) throw new Error("Invalid attachment index record")
  const locators = parseAttachmentLocators(value.locators)
  return { version: 1, generation: value.generation as number, locators }
}

function serializeRecord(record: AttachmentIndexRecord): string {
  const raw = canonicalBlindJson(record)
  if (encoder.encode(raw).byteLength > maxRecordBytes) throw new Error("Attachment index exceeds its storage bound")
  return raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function sameLocators(left: AttachmentLocator[], right: AttachmentLocator[]): boolean {
  return left.length === right.length && left.every((locator, index) => locator.blobId === right[index]?.blobId &&
    locator.transferId === right[index]?.transferId && locator.manifestId === right[index]?.manifestId)
}

function validateStorageId(storageId: string): void {
  if (typeof storageId !== "string" || !storageId.trim() || encoder.encode(storageId).byteLength > maxStorageIdBytes) {
    throw new Error("Invalid attachment index storage ID")
  }
}

/** Read and validate both indices, then return a side-effect-free additive CAS migration plan. */
export async function planAttachmentIndexMigration(sourceStorageId: string, targetStorageId: string): Promise<LocalStatePlan> {
  validateStorageId(sourceStorageId)
  validateStorageId(targetStorageId)
  const [sourceKey, targetKey] = await Promise.all([keyFor(sourceStorageId), keyFor(targetStorageId)])
  const sameKey = sourceKey === targetKey
  const [sourceRaw, targetRaw] = sameKey
    ? await readLocal(sourceKey).then(raw => [raw, raw] as const)
    : await Promise.all([readLocal(sourceKey), readLocal(targetKey)])
  const sourceRecord = parseRecord(sourceRaw)
  const targetRecord = parseRecord(targetRaw)
  const locators = mergeAttachmentLocators(targetRecord?.locators, sourceRecord?.locators ?? [])
  const changed = !sameLocators(locators, targetRecord?.locators ?? [])
  let nextRaw: string | null = null
  if (changed) {
    const generation = (targetRecord?.generation ?? 0) + 1
    if (!Number.isSafeInteger(generation)) throw new Error("Attachment index generation exceeds its safe range")
    nextRaw = serializeRecord({ version: 1, generation, locators })
  }
  const conditions = [{ key: sourceKey, value: sourceRaw }]
  if (!sameKey) conditions.push({ key: targetKey, value: targetRaw })
  const writes = changed ? [{ key: targetKey, value: nextRaw }] : []
  return { conditions, writes }
}

/** Durable, identity-private immutable attachment locator set. */
export function createAttachmentIndexRepository(storageIdInput: string, ensureCurrent: () => void) {
  const storageId = storageIdInput
  validateStorageId(storageId)
  const keyPromise = keyFor(storageId)
  let cachedRaw: string | null | undefined
  let cachedRecord: AttachmentIndexRecord | null = null
  let cachedRevision: Promise<string | undefined> | undefined

  async function readRecord(): Promise<AttachmentIndexRecord | null> {
    ensureCurrent()
    const key = await keyPromise
    ensureCurrent()
    const raw = await readLocal(key)
    ensureCurrent()
    if (raw !== cachedRaw) {
      const parsed = parseRecord(raw)
      cachedRaw = raw
      cachedRecord = parsed
      cachedRevision = undefined
    }
    return cachedRecord
  }

  return {
    async read(): Promise<AttachmentLocator[]> {
      const record = await readRecord()
      return structuredClone(record?.locators ?? [])
    },

    async revision(): Promise<string | undefined> {
      const record = await readRecord()
      if (!record) return undefined
      let revision = cachedRevision
      if (!revision) {
        const snapshot = structuredClone(record)
        revision = blindHash(encoder.encode(canonicalBlindJson(snapshot.locators)))
          .then(contentHash => {
            ensureCurrent()
            return `${snapshot.generation}:${contentHash}`
          })
        cachedRevision = revision
      }
      try {
        const value = await revision
        ensureCurrent()
        return value
      }
      catch (cause) {
        if (cachedRevision === revision) cachedRevision = undefined
        throw cause
      }
    },

    async merge(locatorsInput: unknown): Promise<void> {
      ensureCurrent()
      const incoming = parseAttachmentLocators(structuredClone(locatorsInput))
      const key = await keyPromise
      ensureCurrent()
      const current = await readLocal(key)
      ensureCurrent()
      const currentRecord = parseRecord(current)
      const merged = mergeAttachmentLocators(currentRecord?.locators, incoming)
      if (sameLocators(merged, currentRecord?.locators ?? [])) return

      await updateLocal(key, raw => {
        ensureCurrent()
        const latest = parseRecord(raw)
        const nextLocators = mergeAttachmentLocators(latest?.locators, incoming)
        if (sameLocators(nextLocators, latest?.locators ?? [])) return raw ?? serializeRecord({ version: 1, generation: 0, locators: [] })
        const generation = (latest?.generation ?? 0) + 1
        if (!Number.isSafeInteger(generation)) throw new Error("Attachment index generation exceeds its safe range")
        return serializeRecord({ version: 1, generation, locators: nextLocators })
      })
      ensureCurrent()
    },
  }
}
