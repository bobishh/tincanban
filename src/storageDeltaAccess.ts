import type * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { StorageDeltaRepository } from "./storageDeltaRepository"
import type { StoredWorkspaceDelta, WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { openWorkspaceJournal, readWorkspaceSnapshot, readWorkspaceBasisSnapshot, readLocalJournalReference, updateLocalJournal, writeLocalJournal,
  requestResult, transactionDone, type StoredWorkspaceSnapshot, type StoredCausalEvidence, type StoredChange, type StoredHistoryProgress } from "./storageJournal"
import { cloneCausalEvidence, extendRawEvidence } from "./causalEvidence"
import { advanceWorkspaceRevision, HISTORY_ACTIVE_BYTE_LIMIT, HISTORY_ACTIVE_CHANGE_LIMIT } from "./storageJournalRecords"

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
  if (validHistoryProgress(journal.historyProgress, workspaceId)) return structuredClone(journal.historyProgress)
  const snapshot = await readWorkspaceSnapshot(workspaceId)
  const baselineId = snapshot?.receivedHistory?.baselineId ?? null
  const admittedChanges = baselineId ? HISTORY_ACTIVE_CHANGE_LIMIT : Math.min(HISTORY_ACTIVE_CHANGE_LIMIT, journal.changes.length)
  const encodedBytes = baselineId ? HISTORY_ACTIVE_BYTE_LIMIT : Math.min(HISTORY_ACTIVE_BYTE_LIMIT,
    journal.changes.reduce((total, change) => Math.min(HISTORY_ACTIVE_BYTE_LIMIT, total + Math.floor(change.bytesBase64.length * 3 / 4)), 0))
  const row: StoredHistoryProgress = { id: workspaceId, workspaceId, baselineId, admittedChanges, encodedBytes }
  writeLocalJournal(workspaceId, { ...journal, historyProgress: row })
  return structuredClone(row)
}

export abstract class StorageDeltaAccess {
  protected abstract checkDeltaWrites(): void
  protected abstract withHistoryProgressMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>
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
  /** Capture the baseline without materializing a frontier that may need repair. */
  protected async readWorkspaceBaselineId(workspaceId: string): Promise<string | null> {
    const progress = await this.readHistoryProgressRow(workspaceId)
    if (validHistoryProgress(progress, workspaceId)) return progress.baselineId
    return (await readWorkspaceBasisSnapshot(workspaceId))?.receivedHistory?.baselineId ?? null
  }

  /** Initialize one small sentinel from the current snapshot; later reads are metadata-only. */
  async ensureHistoryProgress(workspaceId: string): Promise<StoredHistoryProgress> {
    const existing = await this.readHistoryProgressRow(workspaceId)
    if (validHistoryProgress(existing, workspaceId)) return structuredClone(existing)
    return this.withHistoryProgressMutation(workspaceId, () => this.ensureHistoryProgressLocked(workspaceId))
  }

  /** Read or conservatively derive progress without persisting metadata. Used inside a live transaction. */
  async historyProgressForRead(workspaceId: string): Promise<StoredHistoryProgress> {
    const existing = await this.readHistoryProgressRow(workspaceId)
    if (validHistoryProgress(existing, workspaceId)) return structuredClone(existing)
    return this.deriveHistoryProgress(workspaceId)
  }

  private async readHistoryProgressRow(workspaceId: string): Promise<StoredHistoryProgress | undefined> {
    if (typeof indexedDB === "undefined") return readLocalJournalReference(workspaceId).historyProgress
    const transaction = (await openWorkspaceJournal()).transaction("historyProgress", "readonly")
    const done = transactionDone(transaction)
    const existing = await requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as StoredHistoryProgress | undefined
    await done
    return existing
  }

  private async deriveHistoryProgress(workspaceId: string): Promise<StoredHistoryProgress> {
    const journal = typeof indexedDB === "undefined" ? readLocalJournalReference(workspaceId) : undefined
    const snapshot = await readWorkspaceSnapshot(workspaceId)
    const baselineId = snapshot?.receivedHistory?.baselineId ?? null
    const changes = journal?.changes ?? await this.listChanges(workspaceId)
    const admittedChanges = baselineId ? HISTORY_ACTIVE_CHANGE_LIMIT : Math.min(HISTORY_ACTIVE_CHANGE_LIMIT, changes.length)
    const encodedBytes = baselineId ? HISTORY_ACTIVE_BYTE_LIMIT : Math.min(HISTORY_ACTIVE_BYTE_LIMIT,
      changes.reduce((total, change) => Math.min(HISTORY_ACTIVE_BYTE_LIMIT,
        total + ("bytesBase64" in change ? Math.floor(change.bytesBase64.length * 3 / 4) : change.bytes.byteLength)), 0))
    return { id: workspaceId, workspaceId, baselineId, admittedChanges, encodedBytes }
  }

  private async ensureHistoryProgressLocked(workspaceId: string): Promise<StoredHistoryProgress> {
    if (typeof indexedDB === "undefined") return localHistoryProgress(workspaceId)
    const database = await openWorkspaceJournal()
    const lookup = database.transaction("historyProgress", "readonly")
    const lookupDone = transactionDone(lookup)
    const existing = await requestResult(lookup.objectStore("historyProgress").get(workspaceId)) as StoredHistoryProgress | undefined
    await lookupDone
    if (validHistoryProgress(existing, workspaceId)) return structuredClone(existing)

    const transaction = database.transaction(["historyProgress", "snapshots", "changes", "revisions", "frontiers"], "readwrite")
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
    advanceWorkspaceRevision(transaction, workspaceId)
    const frontierStore = transaction.objectStore("frontiers")
    const frontierRequest = frontierStore.get(workspaceId) as IDBRequest<WorkspaceDeltaFrontier | undefined>
    frontierRequest.onsuccess = () => { if (frontierRequest.result) frontierStore.put({ ...frontierRequest.result, invalidated: true }) }
    await done
    return structuredClone(row)
  }
  async claimHistoryTransitionId(workspaceId: string): Promise<{ transitionId: string; previousBaselineId: string | null }> {
    return this.withHistoryProgressMutation(workspaceId, () => this.claimHistoryTransitionIdLocked(workspaceId))
  }

  private async claimHistoryTransitionIdLocked(workspaceId: string): Promise<{ transitionId: string; previousBaselineId: string | null }> {
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
        if (existingTransition) return { ...current }
        const next = { ...current, historyProgress: { ...progress, transitionId, transitionPreviousBaselineId: previousBaselineId } }
        next.revision = crypto.randomUUID()
        if (next.frontier) next.frontier = { ...next.frontier, invalidated: true }
        return next
      })
      return result
    }
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["historyProgress", "revisions", "frontiers"], "readwrite")
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
    if (!existingTransition) {
      transaction.objectStore("historyProgress").put({ ...current, transitionId,
        transitionPreviousBaselineId: previousBaselineId })
      advanceWorkspaceRevision(transaction, workspaceId)
      const frontiers = transaction.objectStore("frontiers")
      const frontier = frontiers.get(workspaceId) as IDBRequest<WorkspaceDeltaFrontier | undefined>
      frontier.onsuccess = () => { if (frontier.result) frontiers.put({ ...frontier.result, invalidated: true }) }
    }
    await done
    return { transitionId, previousBaselineId }
  }
  async completeHistoryTransition(workspaceId: string, transitionId: string): Promise<void> {
    return this.withHistoryProgressMutation(workspaceId, () => this.completeHistoryTransitionLocked(workspaceId, transitionId))
  }

  private async completeHistoryTransitionLocked(workspaceId: string, transitionId: string): Promise<void> {
    if (typeof indexedDB === "undefined") {
      updateLocalJournal(workspaceId, current => {
        const progress = current.historyProgress
        if (!progress || progress.transitionId !== transitionId) throw new Error("History transition changed before completion")
        const completed = { ...progress }
        delete completed.transitionId
        delete completed.transitionPreviousBaselineId
        const next = { ...current, historyProgress: completed, revision: crypto.randomUUID() }
        if (next.frontier) next.frontier = { ...next.frontier, invalidated: true }
        return next
      })
      return
    }
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["historyProgress", "revisions", "frontiers"], "readwrite")
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
    advanceWorkspaceRevision(transaction, workspaceId)
    const frontiers = transaction.objectStore("frontiers")
    const frontier = frontiers.get(workspaceId) as IDBRequest<WorkspaceDeltaFrontier | undefined>
    frontier.onsuccess = () => { if (frontier.result) frontiers.put({ ...frontier.result, invalidated: true }) }
    await done
  }
  protected async installDeltaBasis(snapshot: StoredWorkspaceSnapshot, frontier: WorkspaceDeltaFrontier,
    authorizations: WorkspaceChangeAuthorization[], doc: Automerge.Doc<WorkspaceDocumentV2>, expectedRevision: string | null,
    ensureCurrent: () => void, nextRevision: string) {
    this.checkDeltaWrites()
    const installed = await (await this.delta.journal()).install(snapshot, frontier, authorizations, expectedRevision, ensureCurrent, nextRevision)
    if (installed) this.delta.remember({ basis: snapshot, frontier, deltas: [] }, doc)
    return installed
  }
  protected async commitDelta(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, doc: Automerge.Doc<WorkspaceDocumentV2>, expectedRevision: string | null,
    ensureCurrent: () => void) {
    this.checkDeltaWrites()
    return this.delta.append(frontier, delta, doc, expectedRevision, ensureCurrent)
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
