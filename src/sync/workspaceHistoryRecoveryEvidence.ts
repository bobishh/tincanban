import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import { openWorkspaceJournal, transactionDone } from "../storageJournal"
import type { HistoryRecoveryEvidencePart } from "./historyRecoveryArchive"
import { WORKSPACE_RECOVERY_STORES } from "../workspaceRecoveryStores"
import { readWorkspaceRecoveryRevision } from "./workspaceRecoveryRevision"

const STORES = WORKSPACE_RECOVERY_STORES
const PART_BYTES = 256 * 1024
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const encoder = new TextEncoder()

async function detachEvidenceValue(value: unknown, rowId: string, binaries: Array<{ id: string; bytes: Uint8Array; path: string[] }>,
  nodes: { count: number }, path: string[] = [], depth = 0): Promise<unknown> {
  if (++nodes.count > 1_048_576 || depth > 64) throw new Error("Recovery evidence structure exceeds size limit")
  if (isPrimitive(value)) return value
  if (value instanceof Uint8Array) {
    const id = await sha256Base64Url(encoder.encode(canonicalizeJson([rowId, path])))
    binaries.push({ id, bytes: value, path })
    return null
  }
  if (Array.isArray(value)) return detachEvidenceArray(value, rowId, binaries, nodes, path, depth)
  if (!isPlainRecord(value)) throw new Error("Unsupported local recovery evidence value")
  const entries: Array<[string, unknown]> = []
  for (const [key, child] of Object.entries(value)) if (child !== undefined) {
    entries.push([key, await detachEvidenceValue(child, rowId, binaries, nodes, [...path, key], depth + 1)])
  }
  return Object.fromEntries(entries)
}
function isPrimitive(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
async function detachEvidenceArray(value: unknown[], rowId: string, binaries: Array<{ id: string; bytes: Uint8Array; path: string[] }>,
  nodes: { count: number }, path: string[], depth: number): Promise<unknown[]> {
  const result: unknown[] = []
  for (const [index, child] of value.entries()) result.push(await detachEvidenceValue(child, rowId, binaries, nodes, [...path, String(index)], depth + 1))
  return result
}

/** Explicit backup only: preserve exact local sources, including pending/quarantined evidence, without granting them admission. */
export async function createWorkspaceHistoryRecoveryEvidence(workspaceId: string, ensureCurrent: () => void) {
  if (!workspaceId || workspaceId.length > 256 || typeof ensureCurrent !== "function") throw new Error("Invalid recovery workspace")
  ensureCurrent()
  const database = await openWorkspaceJournal()
  const readRevision = () => readWorkspaceRecoveryRevision(database, workspaceId, ensureCurrent)
  const revision = await readRevision()
  const assertUnchanged = async () => {
    if (await readRevision() !== revision) throw new Error("Workspace changed during private recovery export; retry when changes settle")
    ensureCurrent()
  }
  const page = async (store: typeof STORES[number], after?: IDBValidKey) => {
    ensureCurrent()
    const transaction = database.transaction(store, "readonly"), done = transactionDone(transaction)
    const pendingRows = new Promise<Array<{ id: IDBValidKey; value: unknown }>>((resolve, reject) => {
      const result: Array<{ id: IDBValidKey; value: unknown }> = []
      const request = transaction.objectStore(store).index("workspaceId").openCursor(IDBKeyRange.only(workspaceId))
      request.onerror = () => reject(request.error ?? new Error("Workspace recovery journal read failed"))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) { resolve(result); return }
        if (after !== undefined && indexedDB.cmp(cursor.primaryKey, after) <= 0) {
          if (indexedDB.cmp(cursor.primaryKey, after) < 0) cursor.continuePrimaryKey(workspaceId, after)
          else cursor.continue()
          return
        }
        result.push({ id: structuredClone(cursor.primaryKey), value: cursor.value })
        if (result.length === 64) resolve(result)
        else cursor.continue()
      }
    })
    let rows: Array<{ id: IDBValidKey; value: unknown }>
    try { rows = await pendingRows; await done }
    catch (error) { await done.catch(() => undefined); throw error }
    ensureCurrent()
    return rows
  }
  async function* evidence(): AsyncGenerator<HistoryRecoveryEvidencePart> {
    let byteCount = 0, recordCount = 0
    const parts = function* (category: string, id: string, bytes: Uint8Array): Generator<HistoryRecoveryEvidencePart> {
      byteCount += bytes.byteLength
      if (byteCount > MAX_SOURCE_BYTES) throw new Error("Local workspace recovery evidence exceeds size limit")
      const partCount = Math.max(1, Math.ceil(bytes.byteLength / PART_BYTES))
      for (let partIndex = 0; partIndex < partCount; partIndex++) {
        ensureCurrent()
        yield { kind: "local-evidence-part", category, id, partIndex, partCount,
          data: toBase64Url(bytes.subarray(partIndex * PART_BYTES, (partIndex + 1) * PART_BYTES)) }
      }
    }
    for (const store of STORES) {
      let after: IDBValidKey | undefined
      for (;;) {
        await assertUnchanged()
        const rows = await page(store, after)
        for (const row of rows) {
          if (++recordCount > 1_048_576) throw new Error("Too many local workspace recovery records")
          const rowId = await sha256Base64Url(encoder.encode(canonicalizeJson([store, row.id])))
          const binaries: Array<{ id: string; bytes: Uint8Array; path: string[] }> = []
          const metadata = await detachEvidenceValue(row.value, rowId, binaries, { count: 0 })
          for (const binary of binaries) yield* parts(`${store}-bytes`, binary.id, binary.bytes)
          yield* parts(`${store}-metadata`, rowId, encoder.encode(canonicalizeJson({ record: metadata,
            binaryFields: binaries.map(binary => ({ path: binary.path, id: binary.id, byteLength: binary.bytes.byteLength })) })))
          after = row.id
          ensureCurrent()
        }
        if (rows.length < 64) break
      }
    }
    await assertUnchanged()
  }
  return { revision, evidence: evidence(), assertUnchanged }
}
