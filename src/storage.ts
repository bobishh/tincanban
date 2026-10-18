import * as Automerge from "@automerge/automerge/slim"
import type {
  TransactionReceipt,
  ChangeProof,
  WorkspaceDocumentV2,
  PersonalRootDocumentV1,
  Heads,
} from "./domain/model"
import { records, mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { canonicalizeJson } from "./domain/identity"
import { causalEvidenceChanged, snapshotCausalEvidence, replayAdmittedJournal } from "./causalEvidence"
import type { StoredProofsV1 } from "./domain/proofs"
import { toBase64Url, fromBase64Url } from "./domain/identity"
import { validateRekeyAuthorizations } from "./storageRekey"
import { PersonalRootMapStore } from "./storagePersonalRoot"
import { StorageHistoryAccess } from "./storageHistoryAccess"
import { activeHistoryDifference, appendLocalWorkspaceCommand, appendWorkspaceCommand, type WorkspaceCommitCommand } from "./storageCommitSupport"
import type { WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { includesWorkspaceHeads, partitionCatalog, readWorkspaceCatalogRecords, type WorkspaceMeta } from "./storageCatalog"
import {
  deleteWorkspaceJournal,
  advanceWorkspaceRevision,
  readWorkspaceSnapshot,
  type StoredWorkspaceSnapshot,
  openWorkspaceJournal,
  readLocalJournal,
  recordsForWorkspace,
  requestResult,
  transactionDone,
  withLocalJournalLock,
  writeLocalJournal,
  advanceHistoryProgress,
  advanceLocalHistoryProgress,
  HISTORY_ACTIVE_CHANGE_LIMIT,
  HISTORY_ACTIVE_BYTE_LIMIT,
  type StoredChange,
  type StoredHistoryProgress,
  type StoredProofRecord,
  type StoredReceiptRecord,
  type StoredCausalEvidence,
} from "./storageJournal"

export type { StoredChange } from "./storageJournal"


function canReuseDocument(doc: Automerge.Doc<WorkspaceDocumentV2> | undefined, workspaceId: string, heads: Heads) {
  return doc?.id === workspaceId && Automerge.getHeads(doc).sort().join() === heads.slice().sort().join()
}

let testStorageFailureHook = false

export function setStorageFailureHookForTest(active: boolean) {
  testStorageFailureHook = active
}

function checkStorageFailureHook() {
  if (testStorageFailureHook) {
    throw new Error("Storage failure injected")
  }
  const failureWindow = typeof window === "undefined"
    ? undefined
    : window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }
  if (failureWindow?.__TINCANBAN_INJECT_STORAGE_FAILURE__) {
    throw new Error("Storage failure injected")
  }
}

// In-memory backing store for tests or environments without IndexedDB
type InMemoryStore = {
  changes: Map<string, StoredChange> // key: `${workspaceId}:${changeHash}`
  proofs: Map<string, ChangeProof> // key: `${workspaceId}:${changeHash}`
  receipts: Map<string, TransactionReceipt> // key: `${workspaceId}:${transactionId}`
  snapshots: Map<string, StoredWorkspaceSnapshot> // key: workspaceId
  workspaces: Map<string, { id: string; title: string; updatedAt: string }>
  personalRoots: Map<string, PersonalRootDocumentV1>
}

const memoryStore: InMemoryStore = {
  changes: new Map(),
  proofs: new Map(),
  receipts: new Map(),
  snapshots: new Map(),
  workspaces: new Map(),
  personalRoots: new Map(),
}


export class WorkspaceStorage extends StorageHistoryAccess {
  private inMemory: InMemoryStore
  private personalRootStore: PersonalRootMapStore
  private loadedDocuments = new Map<string, Automerge.Doc<WorkspaceDocumentV2>>()
  protected checkDeltaWrites() { checkStorageFailureHook() }

  constructor(store = memoryStore) {
    super()
    this.inMemory = store
    this.personalRootStore = new PersonalRootMapStore(store.personalRoots, checkStorageFailureHook)
  }

  private rememberDocument(workspaceId: string, doc?: Automerge.Doc<WorkspaceDocumentV2>) {
    const previous = this.loadedDocuments.get(workspaceId)
    this.loadedDocuments.delete(workspaceId)
    if (previous) Automerge.free(previous)
    if (doc) this.loadedDocuments.set(workspaceId, Automerge.clone(doc))
    if (this.loadedDocuments.size > 8) {
      const oldest = this.loadedDocuments.keys().next().value!
      Automerge.free(this.loadedDocuments.get(oldest)!)
      this.loadedDocuments.delete(oldest)
    }
  }

  /** A recovery transaction replaces durable sources outside the ordinary command cache. */
  invalidateWorkspaceCache(workspaceId: string): void {
    this.delta.forget(workspaceId)
    this.rememberDocument(workspaceId)
    this.forgetReceivedHistory(workspaceId)
    this.inMemory.snapshots.delete(workspaceId)
  }

  private decodeSnapshot(snapshot: StoredWorkspaceSnapshot, reusable?: Automerge.Doc<WorkspaceDocumentV2>) {
    // Recheck durable heads on every read so other tabs cannot leave a stale cache.
    const cached = canReuseDocument(reusable, snapshot.workspaceId, snapshot.heads)
      ? reusable : this.loadedDocuments.get(snapshot.workspaceId)
    return canReuseDocument(cached, snapshot.workspaceId, snapshot.heads)
      ? Automerge.clone(cached!) : Automerge.load<WorkspaceDocumentV2>(snapshot.bytes)
  }

  async listWorkspaces(): Promise<WorkspaceMeta[]> {
    return (await this.listWorkspaceCatalog()).available
  }

  async listArchivedWorkspaces(): Promise<WorkspaceMeta[]> {
    return (await this.listWorkspaceCatalog()).archived
  }

  async listWorkspaceCatalog(): Promise<{ available: WorkspaceMeta[]; archived: WorkspaceMeta[] }> {
    return partitionCatalog(await this.workspaceRecords())
  }

  private async workspaceRecords(): Promise<WorkspaceMeta[]> {
    const records = await readWorkspaceCatalogRecords()
    this.inMemory.workspaces = new Map(records.map(record => [record.id, record]))
    return records
  }

  async rekeyWorkspace(
    oldId: string,
    newId: string,
    newTitle: string,
    authorize: (document: Automerge.Doc<WorkspaceDocumentV2>) => Promise<WorkspaceChangeAuthorization[]>,
  ): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
    checkStorageFailureHook()
    if (oldId === newId) throw new Error("Workspace IDs must differ")
    if (!authorize) throw new Error("Workspace rekey requires new workspace authorization")
    if (await this.loadWorkspaceDoc(newId)) throw new Error(`Workspace ${newId} already exists`)
    const loaded = await this.loadWorkspaceDoc(oldId)
    if (!loaded) throw new Error(`Workspace ${oldId} not found`)

    const moved = Automerge.change(Automerge.clone(loaded.doc), draft => {
      draft.id = newId
      draft.title = newTitle
    })
    // Document-ID changes invalidate old workspace-scoped signatures. Require
    // verified owner authorization for every change before persisting the copy.
    const authorizations = await authorize(moved)
    await validateRekeyAuthorizations(moved, authorizations)
    await this.commitWorkspace(newId, moved, Automerge.save(moved), authorizations)

    this.inMemory.snapshots.delete(oldId)
    this.rememberDocument(oldId)
    this.inMemory.workspaces.delete(oldId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${oldId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(oldId)
    return moved
  }

  async purgeWorkspaceForTest(workspaceId: string): Promise<void> {
    this.delta.forget(workspaceId)
    this.inMemory.snapshots.delete(workspaceId)
    this.rememberDocument(workspaceId)
    this.inMemory.workspaces.delete(workspaceId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${workspaceId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(workspaceId)
  }

  async commitTransaction(
    workspaceId: string,
    receipt: TransactionReceipt,
    changeBytes: Uint8Array,
    proof: ChangeProof
  ): Promise<TransactionReceipt> {
    checkStorageFailureHook()
    const receiptKey = `${workspaceId}:${receipt.transactionId}`
    const changeKey = `${workspaceId}:${receipt.changeHash}`
    const storedChange: StoredChange = {
      workspaceId,
      changeHash: receipt.changeHash,
      bytes: new Uint8Array(changeBytes),
      addedAt: new Date().toISOString(),
    }

    if (typeof indexedDB !== "undefined") {
      const database = await openWorkspaceJournal()
      const transaction = database.transaction(["changes", "proofs", "receipts", "frontiers", "revisions"], "readwrite")
      const completion = transactionDone(transaction)
      try {
        const existing = await requestResult(transaction.objectStore("receipts").get(receiptKey)) as StoredReceiptRecord | undefined
        if (existing) {
          await completion
          return existing.receipt
        }
        transaction.objectStore("changes").put({ id: changeKey, ...storedChange })
        transaction.objectStore("proofs").put({
          id: changeKey, workspaceId, changeHash: receipt.changeHash, proof,
        } satisfies StoredProofRecord)
        transaction.objectStore("receipts").put({
          id: receiptKey, workspaceId, transactionId: receipt.transactionId, receipt,
        } satisfies StoredReceiptRecord)
        advanceWorkspaceRevision(transaction, workspaceId)
        await this.invalidateDeltaFrontier(transaction, workspaceId)
      } catch (error) {
        transaction.abort()
        await completion.catch(() => undefined)
        throw error
      }
      await completion
    } else {
      const existing = await withLocalJournalLock(workspaceId, async () => {
        const journal = readLocalJournal(workspaceId)
        const saved = journal.receipts[receipt.transactionId]
        if (saved) return saved
        journal.changes = journal.changes.filter(change => change.changeHash !== receipt.changeHash)
        journal.changes.push({
          workspaceId, changeHash: receipt.changeHash, bytesBase64: toBase64Url(changeBytes), addedAt: storedChange.addedAt,
        })
        journal.proofs[receipt.changeHash] = proof
        journal.receipts[receipt.transactionId] = receipt
        writeLocalJournal(workspaceId, journal)
        return null
      })
      if (existing) return existing
    }

    this.inMemory.changes.set(changeKey, storedChange)
    this.inMemory.proofs.set(changeKey, proof)
    this.inMemory.receipts.set(receiptKey, receipt)
    return receipt
  }

  async saveSnapshot(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>,
    bytes: Uint8Array
  ): Promise<void> {
    await this.commitWorkspace(workspaceId, doc, bytes, [])
  }

  /** Snapshot, authorization evidence and optional local transaction are one
   * durable unit. Callers hold the shared workspace mutation lock while reading
   * the latest document, validating it and committing the candidate. */
  // Atomic snapshot, proof and receipt commit shares one transaction.
  // eslint-disable-next-line complexity
  async commitWorkspace(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>,
    bytes: Uint8Array,
    authorizations: WorkspaceChangeAuthorization[],
    command?: WorkspaceCommitCommand,
    causalEvidence?: StoredCausalEvidence,
    onPhase?: (phase: string) => void,
  ): Promise<{ proofChanged: boolean; causalChanged: boolean }> {
    checkStorageFailureHook()
    if (doc.id !== workspaceId) throw new Error("Workspace commit ID mismatch")
    onPhase?.("snapshot-read")
    const committed = await readWorkspaceSnapshot(workspaceId)
    const previous = committed
    if (previous && !doc.archivedAt && previous.archivedAt !== null) {
      const previousDoc = Automerge.load<WorkspaceDocumentV2>(previous.bytes)
      try {
        if (previousDoc.archivedAt && !includesWorkspaceHeads(doc, Automerge.getHeads(previousDoc)))
          throw new Error("Workspace was archived in another tab")
      } finally { Automerge.free(previousDoc) }
    }
    const snapshot: StoredWorkspaceSnapshot = {
      id: workspaceId, workspaceId, title: doc.title, archivedAt: doc.archivedAt ?? null,
      heads: Automerge.getHeads(doc).sort(), bytes: new Uint8Array(bytes), savedAt: new Date().toISOString(),
      causalEvidence: snapshotCausalEvidence(causalEvidence, previous?.causalEvidence),
      receivedHistory: previous?.receivedHistory ? structuredClone(previous.receivedHistory) : undefined,
    }
    const { activeTailChanges, activeTailBytes } = activeHistoryDifference(previous ?? null, doc, snapshot.heads)
    // Reread current authorizations inside the transaction so standalone proof
    // updates cannot be overwritten.
    onPhase?.("proof-read")
    const previousProofs = await records(workspaceId)
    let proofChanged = false
    const causalChanged = causalEvidenceChanged(previous?.causalEvidence, snapshot.causalEvidence)
    const checkpointChanged = canonicalizeJson(previous?.causalEvidence?.admissionCheckpoint) !== canonicalizeJson(snapshot.causalEvidence?.admissionCheckpoint)
    const incomingProofChanged = canonicalizeJson(previousProofs) !== canonicalizeJson(mergeAuthorizationRecords(previousProofs, authorizations))
    if (committed && !command && !causalChanged && !checkpointChanged && !incomingProofChanged && committed.heads.join() === snapshot.heads.join()) {
      return this.reuseCommittedWorkspace(workspaceId, committed, doc)
    }
    if (typeof indexedDB === "undefined") {
      await withLocalJournalLock(workspaceId, async () => {
        const journal = readLocalJournal(workspaceId)
        const existing = mergeAuthorizationRecords(previousProofs, (journal.authorizations ?? []) as WorkspaceChangeAuthorization[])
        const next = mergeAuthorizationRecords(existing, authorizations)
        proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
        journal.snapshot = snapshot
        journal.frontier = undefined
        journal.deltas = []
        journal.authorizations = next
        appendLocalWorkspaceCommand(journal, workspaceId, snapshot.savedAt, command)
        const progressBaselineId = previous?.receivedHistory?.baselineId ?? journal.historyProgress?.baselineId
        if (progressBaselineId !== undefined && !journal.frontier) {
          advanceLocalHistoryProgress(journal, workspaceId, progressBaselineId,
            activeTailChanges, activeTailBytes)
        }
        writeLocalJournal(workspaceId, journal)
      })
    } else {
      onPhase?.("journal-open")
      const database = await openWorkspaceJournal()
      const transaction = database.transaction(["snapshots", "authorizations", "changes", "proofs", "receipts", "frontiers", "deltas", "revisions", "historyProgress"], "readwrite")
      const completion = transactionDone(transaction)
      try {
        const snapshotStore = transaction.objectStore("snapshots")
        onPhase?.("transaction-read")
        const existingSnapshot = await requestResult(snapshotStore.get(workspaceId)) as StoredWorkspaceSnapshot | undefined
        const [existingFrontier, progress] = await Promise.all([
          requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
          requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as Promise<StoredHistoryProgress | undefined>,
        ])
        const proofStore = transaction.objectStore("authorizations")
        const stored = await requestResult(proofStore.get(workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
        const existing = mergeAuthorizationRecords(previousProofs, stored?.records ?? [])
        const next = mergeAuthorizationRecords(existing, authorizations)
        proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
        onPhase?.("transaction-write")
        if (!existingSnapshot || existingSnapshot.heads.join() !== snapshot.heads.join() || causalChanged || checkpointChanged)
          snapshotStore.put(snapshot)
        const progressBaselineId = existingSnapshot?.receivedHistory?.baselineId ?? progress?.baselineId
        if (progressBaselineId !== undefined && !existingFrontier) {
          const concurrentSnapshot = previous && existingSnapshot &&
            existingSnapshot.heads.slice().sort().join() !== previous.heads.slice().sort().join()
          advanceHistoryProgress(transaction, workspaceId, progressBaselineId,
            concurrentSnapshot ? HISTORY_ACTIVE_CHANGE_LIMIT : activeTailChanges,
            concurrentSnapshot ? HISTORY_ACTIVE_BYTE_LIMIT : activeTailBytes)
        }
        if (!stored || proofChanged) proofStore.put({ id: workspaceId, workspaceId, records: next })
        await this.clearDeltaRows(transaction, workspaceId)
        advanceWorkspaceRevision(transaction, workspaceId)
        await appendWorkspaceCommand(transaction, workspaceId, snapshot.savedAt, command)
      } catch (error) {
        transaction.abort()
        await completion.catch(() => undefined)
        throw error
      }
      onPhase?.("transaction-complete")
      await completion
    }
    // Memory projections advance only after the durable transaction completes.
    this.rememberCommittedSnapshot(workspaceId, snapshot, doc)
    onPhase?.("completed")
    return { proofChanged, causalChanged }
  }

  private rememberCommittedSnapshot(workspaceId: string, snapshot: StoredWorkspaceSnapshot, doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.delta.forget(workspaceId)
    this.inMemory.snapshots.set(workspaceId, snapshot)
    this.rememberDocument(workspaceId, doc)
  }

  private reuseCommittedWorkspace(workspaceId: string, snapshot: StoredWorkspaceSnapshot, doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.inMemory.snapshots.set(workspaceId, snapshot)
    this.rememberDocument(workspaceId, doc)
    return { proofChanged: false, causalChanged: false }
  }

  async loadWorkspaceDoc(
    workspaceId: string, reusable?: Automerge.Doc<WorkspaceDocumentV2>
  ): Promise<{ doc: Automerge.Doc<WorkspaceDocumentV2>; heads: Heads } | null> {
    await this.ensureReceivedHistory(workspaceId)
    const incremental = await this.delta.loadDocument(workspaceId, reusable)
    if (incremental) return incremental
    const snapshot = await readWorkspaceSnapshot(workspaceId)
    if (snapshot) this.inMemory.snapshots.set(workspaceId, snapshot)

    let doc: Automerge.Doc<WorkspaceDocumentV2>

    if (snapshot) {
      doc = this.decodeSnapshot(snapshot, reusable)
    } else {
      doc = Automerge.init<WorkspaceDocumentV2>()
    }

    const changes = await this.listChanges(workspaceId)
    doc = replayAdmittedJournal(doc, changes, snapshot?.causalEvidence, snapshot?.receivedHistory?.excludedLocalChangeHashes)

    const heads = Automerge.getHeads(doc).sort()
    if (!snapshot && changes.length === 0) {
      return null
    }
    this.rememberDocument(workspaceId, doc)
    return { doc, heads }
  }

  async compactWorkspace(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>
  ): Promise<void> {
    checkStorageFailureHook()
    const snapshotBytes = Automerge.save(doc)
    await this.saveSnapshot(workspaceId, doc, snapshotBytes)

    // Identify which changes are included in doc
    const includedHashes = new Set(Automerge.getChangesMetaSince(doc, []).map(change => change.hash))

    if (typeof indexedDB !== "undefined") {
      const database = await openWorkspaceJournal()
      const transaction = database.transaction("changes", "readwrite")
      const completion = transactionDone(transaction)
      const store = transaction.objectStore("changes")
      const records = await requestResult(store.index("workspaceId").getAll(workspaceId)) as Array<StoredChange & { id: string }>
      for (const record of records) if (includedHashes.has(record.changeHash)) store.delete(record.id)
      await completion
    } else {
      await withLocalJournalLock(workspaceId, async () => {
        const journal = readLocalJournal(workspaceId)
        journal.changes = journal.changes.filter(change => !includedHashes.has(change.changeHash))
        writeLocalJournal(workspaceId, journal)
      })
    }

    const prefix = `${workspaceId}:`
    for (const [key, change] of this.inMemory.changes.entries()) {
      if (key.startsWith(prefix) && includedHashes.has(change.changeHash)) this.inMemory.changes.delete(key)
    }
  }

  async listChanges(workspaceId: string): Promise<StoredChange[]> {
    const prefix = `${workspaceId}:`
    let results: StoredChange[]
    if (typeof indexedDB !== "undefined") {
      const database = await openWorkspaceJournal()
      const records = await recordsForWorkspace<StoredChange & { id: string }>(database, "changes", workspaceId)
      results = records.map(record => ({
        workspaceId: record.workspaceId,
        changeHash: record.changeHash,
        bytes: new Uint8Array(record.bytes),
        addedAt: record.addedAt,
      }))
    } else {
      results = readLocalJournal(workspaceId).changes.map(item => ({
        workspaceId: item.workspaceId,
        changeHash: item.changeHash,
        bytes: fromBase64Url(item.bytesBase64),
        addedAt: item.addedAt,
      }))
    }
    for (const key of [...this.inMemory.changes.keys()]) if (key.startsWith(prefix)) this.inMemory.changes.delete(key)
    for (const change of results) this.inMemory.changes.set(`${workspaceId}:${change.changeHash}`, change)
    return results
  }

  async getReceipt(workspaceId: string, transactionId: string): Promise<TransactionReceipt | null> {
    const key = `${workspaceId}:${transactionId}`
    const receipt = typeof indexedDB === "undefined"
      ? readLocalJournal(workspaceId).receipts[transactionId] ?? null
      : (await this.readJournalRecord<StoredReceiptRecord>("receipts", key))?.receipt ?? null
    if (receipt) this.inMemory.receipts.set(key, receipt)
    else this.inMemory.receipts.delete(key)
    return receipt
  }

  async getProof(workspaceId: string, changeHash: string): Promise<ChangeProof | null> {
    const key = `${workspaceId}:${changeHash}`
    const proof = typeof indexedDB === "undefined"
      ? readLocalJournal(workspaceId).proofs[changeHash] ?? null
      : (await this.readJournalRecord<StoredProofRecord>("proofs", key))?.proof ?? null
    if (proof) this.inMemory.proofs.set(key, proof)
    else this.inMemory.proofs.delete(key)
    return proof
  }

  async getProofs(workspaceId: string): Promise<StoredProofsV1> {
    let records: StoredProofRecord[]
    if (typeof indexedDB !== "undefined") {
      const database = await openWorkspaceJournal()
      records = await recordsForWorkspace<StoredProofRecord>(database, "proofs", workspaceId)
    } else {
      records = Object.entries(readLocalJournal(workspaceId).proofs).map(([changeHash, proof]) => ({
        id: `${workspaceId}:${changeHash}`, workspaceId, changeHash, proof,
      }))
    }
    const prefix = `${workspaceId}:`
    for (const key of [...this.inMemory.proofs.keys()]) if (key.startsWith(prefix)) this.inMemory.proofs.delete(key)
    for (const record of records) this.inMemory.proofs.set(record.id, record.proof)

    return {
      grants: [],
      certificates: [],
      actorBindings: [],
      changeProofs: records.map(record => record.proof),
    }
  }

  async savePersonalRoot(root: PersonalRootDocumentV1): Promise<void> {
    return this.personalRootStore.save(root)
  }

  async updatePersonalRootForIdentity(
    personId: string,
    update: (current: PersonalRootDocumentV1 | null) => PersonalRootDocumentV1 | null | Promise<PersonalRootDocumentV1 | null>,
  ): Promise<PersonalRootDocumentV1 | null> {
    return this.personalRootStore.update(personId, update)
  }

  async loadPersonalRoot(rootId?: string): Promise<PersonalRootDocumentV1 | null> {
    return this.personalRootStore.load(rootId)
  }
}

export const defaultStorage = new WorkspaceStorage()
