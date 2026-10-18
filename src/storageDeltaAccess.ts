import type * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { StorageDeltaRepository } from "./storageDeltaRepository"
import type { StoredWorkspaceDelta, WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { openWorkspaceJournal, readWorkspaceSnapshot, readLocalJournalReference, updateLocalJournal, requestResult, transactionDone, type StoredWorkspaceSnapshot, type StoredCausalEvidence, type StoredChange, type StoredHistoryProgress } from "./storageJournal"
import { cloneCausalEvidence, extendRawEvidence } from "./causalEvidence"
import { HISTORY_ACTIVE_BYTE_LIMIT, HISTORY_ACTIVE_CHANGE_LIMIT } from "./storageJournalRecords"

function validBaselineId(value: unknown) { return value === null || typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) }
function validProgressTransition(value: StoredHistoryProgress) {
  if (value.transitionId === undefined) return value.transitionPreviousBaselineId === undefined
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.transitionId) &&
    validBaselineId(value.transitionPreviousBaselineId)
}
function validHistoryProgress(value: StoredHistoryProgress | undefined, workspaceId: string): value is StoredHistoryProgress {
  return !!value && value.id === workspaceId && value.workspaceId === workspaceId && validBaselineId(value.baselineId) &&
    Number.isSafeInteger(value.admittedChanges) && value.admittedChanges >= 0 && value.admittedChanges <= HISTORY_ACTIVE_CHANGE_LIMIT &&
    Number.isSafeInteger(value.encodedBytes) && value.encodedBytes >= 0 && value.encodedBytes <= HISTORY_ACTIVE_BYTE_LIMIT &&
    validProgressTransition(value)
}

async function localHistoryProgress(workspaceId: string): Promise<StoredHistoryProgress> {
  const journal = readLocalJournalReference(workspaceId)
  if (journal.historyProgress) return structuredClone(journal.historyProgress)
  const snapshot = await readWorkspaceSnapshot(workspaceId)
  const baselineId = snapshot?.receivedHistory?.baselineId ?? null
  const admittedChanges = baselineId ? HISTORY_ACTIVE_CHANGE_LIMIT : Math.min(HISTORY_ACTIVE_CHANGE_LIMIT, journal.changes.length)
  const encodedBytes = baselineId ? HISTORY_ACTIVE_BYTE_LIMIT : Math.min(HISTORY_ACTIVE_BYTE_LIMIT,
    journal.changes.reduce((total, change) => Math.min(HISTORY_ACTIVE_BYTE_LIMIT, total + Math.floor(change.bytesBase64.length * 3 / 4)), 0))
  const row: StoredHistoryProgress = { id: workspaceId, workspaceId, baselineId, admittedChanges, encodedBytes }
  updateLocalJournal(workspaceId, current => ({ ...current, historyProgress: row }))
  return structuredClone(row)
}

export abstract class StorageDeltaAccess {
  protected abstract checkDeltaWrites(): void
  abstract listChanges(workspaceId: string): Promise<StoredChange[]>
  protected delta = new StorageDeltaRepository()

  async readDeltaFrontier(workspaceId: string) { return this.delta.frontier(workspaceId) }
  async readDeltaWorkspace(workspaceId: string) { return this.delta.read(workspaceId) }
  async readWorkspaceRevision(workspaceId: string): Promise<string | undefined> {
    if (typeof indexedDB === "undefined") return readLocalJournalReference(workspaceId).revision
    const transaction = (await openWorkspaceJournal()).transaction("revisions", "readonly")
    const done = transactionDone(transaction)
    const row = await requestResult(transaction.objectStore("revisions").get(workspaceId)) as { revision: string } | undefined
    await done
    return row?.revision
  }
  /** Initialize one small sentinel from the current snapshot; later reads are metadata-only. */
  async ensureHistoryProgress(workspaceId: string): Promise<StoredHistoryProgress> {
    if (typeof indexedDB === "undefined") return localHistoryProgress(workspaceId)
    const database = await openWorkspaceJournal()
    const lookup = database.transaction("historyProgress", "readonly")
    const lookupDone = transactionDone(lookup)
    const existing = await requestResult(lookup.objectStore("historyProgress").get(workspaceId)) as StoredHistoryProgress | undefined
    await lookupDone
    if (validHistoryProgress(existing, workspaceId)) return structuredClone(existing)

    const transaction = database.transaction(["historyProgress", "snapshots", "changes"], "readwrite")
    const done = transactionDone(transaction)
    const [saved, snapshot] = await Promise.all([
      requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as Promise<StoredHistoryProgress | undefined>,
      requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
    ])
    if (validHistoryProgress(saved, workspaceId)) {
      await done
      return structuredClone(saved)
    }
    const baselineId = snapshot?.receivedHistory?.baselineId ?? null
    let admittedChanges = baselineId ? HISTORY_ACTIVE_CHANGE_LIMIT : 0
    let encodedBytes = baselineId ? HISTORY_ACTIVE_BYTE_LIMIT : 0
    if (!baselineId) {
      const changes = transaction.objectStore("changes").index("workspaceId")
      const range = IDBKeyRange.only(workspaceId)
      await new Promise<void>((resolve, reject) => {
        const cursor = changes.openCursor(range)
        cursor.onerror = () => reject(cursor.error ?? new Error("History change metadata could not be read"))
        cursor.onsuccess = () => {
          const value = cursor.result
          if (!value) { resolve(); return }
          const change = value.value as { bytes?: unknown }
          admittedChanges = Math.min(HISTORY_ACTIVE_CHANGE_LIMIT, admittedChanges + 1)
          if (!(change.bytes instanceof Uint8Array)) encodedBytes = HISTORY_ACTIVE_BYTE_LIMIT
          else encodedBytes = Math.min(HISTORY_ACTIVE_BYTE_LIMIT, encodedBytes + change.bytes.byteLength)
          value.continue()
        }
      })
    }
    const row: StoredHistoryProgress = { id: workspaceId, workspaceId, baselineId,
      admittedChanges, encodedBytes }
    transaction.objectStore("historyProgress").put(row)
    await done
    return structuredClone(row)
  }
  async claimHistoryTransitionId(workspaceId: string): Promise<{ transitionId: string; previousBaselineId: string | null }> {
    const valid = (value: unknown): value is string => typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    const fallback = crypto.randomUUID()
    if (typeof indexedDB === "undefined") {
      let result: { transitionId: string; previousBaselineId: string | null } = { transitionId: fallback, previousBaselineId: null }
      updateLocalJournal(workspaceId, current => {
        const progress = current.historyProgress
        if (!progress) throw new Error("History progress is not initialized")
        if (progress.transitionId !== undefined && !valid(progress.transitionId)) throw new Error("A saved history transition has an invalid identifier")
        const transitionId = valid(progress.transitionId) ? progress.transitionId : fallback
        if (valid(progress.transitionId) && !(progress.transitionPreviousBaselineId === null ||
            typeof progress.transitionPreviousBaselineId === "string" && /^[A-Za-z0-9_-]{43}$/.test(progress.transitionPreviousBaselineId))) {
          throw new Error("A saved history transition has an invalid baseline")
        }
        const previousBaselineId = valid(progress.transitionId) ? progress.transitionPreviousBaselineId ?? null : progress.baselineId
        result = { transitionId, previousBaselineId }
        return { ...current, historyProgress: { ...progress, transitionId, transitionPreviousBaselineId: previousBaselineId } }
      })
      return result
    }
    const database = await openWorkspaceJournal()
    const transaction = database.transaction("historyProgress", "readwrite")
    const done = transactionDone(transaction)
    const current = await requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as StoredHistoryProgress | undefined
    if (current?.transitionId !== undefined && !valid(current.transitionId)) {
      transaction.abort()
      await done.catch(() => undefined)
      throw new Error("A saved history transition has an invalid identifier; keep this device storage and retry recovery")
    }
    if (!validHistoryProgress(current, workspaceId)) {
      transaction.abort()
      await done.catch(() => undefined)
      throw new Error("History progress is not initialized")
    }
    const existingTransition = valid(current.transitionId)
    const transitionId = existingTransition ? current.transitionId! : fallback
    const previousBaselineId = existingTransition ? current.transitionPreviousBaselineId ?? null : current.baselineId
    if (previousBaselineId !== null && !/^[A-Za-z0-9_-]{43}$/.test(previousBaselineId)) {
      transaction.abort()
      await done.catch(() => undefined)
      throw new Error("History transition baseline is malformed")
    }
    if (!existingTransition) transaction.objectStore("historyProgress").put({ ...current, transitionId,
      transitionPreviousBaselineId: previousBaselineId })
    await done
    return { transitionId, previousBaselineId }
  }
  async completeHistoryTransition(workspaceId: string, transitionId: string): Promise<void> {
    if (typeof indexedDB === "undefined") {
      updateLocalJournal(workspaceId, current => {
        const progress = current.historyProgress
        if (!progress || progress.transitionId !== transitionId) throw new Error("History transition changed before completion")
        const completed = { ...progress }
        delete completed.transitionId
        delete completed.transitionPreviousBaselineId
        return { ...current, historyProgress: completed }
      })
      return
    }
    const database = await openWorkspaceJournal()
    const transaction = database.transaction("historyProgress", "readwrite")
    const done = transactionDone(transaction)
    const progress = await requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as StoredHistoryProgress | undefined
    if (!validHistoryProgress(progress, workspaceId) || progress.transitionId !== transitionId) {
      transaction.abort()
      await done.catch(() => undefined)
      throw new Error("History transition changed before completion")
    }
    const completed = { ...progress }
    delete completed.transitionId
    delete completed.transitionPreviousBaselineId
    transaction.objectStore("historyProgress").put(completed)
    await done
  }
  async installDeltaBasis(snapshot: StoredWorkspaceSnapshot, frontier: WorkspaceDeltaFrontier,
    authorizations: WorkspaceChangeAuthorization[], doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.checkDeltaWrites()
    const installed = await (await this.delta.journal()).install(snapshot, frontier, authorizations)
    if (installed) this.delta.remember({ basis: snapshot, frontier, deltas: [] }, doc)
    return installed
  }
  async commitDelta(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.checkDeltaWrites()
    return this.delta.append(frontier, delta, doc)
  }
  async hasCausalEvidence(workspaceId: string) {
    return Boolean(await this.delta.frontier(workspaceId) || await this.loadCausalEvidence(workspaceId))
  }
  async hasUnresolvedCausalChanges(workspaceId: string) {
    const frontier = await this.delta.frontier(workspaceId)
    if (frontier && !frontier.invalidated) return false
    return Boolean((await this.loadCausalEvidence(workspaceId))?.decisions.some(decision => decision.status.type !== "admitted"))
  }

  async loadCausalEvidence(workspaceId: string): Promise<StoredCausalEvidence | null> {
    const snapshot = await readWorkspaceSnapshot(workspaceId)
    const evidence = cloneCausalEvidence(snapshot?.causalEvidence)
    if (!evidence) return null
    const frontier = await this.delta.frontier(workspaceId)
    return frontier && !frontier.invalidated ? evidence : extendRawEvidence(evidence, await this.listChanges(workspaceId))
  }

  protected async clearDeltaRows(transaction: IDBTransaction, workspaceId: string) {
    transaction.objectStore("frontiers").delete(workspaceId)
    const deltas = transaction.objectStore("deltas")
    const keys = await requestResult(deltas.index("workspaceId").getAllKeys(workspaceId))
    for (const key of keys) deltas.delete(key)
  }

  protected async invalidateDeltaFrontier(transaction: IDBTransaction, workspaceId: string) {
    const frontiers = transaction.objectStore("frontiers")
    const frontier = await requestResult(frontiers.get(workspaceId)) as WorkspaceDeltaFrontier | undefined
    if (frontier) frontiers.put({ ...frontier, invalidated: true })
  }

  protected async readJournalRecord<T>(storeName: "receipts" | "proofs", key: string) {
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(storeName, "readonly")
    const done = transactionDone(transaction)
    const record = await requestResult(transaction.objectStore(storeName).get(key)) as T | undefined
    await done
    return record
  }
}
