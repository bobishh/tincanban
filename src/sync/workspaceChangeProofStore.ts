import { openWorkspaceJournal, readLocalJournalReference, readWorkspaceDeltaAuthorizations, writeLocalJournal, readLocalJournal,
  withLocalJournalLock, advanceWorkspaceRevision, requestResult, transactionDone } from "../storageJournal"
import { canonicalizeJson } from "../domain/identity"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./workspaceAuthorizationRecords"
export { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./workspaceAuthorizationRecords"

let dbPromise: Promise<IDBDatabase> | undefined

function database() {
  return dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tincanban-write-authorizations-v1")
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records")
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function legacyRecords(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  if (typeof indexedDB === "undefined") return []
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction("records").objectStore("records").get(workspaceId)
    request.onsuccess = () => resolve(request.result ?? [])
    request.onerror = () => reject(request.error)
  })
}

export async function records(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  return mergeAuthorizationRecords(await basisRecords(workspaceId), await readWorkspaceDeltaAuthorizations(workspaceId) as WorkspaceChangeAuthorization[])
}

export async function basisRecords(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  if (typeof indexedDB === "undefined") return (readLocalJournalReference(workspaceId).authorizations ?? []) as WorkspaceChangeAuthorization[]
  const db = await openWorkspaceJournal()
  const transaction = db.transaction("authorizations", "readonly")
  const completion = transactionDone(transaction)
  const stored = await requestResult(transaction.objectStore("authorizations").get(workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
  await completion
  return stored?.records ?? legacyRecords(workspaceId)
}

export async function putRecords(workspaceId: string, incoming: WorkspaceChangeAuthorization[]): Promise<boolean> {
  const previous = await records(workspaceId)
  if (typeof indexedDB === "undefined") return withLocalJournalLock(workspaceId, async () => {
    const journal = readLocalJournal(workspaceId)
    const existing = mergeAuthorizationRecords(previous, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
    const next = mergeAuthorizationRecords(existing, incoming)
    const changed = canonicalizeJson(existing) !== canonicalizeJson(next)
    if (!changed) return false
    journal.authorizations = next
    writeLocalJournal(workspaceId, journal)
    return changed
  })
  const db = await openWorkspaceJournal()
  return new Promise<boolean>((resolve, reject) => {
    let changed = false
    const transaction = db.transaction(["authorizations", "frontiers", "revisions"], "readwrite")
    const store = transaction.objectStore("authorizations")
    const get = store.get(workspaceId)
    get.onsuccess = () => {
      try {
        const existing = mergeAuthorizationRecords(previous, get.result?.records ?? [])
        const next = mergeAuthorizationRecords(existing, incoming)
        changed = canonicalizeJson(existing) !== canonicalizeJson(next)
        if (!get.result || changed) store.put({ id: workspaceId, workspaceId, records: next })
        if (changed) {
          advanceWorkspaceRevision(transaction, workspaceId)
          const frontiers = transaction.objectStore("frontiers")
          const frontier = frontiers.get(workspaceId)
          frontier.onsuccess = () => { if (frontier.result) frontiers.put({ ...frontier.result, invalidated: true }) }
        }
      } catch (error) { transaction.abort(); reject(error) }
    }
    transaction.oncomplete = () => resolve(changed)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
