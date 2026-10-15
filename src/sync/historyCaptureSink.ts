import { canonicalizeJson } from "@meta-uber/mesh-identity"
import type { ArchiveEncryptionBinding, SealedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"

const DATABASE = "tincanban-history-capture-sink-v1"
const MAX_OBJECTS = 8192
const MAX_BYTES = 512 * 1024 * 1024
const encoder = new TextEncoder()

export type NativeCatalogueEntry = { ciphertextId: string; binding: ArchiveEncryptionBinding; sealed: SealedArchiveObject }
type SinkProgress = { count: number; bytes: number; failed: boolean }

function validBinding(binding: ArchiveEncryptionBinding): boolean {
  return typeof binding.workspaceId === "string" && binding.workspaceId.length <= 256 &&
    Number.isSafeInteger(binding.historyEpoch) && binding.historyEpoch >= 1 &&
    ["page", "record", "part"].includes(binding.objectKind) && Number.isSafeInteger(binding.partCount) && binding.partCount >= 1 &&
    Number.isSafeInteger(binding.partIndex) && binding.partIndex >= 0 && binding.partIndex < binding.partCount
}

function validObject(object: SealedArchiveObject["object"]): boolean {
  return object.version === 1 && typeof object.ciphertext === "string" && typeof object.nonce === "string"
}

function validatedEntry(ciphertextId: string, bindingInput: ArchiveEncryptionBinding,
  objectInput: SealedArchiveObject["object"]): { entry: NativeCatalogueEntry; size: number } {
  const binding = structuredClone(bindingInput), object = structuredClone(objectInput)
  if (!/^[A-Za-z0-9_-]{43}$/.test(ciphertextId) || !validBinding(binding) || !validObject(object)) {
    throw new Error("Native history archive sink received an invalid encrypted object")
  }
  const size = encoder.encode(canonicalizeJson({ ciphertextId, binding, object })).length
  return { entry: { ciphertextId, binding, sealed: { ciphertextId, object } }, size }
}

function appendEntry(ciphertextId: string, binding: ArchiveEncryptionBinding, object: SealedArchiveObject["object"],
  objectStore: IDBObjectStore, transaction: IDBTransaction, prefix: string, progress: SinkProgress): void {
  try {
    if (progress.failed) throw new Error("Native history capture sink already failed")
    const checked = validatedEntry(ciphertextId, binding, object)
    if (++progress.count > MAX_OBJECTS || checked.size > MAX_BYTES - progress.bytes) {
      throw new Error("Native history capture exceeds its bounded encrypted storage limit")
    }
    progress.bytes += checked.size
    objectStore.add(checked.entry, `${prefix}\0${ciphertextId}`)
  } catch (error) {
    progress.failed = true
    try { transaction.abort() } catch { /* transaction may already be aborting */ }
    throw error
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains("objects")) db.createObjectStore("objects")
      if (!db.objectStoreNames.contains("captures")) db.createObjectStore("captures")
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Native history capture storage unavailable"))
  })
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Native history capture read failed"))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("Native history capture transaction aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("Native history capture transaction failed"))
  })
}

async function cataloguePage(db: IDBDatabase, prefix: string, after: string | undefined,
  ensureCurrent: () => void | Promise<void>): Promise<NativeCatalogueEntry[]> {
  await ensureCurrent()
  const transaction = db.transaction("objects", "readonly"), done = transactionDone(transaction)
  const lower = after === undefined ? prefix : after
  const request = transaction.objectStore("objects").getAll(IDBKeyRange.bound(lower, `${prefix}\uffff`, after !== undefined, false), 64)
  const items = await requestValue(request) as NativeCatalogueEntry[]
  await done
  if (items.length > 64) throw new Error("Native history capture page exceeds its bound")
  return items.map(item => structuredClone(item))
}

function validateCataloguePage(items: NativeCatalogueEntry[], prefix: string, after: string | undefined,
  currentCount: number, objectCount: number): { entries: NativeCatalogueEntry[]; after?: string; count: number } {
  let cursor = after, count = currentCount
  for (const item of items) {
    if (!item || !/^[A-Za-z0-9_-]{43}$/.test(item.ciphertextId) ||
        cursor !== undefined && `${prefix}${item.ciphertextId}` <= cursor) throw new Error("Native history capture object key mismatch")
    cursor = `${prefix}${item.ciphertextId}`
    if (++count > objectCount) throw new Error("Native history capture has extra objects")
  }
  return { entries: items, after: cursor, count }
}

function captureObjectCount(value: unknown): number {
  if (!value || typeof value !== "object" || !Number.isSafeInteger((value as { objectCount?: unknown }).objectCount) ||
      ((value as { objectCount: number }).objectCount < 1) || ((value as { objectCount: number }).objectCount > MAX_OBJECTS)) {
    throw new Error("Native history capture record is missing or malformed")
  }
  return (value as { objectCount: number }).objectCount
}

/** Keep wasm's synchronous ciphertext sink inside one durable IndexedDB transaction. */
export async function captureNativeCatalogue(transitionKey: string,
  produce: (sink: (ciphertextId: string, binding: ArchiveEncryptionBinding, object: SealedArchiveObject["object"]) => void) => unknown,
  ensureCurrent: () => void | Promise<void>): Promise<unknown> {
  if (typeof indexedDB === "undefined" || typeof transitionKey !== "string" || !transitionKey ||
      encoder.encode(transitionKey).length > 1024 || typeof produce !== "function") {
    throw new Error("Durable Native history capture requires IndexedDB")
  }
  const capturedKey = transitionKey
  await ensureCurrent()
  const db = await openDatabase()
  try {
    const read = db.transaction("captures", "readonly")
    const previous = await requestValue(read.objectStore("captures").get(capturedKey)) as { catalogue: unknown } | undefined
    await transactionDone(read)
    await ensureCurrent()
    if (previous) return structuredClone(previous.catalogue)

    const transaction = db.transaction(["objects", "captures"], "readwrite")
    const done = transactionDone(transaction)
    const objectStore = transaction.objectStore("objects")
    const progress: SinkProgress = { count: 0, bytes: 0, failed: false }
    const sink = (ciphertextId: string, bindingInput: ArchiveEncryptionBinding, objectInput: SealedArchiveObject["object"]) => {
      appendEntry(ciphertextId, bindingInput, objectInput, objectStore, transaction, capturedKey, progress)
    }
    let catalogue: unknown
    try {
      catalogue = structuredClone(produce(sink))
      transaction.objectStore("captures").add({ catalogue, objectCount: progress.count, bytes: progress.bytes }, capturedKey)
    } catch (error) {
      try { transaction.abort() } catch { /* transaction may already be aborting */ }
      await done.catch(() => {})
      throw error
    }
    await done
    await ensureCurrent()
    return catalogue
  } finally {
    db.close()
  }
}

/** Replay durable ciphertext into the immutable preparation journal; interrupted imports are idempotent. */
export async function* readNativeCatalogueObjects(transitionKey: string,
  ensureCurrent: () => void | Promise<void>): AsyncGenerator<NativeCatalogueEntry> {
  if (typeof indexedDB === "undefined" || !transitionKey) throw new Error("Native history capture storage unavailable")
  await ensureCurrent()
  const db = await openDatabase()
  try {
    const metadataTransaction = db.transaction("captures", "readonly")
    const metadataDone = transactionDone(metadataTransaction)
    const metadata: unknown = await requestValue(metadataTransaction.objectStore("captures").get(transitionKey))
    await metadataDone
    const objectCount = captureObjectCount(metadata)
    const prefix = `${transitionKey}\0`
    let after: string | undefined
    let count = 0
    do {
      const rawItems = await cataloguePage(db, prefix, after, ensureCurrent)
      const page = validateCataloguePage(rawItems, prefix, after, count, objectCount)
      for (const item of page.entries) {
        after = page.after
        count = page.count
        await ensureCurrent()
        yield item
      }
      if (rawItems.length < 64) break
      if (!rawItems.length) throw new Error("Native history capture scan made no progress")
    } while (true)
    if (count !== objectCount) throw new Error("Native history capture object set is incomplete")
  } finally { db.close() }
}

export async function discardNativeCatalogue(transitionKey: string, ensureCurrent: () => void | Promise<void>): Promise<void> {
  await ensureCurrent()
  const db = await openDatabase()
  try {
    const transaction = db.transaction(["objects", "captures"], "readwrite")
    const done = transactionDone(transaction)
    const prefix = `${transitionKey}\0`
    const request = transaction.objectStore("objects").openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      transaction.objectStore("objects").delete(cursor.primaryKey)
      cursor.continue()
    }
    transaction.objectStore("captures").delete(transitionKey)
    await done
    await ensureCurrent()
  } finally { db.close() }
}
