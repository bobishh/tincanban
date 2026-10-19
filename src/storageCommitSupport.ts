import * as Automerge from "@automerge/automerge/slim"
import type { ChangeProof, TransactionReceipt, WorkspaceDocumentV2 } from "./domain/model"
import { toBase64Url } from "./domain/identity"
import { canonicalizeJson } from "./domain/identityCrypto"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./product-replica/workspaceAuthorizationRecords"
import {
  advanceHistoryProgress,
  advanceLocalHistoryProgress,
  advanceWorkspaceRevision,
  HISTORY_ACTIVE_BYTE_LIMIT,
  HISTORY_ACTIVE_CHANGE_LIMIT,
  openWorkspaceJournal,
  readLocalJournal,
  requestResult,
  transactionDone,
  withLocalJournalLock,
  writeLocalJournal,
  type StoredHistoryProgress,
  type StoredChange,
  type StoredReceiptRecord,
  type StoredWorkspaceSnapshot,
} from "./storageJournal"
import type { WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"

export type WorkspaceCommitCommand = { receipt: TransactionReceipt; changeBytes: Uint8Array; proof: ChangeProof }

export class WorkspaceRevisionConflict extends Error {
  readonly code = "workspace_revision_conflict"
  constructor() {
    super("Workspace changed during admission. Reload and retry.")
    this.name = "WorkspaceRevisionConflict"
  }
}

export type WorkspaceRevisionBasis = {
  revision: string | null
  frontier: WorkspaceDeltaFrontier | null
  baselineId: string | null
}

export function activeHistoryDifference(previous: Pick<StoredWorkspaceSnapshot, "heads" | "bytes"> | null, doc: Automerge.Doc<WorkspaceDocumentV2>, heads: string[]) {
  if (!previous || previous.heads.join() === heads.join()) return { activeTailChanges: 0, activeTailBytes: 0 }
  const priorDocument = Automerge.load<WorkspaceDocumentV2>(previous.bytes)
  try {
    const changes = Automerge.getChanges(priorDocument, doc)
    return { activeTailChanges: changes.length, activeTailBytes: changes.reduce((total, change) => total + change.byteLength, 0) }
  } finally { Automerge.free(priorDocument) }
}

export function appendLocalWorkspaceCommand(journal: ReturnType<typeof readLocalJournal>, workspaceId: string,
  savedAt: string, command?: WorkspaceCommitCommand) {
  if (!command) return
  const { receipt, changeBytes, proof } = command
  const saved = journal.receipts[receipt.transactionId]
  if (saved && saved.changeHash !== receipt.changeHash) throw new Error("Transaction ID conflicts with a committed change")
  if (saved) return
  journal.changes.push({ workspaceId, changeHash: receipt.changeHash, bytesBase64: toBase64Url(changeBytes), addedAt: savedAt })
  journal.proofs[receipt.changeHash] = proof
  journal.receipts[receipt.transactionId] = receipt
}

export async function appendWorkspaceCommand(transaction: IDBTransaction, workspaceId: string,
  savedAt: string, command?: WorkspaceCommitCommand) {
  if (!command) return
  const { receipt, changeBytes, proof } = command
  const receiptKey = `${workspaceId}:${receipt.transactionId}`
  const existingReceipt = await requestResult(transaction.objectStore("receipts").get(receiptKey)) as StoredReceiptRecord | undefined
  if (existingReceipt && existingReceipt.receipt.changeHash !== receipt.changeHash) throw new Error("Transaction ID conflicts with a committed change")
  if (existingReceipt) return
  const changeKey = `${workspaceId}:${receipt.changeHash}`
  transaction.objectStore("changes").put({ id: changeKey, workspaceId, changeHash: receipt.changeHash, bytes: new Uint8Array(changeBytes), addedAt: savedAt })
  transaction.objectStore("proofs").put({ id: changeKey, workspaceId, changeHash: receipt.changeHash, proof })
  transaction.objectStore("receipts").put({ id: receiptKey, workspaceId, transactionId: receipt.transactionId, receipt })
}

export async function persistWorkspaceLocally(
  workspaceId: string,
  snapshot: StoredWorkspaceSnapshot,
  previous: StoredWorkspaceSnapshot | undefined,
  previousProofs: WorkspaceChangeAuthorization[],
  authorizations: WorkspaceChangeAuthorization[],
  command: WorkspaceCommitCommand | undefined,
  activeTailChanges: number,
  activeTailBytes: number,
  expectedBasis: WorkspaceRevisionBasis,
  compactChangeHashes: string[] = [],
  ensureContextCurrent: () => void,
): Promise<boolean> {
  return withLocalJournalLock(workspaceId, async () => {
    ensureContextCurrent()
    const journal = readLocalJournal(workspaceId)
    if ((journal.revision ?? null) !== expectedBasis.revision ||
        canonicalizeJson(journal.frontier ?? null) !== canonicalizeJson(expectedBasis.frontier) ||
        (journal.snapshot?.receivedHistory?.baselineId ?? null) !== expectedBasis.baselineId) {
      throw new WorkspaceRevisionConflict()
    }
    const existing = mergeAuthorizationRecords(previousProofs, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
    const next = mergeAuthorizationRecords(existing, authorizations)
    const proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
    journal.snapshot = snapshot
    journal.frontier = undefined
    journal.deltas = []
    journal.authorizations = next
    appendLocalWorkspaceCommand(journal, workspaceId, snapshot.savedAt, command)
    if (compactChangeHashes.length) {
      const included = new Set(compactChangeHashes)
      journal.changes = journal.changes.filter(change => !included.has(change.changeHash))
    }
    const progressBaselineId = previous?.receivedHistory?.baselineId ?? journal.historyProgress?.baselineId
    if (progressBaselineId !== undefined && !journal.frontier) {
      advanceLocalHistoryProgress(journal, workspaceId, progressBaselineId, activeTailChanges, activeTailBytes)
    }
    journal.revision = crypto.randomUUID()
    writeLocalJournal(workspaceId, journal)
    return proofChanged
  })
}

function shouldWriteSnapshot(
  existing: StoredWorkspaceSnapshot | undefined,
  snapshot: StoredWorkspaceSnapshot,
  causalChanged: boolean,
  checkpointChanged: boolean,
): boolean {
  return !existing || existing.heads.join() !== snapshot.heads.join() || causalChanged || checkpointChanged
}

function advanceCommitHistory(
  transaction: IDBTransaction,
  workspaceId: string,
  existingSnapshot: StoredWorkspaceSnapshot | undefined,
  progress: StoredHistoryProgress | undefined,
  previous: StoredWorkspaceSnapshot | undefined,
  existingFrontier: WorkspaceDeltaFrontier | undefined,
  activeTailChanges: number,
  activeTailBytes: number,
): void {
  const progressBaselineId = existingSnapshot?.receivedHistory?.baselineId ?? progress?.baselineId
  if (progressBaselineId === undefined || existingFrontier) return
  const concurrentSnapshot = Boolean(previous && existingSnapshot &&
    existingSnapshot.heads.slice().sort().join() !== previous.heads.slice().sort().join())
  advanceHistoryProgress(transaction, workspaceId, progressBaselineId,
    concurrentSnapshot ? HISTORY_ACTIVE_CHANGE_LIMIT : activeTailChanges,
    concurrentSnapshot ? HISTORY_ACTIVE_BYTE_LIMIT : activeTailBytes)
}

export async function persistWorkspaceInIndexedDb(
  workspaceId: string,
  snapshot: StoredWorkspaceSnapshot,
  previous: StoredWorkspaceSnapshot | undefined,
  previousProofs: WorkspaceChangeAuthorization[],
  authorizations: WorkspaceChangeAuthorization[],
  command: WorkspaceCommitCommand | undefined,
  causalChanged: boolean,
  checkpointChanged: boolean,
  activeTailChanges: number,
  activeTailBytes: number,
  expectedBasis: WorkspaceRevisionBasis,
  compactChangeHashes: string[],
  ensureContextCurrent: () => void,
  clearDeltaRows: (transaction: IDBTransaction, workspaceId: string) => Promise<void>,
  onPhase?: (phase: string) => void,
): Promise<boolean> {
  onPhase?.("journal-open")
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(["snapshots", "authorizations", "changes", "proofs", "receipts", "frontiers", "deltas", "revisions", "historyProgress"], "readwrite")
  const completion = transactionDone(transaction)
  let proofChanged: boolean
  try {
    const snapshotStore = transaction.objectStore("snapshots")
    onPhase?.("transaction-read")
    const existingSnapshot = await requestResult(snapshotStore.get(workspaceId)) as StoredWorkspaceSnapshot | undefined
    const [existingFrontier, progress, revision] = await Promise.all([
      requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
      requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as Promise<StoredHistoryProgress | undefined>,
      requestResult(transaction.objectStore("revisions").get(workspaceId)) as Promise<{ revision: string } | undefined>,
    ])
    ensureContextCurrent()
    if ((revision?.revision ?? null) !== expectedBasis.revision ||
        canonicalizeJson(existingFrontier ?? null) !== canonicalizeJson(expectedBasis.frontier) ||
        (existingSnapshot?.receivedHistory?.baselineId ?? null) !== expectedBasis.baselineId) {
      throw new WorkspaceRevisionConflict()
    }
    const proofStore = transaction.objectStore("authorizations")
    const stored = await requestResult(proofStore.get(workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
    const existing = mergeAuthorizationRecords(previousProofs, stored?.records ?? [])
    const next = mergeAuthorizationRecords(existing, authorizations)
    proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
    onPhase?.("transaction-write")
    if (shouldWriteSnapshot(existingSnapshot, snapshot, causalChanged, checkpointChanged)) snapshotStore.put(snapshot)
    advanceCommitHistory(transaction, workspaceId, existingSnapshot, progress, previous, existingFrontier,
      activeTailChanges, activeTailBytes)
    if (!stored || proofChanged) proofStore.put({ id: workspaceId, workspaceId, records: next })
    await clearDeltaRows(transaction, workspaceId)
    if (compactChangeHashes.length) {
      const included = new Set(compactChangeHashes)
      const changeStore = transaction.objectStore("changes")
      const changes = await requestResult(changeStore.index("workspaceId").getAll(workspaceId)) as Array<StoredChange & { id: string }>
      for (const change of changes) if (included.has(change.changeHash)) changeStore.delete(change.id)
    }
    advanceWorkspaceRevision(transaction, workspaceId)
    await appendWorkspaceCommand(transaction, workspaceId, snapshot.savedAt, command)
  } catch (error) {
    transaction.abort()
    await completion.catch(() => undefined)
    throw error
  }
  onPhase?.("transaction-complete")
  await completion
  return proofChanged
}
