import type { WorkspaceDeltaFrontier, StoredWorkspaceDelta } from "./workspaceDeltaJournal"
import type { ChangeProof, TransactionReceipt } from "./domain/model"
import type { WorkspaceAdmissionCheckpoint } from "./sync/workspaceAdmissionCheckpoint"

export type StoredChange = {
  workspaceId: string
  changeHash: string
  bytes: Uint8Array
  addedAt: string
}

export type StoredProofRecord = { id: string; workspaceId: string; changeHash: string; proof: ChangeProof }
export type StoredReceiptRecord = {
  id: string
  workspaceId: string
  transactionId: string
  receipt: TransactionReceipt
}

export type LocalJournal = {
  changes: Array<{ workspaceId: string; changeHash: string; bytesBase64: string; addedAt: string }>
  proofs: Record<string, ChangeProof>
  receipts: Record<string, TransactionReceipt>
  snapshot?: StoredWorkspaceSnapshot
  authorizations?: unknown[]
  frontier?: WorkspaceDeltaFrontier
  deltas?: StoredWorkspaceDelta[]
}

type CausalChangeDecision = {
  hash: string
  status: { type: "admitted"; role: "owner" | "editor" | "visitor" | "automation" }
    | { type: "quarantined" | "pending"; reason: string }
}

export type StoredCausalEvidence = {
  bytes: Uint8Array
  decisions: CausalChangeDecision[]
  authorizationEvidence?: unknown[]
  /** Bound to the raw evidence and admitted projection in this atomic local commit. */
  admissionCheckpoint?: WorkspaceAdmissionCheckpoint
  /** Local presentation state; never changes a decision's admission status. */
  dismissedHashes?: string[]
  /** Links a quarantined source to one durable, locally authorized replacement change. */
  resolvedReviews?: Array<{ sourceHash: string; authorizedChangeHash: string }>
}

export type StoredWorkspaceSnapshot = {
  id: string
  workspaceId: string
  title: string
  archivedAt?: string | null
  heads: string[]
  bytes: Uint8Array
  causalEvidence?: StoredCausalEvidence
  savedAt: string
}


const localJournalQueues = new Map<string, Promise<unknown>>()
const memoryJournals = new Map<string, LocalJournal>()

export function localJournalEntries() { return memoryJournals.values() }
export function clearLocalJournal(workspaceId: string) { memoryJournals.delete(workspaceId) }
export function readLocalJournalReference(workspaceId: string): Readonly<LocalJournal> {
  return memoryJournals.get(workspaceId) ?? { changes: [], proofs: {}, receipts: {} }
}
export function updateLocalJournal(workspaceId: string, update: (current: Readonly<LocalJournal>) => LocalJournal) {
  const next = update(readLocalJournalReference(workspaceId))
  memoryJournals.set(workspaceId, next)
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
  })
}

export function readLocalJournal(workspaceId: string): LocalJournal {
  return structuredClone(memoryJournals.get(workspaceId) ?? { changes: [], proofs: {}, receipts: {} })
}

export function writeLocalJournal(workspaceId: string, journal: LocalJournal): void {
  const saved = structuredClone(journal)
  if (saved.frontier) saved.frontier.invalidated = true
  memoryJournals.set(workspaceId, saved)
}

export function withLocalJournalLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localJournalQueues.get(workspaceId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  localJournalQueues.set(workspaceId, current)
  void current.then(() => {
    if (localJournalQueues.get(workspaceId) === current) localJournalQueues.delete(workspaceId)
  }, () => {
    if (localJournalQueues.get(workspaceId) === current) localJournalQueues.delete(workspaceId)
  })
  return current
}
