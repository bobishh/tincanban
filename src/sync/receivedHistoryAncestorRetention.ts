import { canonicalizeJson } from "@meta-uber/mesh-identity"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { openWorkspaceJournal, requestResult, transactionDone, type StoredReceivedHistoryBaseline,
  type StoredWorkspaceSnapshot } from "../storageJournal"
import { captureReceivedHistoryCandidate, type ReceivedHistoryCandidate } from "./receivedHistoryCandidate"
import { readVerifiedHistoryAncestors, type VerifiedHistoryAncestors } from "./verifiedHistoryAncestors"

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])
function matches(row: StoredReceivedHistoryBaseline, candidate: ReceivedHistoryCandidate) {
  return row.workspaceId === candidate.workspaceId && row.baselineId === candidate.baselineId &&
    row.scopeId === candidate.scopeId && row.keyEpoch === candidate.keyEpoch &&
    canonicalizeJson(row.pinnedStorage) === canonicalizeJson(candidate.pinnedStorage) &&
    equal(row.signedJson, candidate.signedJson) && equal(row.document, candidate.document)
}

/** Caller already holds the workspace journal CAS transaction; historical rows never become current. */
export function retainHistoryAncestorRows(store: IDBObjectStore, existing: StoredReceivedHistoryBaseline[],
  ancestors: ReceivedHistoryCandidate[]): void {
  for (const candidate of ancestors) {
    const rows = existing.filter(row => row.baselineId === candidate.baselineId)
    if (rows.some(row => !matches(row, candidate))) throw new Error("Retained history predecessor differs from its verified source")
    if (rows.length) continue
    const row: StoredReceivedHistoryBaseline = { ...candidate, id: `${candidate.workspaceId}:baseline:${candidate.baselineId}`,
      stageId: crypto.randomUUID(), state: "restored", expectedSnapshot: null, createdAt: new Date().toISOString() }
    store.add(row)
  }
}

export async function retainActiveHistoryAncestors(workspaceId: string, candidate: WasmVerifiedReceivedHistoryBaseline,
  token: VerifiedHistoryAncestors | undefined, ensureCurrent: () => void): Promise<void> {
  const ancestors = readVerifiedHistoryAncestors(token, candidate)
  if (!ancestors.length) return
  const captured = captureReceivedHistoryCandidate(candidate)
  ensureCurrent()
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(["snapshots", "receivedBaselines"], "readwrite"), done = transactionDone(transaction)
  try {
    const [snapshot, rows] = await Promise.all([
      requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
      requestResult(transaction.objectStore("receivedBaselines").index("workspaceId").getAll(workspaceId)) as Promise<StoredReceivedHistoryBaseline[]>,
    ])
    const active = rows.find(row => row.id === `${workspaceId}:baseline:${captured.baselineId}`)
    if (snapshot?.receivedHistory?.baselineId !== captured.baselineId || active?.state !== "active" || !matches(active, captured)) {
      throw new Error("Verified history ancestors do not match the current active head")
    }
    ensureCurrent()
    retainHistoryAncestorRows(transaction.objectStore("receivedBaselines"), rows, ancestors)
    await done
    ensureCurrent()
  } catch (error) {
    try { transaction.abort() } catch { /* Transaction already completed. */ }
    await done.catch(() => undefined)
    throw error
  }
}
