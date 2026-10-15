import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "../domain/identity"
import type { WorkspaceRecoveryJournal, WorkspaceRecoveryJournalRow } from "./workspaceHistoryRecoveryDecode"

type Store = "changes" | "archivedChanges" | "proofs" | "receipts" | "archivedAuthorizations"
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const baseline = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, index) => value === right[index])
const heads = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(hash) && new Set(value).size === value.length

function validateRecoveredRow(store: Store, row: WorkspaceRecoveryJournalRow, workspaceId: string): void {
  if (!isRecord(row?.value) || row.value.workspaceId !== workspaceId || row.value.id !== row.id) {
    throw new Error("Recovered history row has another workspace or physical key")
  }
  const value = row.value
  if (store === "changes" || store === "archivedChanges") return validateChangeRow(store, row, value, workspaceId)
  if (store === "archivedAuthorizations") return validateAuthorizationRow(row, value, workspaceId)
  if (store === "proofs") return validateProofRow(row, value, workspaceId)
  validateReceiptRow(row, value, workspaceId)
}
function validateChangeRow(store: Store, row: WorkspaceRecoveryJournalRow, value: Record<string, unknown>, workspaceId: string): void {
  if (!hash(value.changeHash) || row.id !== `${workspaceId}:${value.changeHash}` || !(value.bytes instanceof Uint8Array)) {
    throw new Error("Recovered change bytes do not match their original hash binding")
  }
  const bytes = value.bytes as Uint8Array
  if (Automerge.decodeChange(bytes).hash !== value.changeHash) throw new Error("Recovered change bytes do not match their original hash binding")
  if (store === "archivedChanges" && !baseline(value.archivedUnderBaselineId)) throw new Error("Recovered archived change has no original baseline binding")
}
function validateAuthorizationRow(row: WorkspaceRecoveryJournalRow, value: Record<string, unknown>, workspaceId: string): void {
  if (!baseline(value.baselineId) || row.id !== `${workspaceId}:baseline:${value.baselineId}` || !Array.isArray(value.records) ||
      value.records.length > 1_048_576) throw new Error("Recovered archived authorization records have another baseline binding")
}
function validateProofRow(row: WorkspaceRecoveryJournalRow, value: Record<string, unknown>, workspaceId: string): void {
  const proof = isRecord(value.proof) && isRecord(value.proof.payload) ? value.proof.payload : undefined
  if (!hash(value.changeHash) || row.id !== `${workspaceId}:${value.changeHash}` || !proof || proof.kind !== "change-proof" ||
      proof.version !== 1 || proof.documentId !== workspaceId || proof.changeHash !== value.changeHash) {
    throw new Error("Recovered historical proof has another change binding")
  }
}
function validateReceiptRow(row: WorkspaceRecoveryJournalRow, value: Record<string, unknown>, workspaceId: string): void {
  const receipt = isRecord(value.receipt) ? value.receipt : undefined
  if (!receipt || typeof value.transactionId !== "string" || !value.transactionId || value.transactionId.length > 256 ||
      row.id !== `${workspaceId}:${value.transactionId}` || receipt.transactionId !== value.transactionId || !validReceiptBody(receipt)) {
    throw new Error("Recovered transaction receipt has an invalid original binding")
  }
}
function sameChangeBytes(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false
  const leftBytes: unknown = left.bytes, rightBytes: unknown = right.bytes
  return leftBytes instanceof Uint8Array && rightBytes instanceof Uint8Array && sameBytes(leftBytes, rightBytes)
}
function validReceiptBody(receipt: Record<string, unknown>): boolean {
  return hash(receipt.changeHash) && receipt.saved === true && heads(receipt.beforeHeads) && heads(receipt.afterHeads) &&
    receipt.afterHeads.includes(receipt.changeHash) && Array.isArray(receipt.changedEntityIds) &&
    receipt.changedEntityIds.length <= 1_048_576 && receipt.changedEntityIds.every(id => typeof id === "string" && Boolean(id) && id.length <= 256)
}

function copyStoredRows(journal: WorkspaceRecoveryJournal, names: Store[], workspaceId: string, activeBaselineId: string | null,
  excluded: Set<string>, put: (store: Store, row: WorkspaceRecoveryJournalRow) => void): void {
  for (const store of names) for (const row of journal[store]) {
    if (store === "changes" && activeBaselineId && isRecord(row.value) && excluded.has(row.value.changeHash as string)) {
      put("archivedChanges", { id: row.id, value: { ...row.value, archivedUnderBaselineId: activeBaselineId } })
    } else put(store, row)
  }
}

function copyDeltaRows(journal: WorkspaceRecoveryJournal, workspaceId: string, activeBaselineId: string | null,
  activeGeneration: string | undefined, excluded: Set<string>, put: (store: Store, row: WorkspaceRecoveryJournalRow) => void): void {
  for (const row of journal.deltas) {
    const delta = isRecord(row.value) ? row.value : undefined, command = delta && isRecord(delta.command) ? delta.command : undefined
    const receipt = command && isRecord(command.receipt) ? command.receipt : undefined
    if (!delta || delta.workspaceId !== workspaceId || delta.id !== row.id || !command || !receipt) {
      throw new Error("Recovered delta original evidence has another workspace or malformed binding")
    }
    const changeKey = `${workspaceId}:${receipt.changeHash}`, receiptKey = `${workspaceId}:${receipt.transactionId}`
    const archived = deltaNeedsArchive(delta, receipt.changeHash, activeBaselineId, activeGeneration, excluded)
    const change = { id: changeKey, workspaceId, changeHash: receipt.changeHash, bytes: command.changeBytes, addedAt: delta.savedAt,
      ...(archived ? { archivedUnderBaselineId: activeBaselineId } : {}) }
    put(archived ? "archivedChanges" : "changes", { id: changeKey, value: change })
    put("proofs", { id: changeKey, value: { id: changeKey, workspaceId, changeHash: receipt.changeHash, proof: command.proof } })
    put("receipts", { id: receiptKey, value: { id: receiptKey, workspaceId, transactionId: receipt.transactionId, receipt } })
  }
}
function deltaNeedsArchive(delta: Record<string, unknown>, changeHash: unknown, activeBaselineId: string | null,
  generation: string | undefined, excluded: Set<string>): boolean {
  return activeBaselineId !== null && (!generation || delta.generation !== generation || excluded.has(changeHash as string))
}

/** Preserve original lookup evidence. This function grants no admission and never promotes archived sources to the active tail. */
export function restoreWorkspaceRecoveryOriginals(journal: WorkspaceRecoveryJournal, workspaceId: string,
  activeBaselineId: string | null): Pick<WorkspaceRecoveryJournal, Store> {
  const names: Store[] = ["changes", "archivedChanges", "proofs", "receipts", "archivedAuthorizations"]
  const tables = Object.fromEntries(names.map(name => [name, new Map<string, WorkspaceRecoveryJournalRow>()])) as Record<Store, Map<string, WorkspaceRecoveryJournalRow>>
  const put = (store: Store, row: WorkspaceRecoveryJournalRow) => {
    validateRecoveredRow(store, row, workspaceId)
    const value = row.value
    const old = tables[store].get(row.id)
    if (old && canonicalizeJson(old.value) !== canonicalizeJson(value)) {
      if ((store !== "changes" && store !== "archivedChanges") || !sameChangeBytes(old.value, value)) {
        throw new Error("Recovered original history rows conflict")
      }
      return
    }
    tables[store].set(row.id, structuredClone(row))
  }
  const snapshot = journal.snapshots.find(row => row.id === workspaceId)?.value
  const pointer = isRecord(snapshot) && isRecord(snapshot.receivedHistory) ? snapshot.receivedHistory : undefined
  const excluded = new Set(Array.isArray(pointer?.excludedLocalChangeHashes) ? pointer.excludedLocalChangeHashes.filter(hash) : [])
  copyStoredRows(journal, names, workspaceId, activeBaselineId, excluded, put)
  const frontier = journal.frontiers.find(row => row.id === workspaceId)?.value
  const activeGeneration = isRecord(frontier) && typeof frontier.generation === "string" ? frontier.generation : undefined
  copyDeltaRows(journal, workspaceId, activeBaselineId, activeGeneration, excluded, put)
  return Object.fromEntries(names.map(name => [name, [...tables[name].values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)])) as Pick<WorkspaceRecoveryJournal, Store>
}
