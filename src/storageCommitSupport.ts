import * as Automerge from "@automerge/automerge/slim"
import type { ChangeProof, TransactionReceipt, WorkspaceDocumentV2 } from "./domain/model"
import { toBase64Url } from "./domain/identity"
import { requestResult, type readLocalJournal, type StoredReceiptRecord, type StoredWorkspaceSnapshot } from "./storageJournal"

export type WorkspaceCommitCommand = { receipt: TransactionReceipt; changeBytes: Uint8Array; proof: ChangeProof }

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
