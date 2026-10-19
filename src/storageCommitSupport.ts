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

function appendLocalWorkspaceCommand(journal: ReturnType<typeof readLocalJournal>, workspaceId: string,
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

async function appendWorkspaceCommand(transaction: IDBTransaction, workspaceId: string,
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
    return commitWorkspaceLocally(workspaceId, readLocalJournal(workspaceId), snapshot, previous,
      previousProofs, authorizations, command, activeTailChanges, activeTailBytes, expectedBasis, compactChangeHashes)
  })
}

function commitWorkspaceLocally(
  workspaceId: string, journal: ReturnType<typeof readLocalJournal>, snapshot: StoredWorkspaceSnapshot,
  previous: StoredWorkspaceSnapshot | undefined, previousProofs: WorkspaceChangeAuthorization[],
  authorizations: WorkspaceChangeAuthorization[], command: WorkspaceCommitCommand | undefined,
  activeTailChanges: number, activeTailBytes: number, expectedBasis: WorkspaceRevisionBasis,
  compactChangeHashes: string[],
): boolean {
  assertLocalWorkspaceBasis(journal, expectedBasis)
  const existing = mergeAuthorizationRecords(previousProofs, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
  const next = mergeAuthorizationRecords(existing, authorizations)
  const proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
  journal.snapshot = snapshot
  journal.frontier = undefined
  journal.deltas = []
  journal.authorizations = next
  appendLocalWorkspaceCommand(journal, workspaceId, snapshot.savedAt, command)
  removeCompactedChanges(journal, compactChangeHashes)
  advanceLocalWorkspaceHistory(journal, workspaceId, previous, activeTailChanges, activeTailBytes)
  journal.revision = crypto.randomUUID()
  writeLocalJournal(workspaceId, journal)
  return proofChanged
}

function assertLocalWorkspaceBasis(journal: ReturnType<typeof readLocalJournal>, expected: WorkspaceRevisionBasis): void {
  const sameRevision = (journal.revision ?? null) === expected.revision
  const sameFrontier = canonicalizeJson(journal.frontier ?? null) === canonicalizeJson(expected.frontier)
  const sameBaseline = (journal.snapshot?.receivedHistory?.baselineId ?? null) === expected.baselineId
  if (!sameRevision || !sameFrontier || !sameBaseline) throw new WorkspaceRevisionConflict()
}

function removeCompactedChanges(journal: ReturnType<typeof readLocalJournal>, compactChangeHashes: string[]): void {
  if (compactChangeHashes.length === 0) return
  const included = new Set(compactChangeHashes)
  journal.changes = journal.changes.filter(change => !included.has(change.changeHash))
}

function advanceLocalWorkspaceHistory(
  journal: ReturnType<typeof readLocalJournal>, workspaceId: string,
  previous: StoredWorkspaceSnapshot | undefined, activeTailChanges: number, activeTailBytes: number,
): void {
  const progressBaselineId = previous?.receivedHistory?.baselineId ?? journal.historyProgress?.baselineId
  if (progressBaselineId !== undefined && !journal.frontier) {
    advanceLocalHistoryProgress(journal, workspaceId, progressBaselineId, activeTailChanges, activeTailBytes)
  }
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
    proofChanged = await writeWorkspaceCommitTransaction(transaction, {
      workspaceId, snapshot, previous, previousProofs, authorizations, command, causalChanged,
      checkpointChanged, activeTailChanges, activeTailBytes, expectedBasis, compactChangeHashes,
      ensureContextCurrent, clearDeltaRows, onPhase,
    })
  } catch (error) {
    transaction.abort()
    await completion.catch(() => undefined)
    throw error
  }
  onPhase?.("transaction-complete")
  await completion
  return proofChanged
}

type IndexedWorkspaceCommit = {
  workspaceId: string
  snapshot: StoredWorkspaceSnapshot
  previous: StoredWorkspaceSnapshot | undefined
  previousProofs: WorkspaceChangeAuthorization[]
  authorizations: WorkspaceChangeAuthorization[]
  command: WorkspaceCommitCommand | undefined
  causalChanged: boolean
  checkpointChanged: boolean
  activeTailChanges: number
  activeTailBytes: number
  expectedBasis: WorkspaceRevisionBasis
  compactChangeHashes: string[]
  ensureContextCurrent: () => void
  clearDeltaRows: (transaction: IDBTransaction, workspaceId: string) => Promise<void>
  onPhase?: (phase: string) => void
}

async function writeWorkspaceCommitTransaction(transaction: IDBTransaction, input: IndexedWorkspaceCommit): Promise<boolean> {
  const state = await readIndexedCommitState(transaction, input)
  const { existing, next } = mergeIndexedAuthorizationRecords(state.stored, input.previousProofs, input.authorizations)
  const proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
  input.onPhase?.("transaction-write")
  if (shouldWriteSnapshot(state.snapshot, input.snapshot, input.causalChanged, input.checkpointChanged)) {
    transaction.objectStore("snapshots").put(input.snapshot)
  }
  advanceCommitHistory(transaction, input.workspaceId, state.snapshot, state.progress, input.previous,
    state.frontier, input.activeTailChanges, input.activeTailBytes)
  if (!state.stored || proofChanged) {
    transaction.objectStore("authorizations").put({ id: input.workspaceId, workspaceId: input.workspaceId, records: next })
  }
  await input.clearDeltaRows(transaction, input.workspaceId)
  await removeIndexedCompactedChanges(transaction, input.workspaceId, input.compactChangeHashes)
  advanceWorkspaceRevision(transaction, input.workspaceId)
  await appendWorkspaceCommand(transaction, input.workspaceId, input.snapshot.savedAt, input.command)
  return proofChanged
}

async function readIndexedCommitState(transaction: IDBTransaction, input: IndexedWorkspaceCommit) {
  input.onPhase?.("transaction-read")
  const snapshot = await requestResult(transaction.objectStore("snapshots").get(input.workspaceId)) as StoredWorkspaceSnapshot | undefined
  const [frontier, progress, revision] = await Promise.all([
    requestResult(transaction.objectStore("frontiers").get(input.workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
    requestResult(transaction.objectStore("historyProgress").get(input.workspaceId)) as Promise<StoredHistoryProgress | undefined>,
    requestResult(transaction.objectStore("revisions").get(input.workspaceId)) as Promise<{ revision: string } | undefined>,
  ])
  input.ensureContextCurrent()
  assertIndexedWorkspaceBasis(revision, frontier, snapshot, input.expectedBasis)
  const stored = await requestResult(transaction.objectStore("authorizations").get(input.workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
  return { snapshot, frontier, progress, stored }
}

function assertIndexedWorkspaceBasis(
  revision: { revision: string } | undefined, frontier: WorkspaceDeltaFrontier | undefined,
  snapshot: StoredWorkspaceSnapshot | undefined, expected: WorkspaceRevisionBasis,
): void {
  const sameRevision = (revision?.revision ?? null) === expected.revision
  const sameFrontier = canonicalizeJson(frontier ?? null) === canonicalizeJson(expected.frontier)
  const sameBaseline = (snapshot?.receivedHistory?.baselineId ?? null) === expected.baselineId
  if (!sameRevision || !sameFrontier || !sameBaseline) throw new WorkspaceRevisionConflict()
}

function mergeIndexedAuthorizationRecords(
  stored: { records: WorkspaceChangeAuthorization[] } | undefined,
  previousProofs: WorkspaceChangeAuthorization[], authorizations: WorkspaceChangeAuthorization[],
) {
  const existing = mergeAuthorizationRecords(previousProofs, stored?.records ?? [])
  return { existing, next: mergeAuthorizationRecords(existing, authorizations) }
}

async function removeIndexedCompactedChanges(
  transaction: IDBTransaction, workspaceId: string, compactChangeHashes: string[],
): Promise<void> {
  if (compactChangeHashes.length === 0) return
  const included = new Set(compactChangeHashes)
  const store = transaction.objectStore("changes")
  const changes = await requestResult(store.index("workspaceId").getAll(workspaceId)) as Array<StoredChange & { id: string }>
  for (const change of changes) if (included.has(change.changeHash)) store.delete(change.id)
}
