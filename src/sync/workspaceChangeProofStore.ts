import { openWorkspaceJournal, readLocalJournalReference, readWorkspaceDeltaAuthorizations, writeLocalJournal, readLocalJournal,
  withLocalJournalLock, advanceWorkspaceRevision, requestResult, transactionDone } from "../storageJournal"
import { canonicalizeJson } from "../domain/identityCrypto"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "../product-replica"
import type { WorkspaceDeltaFrontier } from "../workspaceDeltaJournal"
import { withWorkspaceMutation } from "../workspaceMutation"
export { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "../product-replica"

type WorkspaceAuthorizationRow = {
  id: string
  workspaceId: string
  records: WorkspaceChangeAuthorization[]
}

function authorizationRowRequest(store: IDBObjectStore, workspaceId: string): IDBRequest<WorkspaceAuthorizationRow | undefined> {
  return store.get(workspaceId) as IDBRequest<WorkspaceAuthorizationRow | undefined>
}

export async function records(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  return mergeAuthorizationRecords(await basisRecords(workspaceId), await readWorkspaceDeltaAuthorizations(workspaceId) as WorkspaceChangeAuthorization[])
}

export async function basisRecords(workspaceId: string): Promise<WorkspaceChangeAuthorization[]> {
  if (typeof indexedDB === "undefined") return (readLocalJournalReference(workspaceId).authorizations ?? []) as WorkspaceChangeAuthorization[]
  const db = await openWorkspaceJournal()
  const transaction = db.transaction("authorizations", "readonly")
  const completion = transactionDone(transaction)
  const stored = await requestResult(authorizationRowRequest(transaction.objectStore("authorizations"), workspaceId))
  await completion
  return stored?.records ?? []
}

export async function putRecords(workspaceId: string, incoming: WorkspaceChangeAuthorization[]): Promise<boolean> {
  return withWorkspaceMutation(workspaceId, () => putRecordsLocked(workspaceId, incoming))
}

async function putRecordsLocked(workspaceId: string, incoming: WorkspaceChangeAuthorization[]): Promise<boolean> {
  const previous = await records(workspaceId)
  if (typeof indexedDB === "undefined") return withLocalJournalLock(workspaceId, async () => {
    const journal = readLocalJournal(workspaceId)
    const existing = mergeAuthorizationRecords(previous, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
    const next = mergeAuthorizationRecords(existing, incoming)
    const changed = canonicalizeJson(existing) !== canonicalizeJson(next)
    if (!changed) return false
    journal.authorizations = next
    journal.revision = crypto.randomUUID()
    if (journal.frontier) journal.frontier = { ...journal.frontier, invalidated: true }
    writeLocalJournal(workspaceId, journal)
    return changed
  })
  const db = await openWorkspaceJournal()
  return new Promise<boolean>((resolve, reject) => {
    let changed = false
    const transaction = db.transaction(["authorizations", "frontiers", "revisions"], "readwrite")
    const store = transaction.objectStore("authorizations")
    const get = authorizationRowRequest(store, workspaceId)
    get.onsuccess = () => {
      try {
        const existing = mergeAuthorizationRecords(previous, get.result?.records ?? [])
        const next = mergeAuthorizationRecords(existing, incoming)
        changed = canonicalizeJson(existing) !== canonicalizeJson(next)
        if (!get.result || changed) store.put({ id: workspaceId, workspaceId, records: next })
        if (changed) {
          advanceWorkspaceRevision(transaction, workspaceId)
          const frontiers = transaction.objectStore("frontiers")
          const frontier = frontiers.get(workspaceId) as IDBRequest<WorkspaceDeltaFrontier | undefined>
          frontier.onsuccess = () => { if (frontier.result) frontiers.put({ ...frontier.result, invalidated: true }) }
        }
      } catch (error) { transaction.abort(); reject(error) }
    }
    transaction.oncomplete = () => resolve(changed)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
