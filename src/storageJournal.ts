import { clearLocalJournal, localJournalEntries, readLocalJournal, readLocalJournalReference, requestResult, transactionDone,
  type StoredWorkspaceSnapshot } from "./storageJournalRecords"
import { WorkspaceDeltaJournal, materializeDeltaWorkspace, type WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
export * from "./storageJournalRecords"

const journalDatabaseName = "tincanban-workspace-state"
const legacyJournalDatabaseName = "tincanban-workspace-journal-v1"
const legacyMigrationMarkerId = "__meta__legacy-journal-migration-complete__"
const journalStores = ["changes", "proofs", "receipts", "snapshots", "authorizations", "frontiers", "deltas"] as const
type JournalStoreName = typeof journalStores[number]
type JournalIndexedStoreName = JournalStoreName

let journalDatabasePromise: Promise<IDBDatabase> | undefined
let legacyJournalDatabasePromise: Promise<IDBDatabase | undefined> | undefined

function openCurrentJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(journalDatabaseName, 3)
    let settled = false
    let blockedTimer: ReturnType<typeof setTimeout> | undefined
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return }
      const database = request.result
      for (const name of journalStores) {
        const store = database.objectStoreNames.contains(name)
          ? request.transaction!.objectStore(name) : database.createObjectStore(name, { keyPath: "id" })
        if (!store.indexNames.contains("workspaceId")) store.createIndex("workspaceId", "workspaceId", { unique: false })
        if (name === "deltas" && !store.indexNames.contains("sequence")) {
          store.createIndex("sequence", ["workspaceId", "generation", "sequence"], { unique: true })
        }
        if (name === "snapshots" && !store.indexNames.contains("catalog")) {
          store.createIndex("catalog", ["workspaceId", "title", "savedAt"], { unique: false })
        }
      }
    }
    request.onsuccess = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      if (settled) { request.result.close(); return }
      settled = true
      request.result.onversionchange = () => { request.result.close(); journalDatabasePromise = undefined }
      resolve(request.result)
    }
    request.onerror = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      settled = true
      reject(request.error ?? new Error("IndexedDB open failed"))
    }
    request.onblocked = () => {
      blockedTimer ??= setTimeout(() => {
        settled = true
        const error = new Error("Close other tincanban tabs and reload to finish the storage update. Keep your website data.")
        error.name = "WorkspaceJournalUpgradeBlockedError"
        reject(error)
      }, 1500)
    }
  })
}

type JournalRow = { id: IDBValidKey; workspaceId: string; value: Record<string, unknown> }

function legacyWorkspaceId(store: JournalStoreName, value: Record<string, unknown>, id: IDBValidKey): string | undefined {
  if (typeof value.workspaceId === "string") return value.workspaceId
  if (store === "snapshots" && typeof id === "string") return id
  if (store === "authorizations" && typeof id === "string") return id
  if (["changes", "proofs", "receipts"].includes(store) && typeof id === "string") {
    const separator = id.lastIndexOf(":")
    if (separator > 0) return id.slice(0, separator)
  }
  return undefined
}

function openLegacyJournal(): Promise<IDBDatabase | undefined> {
  return legacyJournalDatabasePromise ??= (async () => {
    if (typeof indexedDB.databases === "function") {
      const queryStartedAt = Date.now()
      console.info("[tincanban.storage] legacy-enumeration-started")
      let timeout: ReturnType<typeof setTimeout> | undefined
      let databases: IDBDatabaseInfo[]
      try {
        databases = await Promise.race([
          indexedDB.databases(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              const error = new Error("Storage enumeration did not complete")
              error.name = "LegacyJournalEnumerationTimeoutError"
              reject(error)
            }, 2000)
          }),
        ])
      } catch (error) {
        console.info("[tincanban.storage] legacy-enumeration-error", {
          name: error instanceof Error ? error.name : "UnknownError",
          elapsedMs: Date.now() - queryStartedAt,
        })
        throw error
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      const legacyDatabase = databases.find(database => database.name === legacyJournalDatabaseName)
      console.info("[tincanban.storage] legacy-enumeration-complete", {
        count: databases.length,
        exists: Boolean(legacyDatabase),
        version: legacyDatabase?.version,
        elapsedMs: Date.now() - queryStartedAt,
      })
      const exists = legacyDatabase !== undefined
      if (!exists) return undefined
    } else {
      console.info("[tincanban.storage] legacy-existence-query-unavailable")
      const error = new Error("Workspace storage could not be safely identified")
      error.name = "LegacyJournalEnumerationUnavailableError"
      throw error
    }

    return new Promise<IDBDatabase | undefined>((resolve, reject) => {
      const openStartedAt = Date.now()
      console.info("[tincanban.storage] legacy-open-started")
      const request = indexedDB.open(legacyJournalDatabaseName)
      let settled = false
      let vanishedAfterEnumeration = false
      let blockedTimer: ReturnType<typeof setTimeout> | undefined
      const settle = (error?: Error, database?: IDBDatabase) => {
        if (settled) { database?.close(); return }
        settled = true
        if (blockedTimer) clearTimeout(blockedTimer)
        if (openTimer) clearTimeout(openTimer)
        if (error) reject(error)
        else resolve(database)
      }
      const openTimer = setTimeout(() => {
        console.info("[tincanban.storage] legacy-open-timeout", { elapsedMs: Date.now() - openStartedAt })
        const error = new Error("Workspace storage open did not complete")
        error.name = "LegacyJournalOpenTimeoutError"
        settle(error)
      }, 5000)
      request.onupgradeneeded = event => {
        console.info("[tincanban.storage] legacy-open-upgrade", {
          oldVersion: event.oldVersion,
          elapsedMs: Date.now() - openStartedAt,
        })
        if (event.oldVersion === 0) {
          vanishedAfterEnumeration = true
          request.transaction?.abort()
        }
      }
      request.onsuccess = () => {
        console.info("[tincanban.storage] legacy-open-success", { elapsedMs: Date.now() - openStartedAt })
        if (settled) { request.result.close(); return }
        request.result.onversionchange = () => {
          request.result.close()
          legacyJournalDatabasePromise = undefined
        }
        settle(undefined, request.result)
      }
      request.onerror = () => {
        console.info("[tincanban.storage] legacy-open-error", {
          name: request.error?.name ?? "UnknownError",
          elapsedMs: Date.now() - openStartedAt,
        })
        if (vanishedAfterEnumeration && request.error?.name === "AbortError") {
          const error = new Error("Workspace storage changed during migration check")
          error.name = "LegacyJournalChangedDuringOpenError"
          settle(error)
        }
        else settle(request.error ?? new Error("Workspace storage could not be opened"))
      }
      request.onblocked = () => {
        console.info("[tincanban.storage] legacy-open-blocked", { elapsedMs: Date.now() - openStartedAt })
        const error = new Error("Workspace storage is busy in another tab")
        error.name = "LegacyJournalUnavailableError"
        if (blockedTimer) clearTimeout(blockedTimer)
        blockedTimer = setTimeout(() => settle(error), 1500)
      }
    })
  })().catch(error => {
    legacyJournalDatabasePromise = undefined
    throw error
  })
}

async function readLegacyRows(database: IDBDatabase): Promise<Map<JournalStoreName, JournalRow[]>> {
  const rows = new Map<JournalStoreName, JournalRow[]>()
  const existingStores = journalStores.filter(name => database.objectStoreNames.contains(name))
  if (!existingStores.length) return rows
  const transaction = database.transaction([...existingStores], "readonly")
  const completion = transactionDone(transaction)
  await Promise.all(existingStores.map(async name => {
    const storeRows = await new Promise<JournalRow[]>((resolve, reject) => {
      const result: JournalRow[] = []
      const request = transaction.objectStore(name).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) { resolve(result); return }
        if (!cursor.value || typeof cursor.value !== "object") {
          reject(new Error(`Stored ${name} record is malformed; source data was preserved`))
          return
        }
        const value = cursor.value as Record<string, unknown>
        const id = (value.id as IDBValidKey | undefined) ?? cursor.primaryKey
        const workspaceId = legacyWorkspaceId(name, value, id)
        if (workspaceId === undefined) {
          reject(new Error(`Stored ${name} record has no workspace identity; source data was preserved`))
          return
        }
        result.push({ id, workspaceId, value })
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error(`Stored ${name} scan failed`))
    })
    rows.set(name, storeRows)
  }))
  await completion
  for (const name of journalStores) if (!rows.has(name)) rows.set(name, [])
  return rows
}

function byteArraysEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

async function migrateLegacyJournal(database: IDBDatabase): Promise<void> {
  const markerRead = database.transaction("authorizations", "readonly")
  const markerReadDone = transactionDone(markerRead)
  const currentMarker = await requestResult(markerRead.objectStore("authorizations").get(legacyMigrationMarkerId))
  await markerReadDone
  if (currentMarker) return

  let legacy: IDBDatabase | undefined
  try {
    legacy = await openLegacyJournal()
    const legacyRows = legacy ? await readLegacyRows(legacy) : new Map<JournalStoreName, JournalRow[]>()
    const transaction = database.transaction([...journalStores], "readwrite")
    const completion = transactionDone(transaction)
    let migrationError: Error | undefined
    const abort = (error: Error) => {
      if (migrationError) return
      migrationError = error
      try { transaction.abort() } catch { /* Transaction already completed. */ }
    }
    const authorizations = transaction.objectStore("authorizations")
    const marker = authorizations.get(legacyMigrationMarkerId)
    marker.onerror = () => abort(marker.error ?? new Error("Storage migration marker read failed"))
    marker.onsuccess = () => {
      if (marker.result) return
      const rows = [...legacyRows].flatMap(([storeName, storeRows]) => storeRows
        .map(row => ({ storeName, row })))
      let remaining = rows.length
      const finishMigration = () => {
        if (remaining > 0) return
        authorizations.put({ id: legacyMigrationMarkerId, workspaceId: "__system__", legacyMigrationComplete: true })
      }
      if (!remaining) { finishMigration(); return }
      for (const { storeName, row } of rows) {
        const store = transaction.objectStore(storeName)
        const existing = store.get(row.id)
        existing.onerror = () => abort(existing.error ?? new Error("Workspace record read failed"))
        existing.onsuccess = () => {
          const current = existing.result as Record<string, unknown> | undefined
          const incoming: Record<string, unknown> = { ...row.value, id: row.id, workspaceId: row.workspaceId }
          if (current) {
            if (storeName === "receipts" && (current.transactionId !== incoming.transactionId ||
              (current.receipt as { changeHash?: unknown } | undefined)?.changeHash !==
              (incoming.receipt as { changeHash?: unknown } | undefined)?.changeHash)) {
              abort(new Error("Workspace receipt conflicts with committed data"))
              return
            }
            if (storeName === "changes" && !byteArraysEqual(current.bytes, incoming.bytes)) {
              abort(new Error("Workspace change conflicts with committed data"))
              return
            }
          } else {
            store.put(incoming)
          }
          remaining -= 1
          finishMigration()
        }
      }
    }
    try { await completion }
    catch (error) { throw migrationError ?? error }
  } finally {
    legacy?.close()
    legacyJournalDatabasePromise = undefined
  }
}

function openJournalDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available"))
  return journalDatabasePromise ??= openCurrentJournal().then(async database => {
    try {
      await migrateLegacyJournal(database)
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }).catch(error => {
    journalDatabasePromise = undefined
    throw error
  })
}

export async function openWorkspaceJournal(): Promise<IDBDatabase> {
  return openJournalDatabase()
}

export async function recordsForWorkspace<T>(
  database: IDBDatabase,
  storeName: JournalIndexedStoreName,
  workspaceId: string
): Promise<T[]> {
  const transaction = database.transaction(storeName, "readonly")
  const completion = transactionDone(transaction)
  const records = await requestResult(
    transaction.objectStore(storeName).index("workspaceId").getAll(workspaceId),
  ) as T[]
  await completion
  return records
}

export async function deleteWorkspaceJournal(workspaceId: string): Promise<void> {
  clearLocalJournal(workspaceId)
  if (typeof indexedDB === "undefined") {
    return
  }
  const database = await openJournalDatabase()
  const transaction = database.transaction([...journalStores], "readwrite")
  const completion = transactionDone(transaction)
  for (const name of journalStores) {
    const store = transaction.objectStore(name)
    const keys = await requestResult(store.index("workspaceId").getAllKeys(workspaceId))
    for (const key of keys) {
      if (name === "authorizations" && key === legacyMigrationMarkerId) continue
      store.delete(key)
    }
  }
  await completion
}

export async function readWorkspaceSnapshot(workspaceId: string): Promise<StoredWorkspaceSnapshot | undefined> {
  const journal = new WorkspaceDeltaJournal(typeof indexedDB === "undefined" ? undefined : await openWorkspaceJournal())
  const frontier = await journal.readFrontier(workspaceId)
  if (frontier?.revision) {
    const saved = await journal.read(workspaceId)
    return saved ? materializeDeltaWorkspace(saved) : undefined
  }
  return readWorkspaceBasisSnapshot(workspaceId)
}

export async function readWorkspaceBasisSnapshot(workspaceId: string): Promise<StoredWorkspaceSnapshot | undefined> {
  if (typeof indexedDB === "undefined") return readLocalJournal(workspaceId).snapshot
  const database = await openWorkspaceJournal()
  const transaction = database.transaction("snapshots", "readonly")
  const completion = transactionDone(transaction)
  const snapshot = await requestResult(transaction.objectStore("snapshots").get(workspaceId)) as StoredWorkspaceSnapshot | undefined
  await completion
  return snapshot
}

export async function readWorkspaceDeltaAuthorizations(workspaceId: string): Promise<unknown[]> {
  if (typeof indexedDB === "undefined") {
    const journal = readLocalJournalReference(workspaceId)
    return (journal.deltas ?? []).filter(delta => delta.generation === journal.frontier?.generation).flatMap(delta => delta.command.authorizations)
  }
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(["frontiers", "deltas"], "readonly")
  const done = transactionDone(transaction)
  const [frontier, deltas] = await Promise.all([
    requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
    requestResult(transaction.objectStore("deltas").index("workspaceId").getAll(workspaceId)) as Promise<Array<{ generation: string; command: { authorizations: unknown[] } }>>,
  ])
  await done
  return deltas.filter(delta => delta.generation === frontier?.generation).flatMap(delta => delta.command.authorizations)
}

export type CommittedWorkspaceMeta = { id: string; title: string; updatedAt: string; archivedAt?: string | null }

export async function listCommittedWorkspaces(): Promise<CommittedWorkspaceMeta[]> {
  if (typeof indexedDB === "undefined") return [...localJournalEntries()].flatMap(journal => {
    const saved = journal.frontier ?? journal.snapshot
    return saved ? [{ id: saved.workspaceId, title: saved.title, updatedAt: saved.savedAt, archivedAt: saved.archivedAt }] : []
  })
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(["snapshots", "frontiers"], "readonly")
  const completion = transactionDone(transaction)
  const results: CommittedWorkspaceMeta[] = []
  const frontiers = requestResult(transaction.objectStore("frontiers").getAll()) as Promise<WorkspaceDeltaFrontier[]>
  const snapshots = transaction.objectStore("snapshots")
  const indexed = snapshots.indexNames.contains("catalog")
  // Older databases lack this index. Read their rows without an upgrade that
  // another open tab could block; indexed databases avoid cloning document bytes.
  const request = indexed ? snapshots.index("catalog").openKeyCursor() : snapshots.openCursor()
  const scanned = new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      const [id, title, updatedAt] = indexed
        ? cursor.key as string[]
        : (() => {
          const row = (cursor as IDBCursorWithValue).value as StoredWorkspaceSnapshot
          return [row.workspaceId, row.title, row.savedAt]
        })()
      if (typeof id !== "string" || typeof title !== "string" || typeof updatedAt !== "string") {
        reject(new Error(`Stored workspace catalog record ${String(cursor.primaryKey)} is invalid`))
        return
      }
      results.push({ id, title, updatedAt })
      cursor.continue()
    }
    request.onerror = () => reject(request.error ?? new Error("Workspace catalog read failed"))
  })
  await Promise.all([scanned, completion])
  const latest = new Map((await frontiers).map(frontier => [frontier.workspaceId, frontier]))
  return results.map(result => {
    const frontier = latest.get(result.id)
    return frontier ? { id: result.id, title: frontier.title, updatedAt: frontier.savedAt, archivedAt: frontier.archivedAt } : result
  })
}
