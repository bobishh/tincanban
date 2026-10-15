import type { WorkspaceDeltaFrontier, StoredWorkspaceDelta } from "./workspaceDeltaJournal"
import type { ChangeProof, TransactionReceipt } from "./domain/model"
import type { WorkspaceAdmissionCheckpoint } from "./sync/workspaceAdmissionCheckpoint"

export type StoredChange = {
  workspaceId: string
  changeHash: string
  bytes: Uint8Array
  addedAt: string
}

/** Exact source changes retained after their bytes leave the active journal. */
export type StoredArchivedChange = StoredChange & {
  id: string
  archivedUnderBaselineId: string
}

/** Original signed authorization material retained outside the active proof set. */
export type StoredArchivedAuthorizations = {
  id: string
  workspaceId: string
  baselineId: string
  records: unknown[]
}

export type StoredProofRecord = { id: string; workspaceId: string; changeHash: string; proof: ChangeProof }
export type StoredReceiptRecord = {
  id: string
  workspaceId: string
  transactionId: string
  receipt: TransactionReceipt
}

/** Small local-only counter for changes after the currently active compact basis. */
export type StoredHistoryProgress = {
  id: string
  workspaceId: string
  baselineId: string | null
  admittedChanges: number
  encodedBytes: number
  transitionId?: string
  transitionPreviousBaselineId?: string | null
}

export const HISTORY_ACTIVE_CHANGE_LIMIT = 512
export const HISTORY_ACTIVE_BYTE_LIMIT = 4 * 1024 * 1024

export function advanceHistoryProgress(transaction: IDBTransaction, workspaceId: string, baselineId: string | null,
  changeCount: number, encodedBytes: number) {
  if (!changeCount && !encodedBytes) return
  const store = transaction.objectStore("historyProgress")
  const request = store.get(workspaceId)
  request.onsuccess = () => {
    const current = request.result as StoredHistoryProgress | undefined
    // Missing or mismatched progress means the active tail is unknown. Saturate
    // the counter so the owner takes the safe compaction path instead of undercounting.
    const sameBasis = current?.baselineId === baselineId && Number.isSafeInteger(current.admittedChanges) &&
      Number.isSafeInteger(current.encodedBytes) && current.admittedChanges >= 0 && current.encodedBytes >= 0
    store.put({ id: workspaceId, workspaceId, baselineId,
      admittedChanges: Math.min(HISTORY_ACTIVE_CHANGE_LIMIT, (sameBasis ? current.admittedChanges : HISTORY_ACTIVE_CHANGE_LIMIT) + changeCount),
      encodedBytes: Math.min(HISTORY_ACTIVE_BYTE_LIMIT, (sameBasis ? current.encodedBytes : HISTORY_ACTIVE_BYTE_LIMIT) + encodedBytes),
      ...(sameBasis && current.transitionId ? { transitionId: current.transitionId,
        transitionPreviousBaselineId: current.transitionPreviousBaselineId } : {}) })
  }
}

export function advanceLocalHistoryProgress(journal: LocalJournal, workspaceId: string, baselineId: string | null,
  changeCount: number, encodedBytes: number) {
  if (!changeCount && !encodedBytes) return
  const current = journal.historyProgress
  const sameBasis = current?.workspaceId === workspaceId && current.baselineId === baselineId &&
    Number.isSafeInteger(current.admittedChanges) && Number.isSafeInteger(current.encodedBytes) &&
    current.admittedChanges >= 0 && current.encodedBytes >= 0
  journal.historyProgress = { id: workspaceId, workspaceId, baselineId,
    admittedChanges: Math.min(HISTORY_ACTIVE_CHANGE_LIMIT, (sameBasis ? current.admittedChanges : HISTORY_ACTIVE_CHANGE_LIMIT) + changeCount),
    encodedBytes: Math.min(HISTORY_ACTIVE_BYTE_LIMIT, (sameBasis ? current.encodedBytes : HISTORY_ACTIVE_BYTE_LIMIT) + encodedBytes),
    ...(sameBasis && current.transitionId ? { transitionId: current.transitionId,
      transitionPreviousBaselineId: current.transitionPreviousBaselineId } : {}) }
}

export type LocalJournal = {
  changes: Array<{ workspaceId: string; changeHash: string; bytesBase64: string; addedAt: string }>
  archivedChanges?: StoredArchivedChange[]
  proofs: Record<string, ChangeProof>
  receipts: Record<string, TransactionReceipt>
  snapshot?: StoredWorkspaceSnapshot
  authorizations?: unknown[]
  archivedAuthorizations?: StoredArchivedAuthorizations[]
  frontier?: WorkspaceDeltaFrontier
  deltas?: StoredWorkspaceDelta[]
  revision?: string
  historyProgress?: StoredHistoryProgress
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
  /** Local-only cold history basis pointer. The source and prior local snapshot stay in the history archive row. */
  receivedHistory?: { baselineId: string; excludedLocalChangeHashes: string[] }
  savedAt: string
}

export type StoredReceivedHistoryBaseline = {
  id: string
  workspaceId: string
  stageId: string
  state: "staged" | "active" | "restored"
  previousBaselineId?: string
  signedJson: Uint8Array
  document: Uint8Array
  /** Public routing only; encrypted basis ciphertext remains in encryptedObjects. */
  wire?: unknown
  /** Exact encrypted archive objects retained for offline Native re-verification. */
  encryptedObjects: Array<{ ciphertextId: string; object: unknown }>
  /** Bounded plaintext proof objects from an authenticated peer bootstrap. This proves public owner authority, not ciphertext correspondence. */
  peerProofs?: { version: 1; objects: Array<{ objectId: string; bytes: Uint8Array }> }
  scopeId: string
  keyEpoch: number
  pinnedStorage: Record<string, unknown>
  expectedSnapshot: StoredWorkspaceSnapshot | null
  expectedWorkspaceRevision?: string
  expectedFrontier?: unknown
  priorSnapshot?: StoredWorkspaceSnapshot | null
  priorFrontier?: unknown
  priorHistoryProgress?: StoredHistoryProgress
  controlJson?: Uint8Array
  baselineId?: string
  activatedAt?: string
  /** Exact local CAS boundary for reversible activation before any subsequent tail write. */
  activationRevision?: string
  activatedSnapshotMetadata?: Omit<StoredWorkspaceSnapshot, "bytes">
  createdAt: string
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
  saved.revision = crypto.randomUUID()
  if (saved.frontier) saved.frontier.invalidated = true
  memoryJournals.set(workspaceId, saved)
}

/** Advance only inside a transaction that changes durable history or evidence. */
export function advanceWorkspaceRevision(transaction: IDBTransaction, workspaceId: string) {
  transaction.objectStore("revisions").put({ id: workspaceId, workspaceId, revision: crypto.randomUUID() })
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
