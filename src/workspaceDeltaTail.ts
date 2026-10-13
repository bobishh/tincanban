import { canonicalizeJson } from "./domain/identity"
import { readLocalJournalReference, requestResult, transactionDone } from "./storageJournalRecords"
import type { StoredWorkspaceDelta, WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"

/** One atomic indexed read of commands after a checked prefix. No immutable basis or old tail is read. */
export async function readDeltaTail(database: IDBDatabase | undefined, previous: WorkspaceDeltaFrontier):
  Promise<{ frontier: WorkspaceDeltaFrontier; deltas: StoredWorkspaceDelta[] } | undefined> {
  if (!database) {
    const journal = readLocalJournalReference(previous.workspaceId)
    if (!canExtendCheckedPrefix(previous, journal.frontier)) return
    return structuredClone({ frontier: journal.frontier!, deltas: journal.deltas?.slice(previous.revision) ?? [] })
  }
  const transaction = database.transaction(["frontiers", "deltas"], "readonly")
  const done = transactionDone(transaction)
  const frontier = await requestResult(transaction.objectStore("frontiers").get(previous.workspaceId)) as WorkspaceDeltaFrontier | undefined
  if (!canExtendCheckedPrefix(previous, frontier)) { await done; return }
  const deltas = frontier!.revision > previous.revision
    ? await requestResult(transaction.objectStore("deltas").index("sequence").getAll(IDBKeyRange.bound(
      [previous.workspaceId, previous.generation, previous.revision + 1],
      [previous.workspaceId, previous.generation, frontier!.revision]))) as StoredWorkspaceDelta[] : []
  await done
  return { frontier: frontier!, deltas }
}

function canExtendCheckedPrefix(previous: WorkspaceDeltaFrontier, current: WorkspaceDeltaFrontier | undefined) {
  if (!current || current.invalidated || previous.invalidated || !Number.isSafeInteger(current.revision) || current.revision < previous.revision) return false
  return canonicalizeJson({ ...current, revision: previous.revision, heads: previous.heads, chainHash: previous.chainHash,
    title: previous.title, archivedAt: previous.archivedAt, savedAt: previous.savedAt }) === canonicalizeJson(previous)
}
