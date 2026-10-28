import { clearLocalJournal, localJournalEntries, readLocalJournal, readLocalJournalReference, requestResult, transactionDone,
  type StoredWorkspaceSnapshot } from "./storageJournalRecords"
import { WorkspaceDeltaJournal, materializeDeltaWorkspace, type WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
export * from "./storageJournalRecords"

const journalDatabaseName = "tincanban-workspace-state"
const journalStores = ["changes", "archivedChanges", "proofs", "receipts", "snapshots", "authorizations", "archivedAuthorizations", "frontiers", "deltas", "revisions", "receivedBaselines", "historyProgress"] as const
type JournalStoreName = typeof journalStores[number]
type JournalIndexedStoreName = JournalStoreName

let journalDatabasePromise: Promise<IDBDatabase> | undefined

function openCurrentJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(journalDatabaseName, 7)
    let settled = false
    let blockedTimer: ReturnType<typeof setTimeout> | undefined
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return }
      const database = request.result
      for (const name of journalStores) {
        const store = database.objectStoreNames.contains(name)
          ? request.transaction!.objectStore(name) : database.createObjectStore(name, { keyPath: "id" })
        if (!store.indexNames.contains("workspaceId")) store.createIndex("workspaceId", "workspaceId", { unique: false })
        if (name === "archivedChanges" && !store.indexNames.contains("activeBaseline")) {
          store.createIndex("activeBaseline", ["workspaceId", "archivedUnderBaselineId"], { unique: false })
        }
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
      if (settled) { request.result.close(); journalDatabasePromise = undefined; return }
      settled = true
      request.result.onversionchange = () => { request.result.close(); journalDatabasePromise = undefined }
      request.result.onclose = () => { journalDatabasePromise = undefined }
      resolve(request.result)
    }
    request.onerror = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      if (settled) journalDatabasePromise = undefined
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

function openJournalDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available"))
  return journalDatabasePromise ??= openCurrentJournal().catch(error => {
    // A refused upgrade remains queued until its blocking tab closes. Reuse
    // that refusal rather than queueing a retry behind the abandoned request.
    if (!(error instanceof Error && error.name === "WorkspaceJournalUpgradeBlockedError")) journalDatabasePromise = undefined
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
    const frontier = journal.frontier
    return frontier ? (journal.deltas ?? []).filter(delta => delta.generation === frontier.generation &&
      delta.sequence <= frontier.revision).flatMap(delta => delta.command.authorizations) : []
  }
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(["frontiers", "deltas"], "readonly")
  const done = transactionDone(transaction)
  const frontier = await requestResult(transaction.objectStore("frontiers").get(workspaceId)) as WorkspaceDeltaFrontier | undefined
  const deltas = frontier ? await requestResult(transaction.objectStore("deltas").index("sequence").getAll(
    IDBKeyRange.bound([workspaceId, frontier.generation, 0], [workspaceId, frontier.generation, frontier.revision]),
  )) as Array<{ generation: string; sequence: number; command: { authorizations: unknown[] } }> : []
  await done
  return deltas.flatMap(delta => delta.command.authorizations)
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
  const request = snapshots.index("catalog").openKeyCursor()
  const scanned = new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      const [id, title, updatedAt] = cursor.key as string[]
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
