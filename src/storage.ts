import * as Automerge from "@automerge/automerge/slim"
import type {
  TransactionReceipt,
  ChangeProof,
  WorkspaceDocumentV2,
  PersonalRootDocumentV1,
  Heads,
} from "./domain/model"
import { records } from "./sync/workspaceChangeProofStore"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./product-replica/workspaceAuthorizationRecords"
import { canonicalizeJson } from "./domain/identity"
import { causalEvidenceChanged, snapshotCausalEvidence, replayAdmittedJournal } from "./causalEvidence"
import type { StoredProofsV1 } from "./domain/proofs"
import { fromBase64Url } from "./domain/identity"
import { PersonalRootMapStore } from "./storagePersonalRoot"
import { StorageTransactionAccess } from "./storageTransactionAccess"
import {
  activeHistoryDifference,
  persistWorkspaceInIndexedDb,
  persistWorkspaceLocally,
  WorkspaceRevisionConflict,
  type WorkspaceRevisionBasis,
  type WorkspaceCommitCommand,
} from "./storageCommitSupport"
import { includesWorkspaceHeads, partitionCatalog, readWorkspaceCatalogRecords, type WorkspaceMeta } from "./storageCatalog"
import {
  deleteWorkspaceJournal,
  readWorkspaceSnapshot,
  type StoredWorkspaceSnapshot,
  openWorkspaceJournal,
  readLocalJournal,
  recordsForWorkspace,
  type StoredChange,
  type StoredProofRecord,
  type StoredReceiptRecord,
  type StoredCausalEvidence,
} from "./storageJournal"
import { withWorkspaceMutation } from "./workspaceMutation"

export type { StoredChange } from "./storageJournal"
export { WorkspaceRevisionConflict } from "./storageCommitSupport"
export type { WorkspaceTransactionContext, WorkspaceAuthorityMutationContext } from "./storageTransactionAccess"
export type { WorkspaceTransactionClaim } from "./storageTransactionClaims"
export { isWorkspaceAuthorityMutation } from "./storageTransactionAccess"
export { claimWorkspaceTransaction, resolveWorkspaceTransactionClaim } from "./storageTransactionClaims"

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


export class WorkspaceStorage extends StorageTransactionAccess {
  private inMemory: InMemoryStore
  private personalRootStore: PersonalRootMapStore
  private loadedDocuments = new Map<string, Automerge.Doc<WorkspaceDocumentV2>>()
  protected checkDeltaWrites() { checkStorageFailureHook() }
  protected withHistoryProgressMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    return withWorkspaceMutation(workspaceId, operation)
  }

  constructor(store = memoryStore) {
    super()
    this.inMemory = store
    this.personalRootStore = new PersonalRootMapStore(store.personalRoots, checkStorageFailureHook)
  }

  /** Capture a storage-owned workspace basis and keep it live through admission and commit. */
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
    this.advanceWorkspaceLifecycle(workspaceId)
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

  async purgeWorkspaceForTest(workspaceId: string): Promise<void> {
    this.advanceWorkspaceLifecycle(workspaceId)
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

  /** Snapshot, authorization evidence and optional local transaction are one durable unit. */
  protected async commitWorkspaceAtRevision(
    workspaceId: string,
    doc: Automerge.Doc<WorkspaceDocumentV2>,
    bytes: Uint8Array,
    authorizations: WorkspaceChangeAuthorization[],
    command: WorkspaceCommitCommand | undefined,
    causalEvidence: StoredCausalEvidence | undefined,
    onPhase: ((phase: string) => void) | undefined,
    expectedBasis: WorkspaceRevisionBasis,
    compactChangeHashes: string[] = [],
    ensureContextCurrent: () => void,
  ): Promise<{ proofChanged: boolean; causalChanged: boolean }> {
    checkStorageFailureHook()
    await this.assertWorkspaceBasisCurrent(workspaceId, expectedBasis)
    if (doc.id !== workspaceId) throw new Error("Workspace commit ID mismatch")
    onPhase?.("snapshot-read")
    const committed = await readWorkspaceSnapshot(workspaceId)
    const previous = committed
    this.assertWorkspaceTransition(previous, doc)
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
    const causalChanged = causalEvidenceChanged(previous?.causalEvidence, snapshot.causalEvidence)
    const checkpointChanged = canonicalizeJson(previous?.causalEvidence?.admissionCheckpoint) !== canonicalizeJson(snapshot.causalEvidence?.admissionCheckpoint)
    const incomingProofChanged = canonicalizeJson(previousProofs) !== canonicalizeJson(mergeAuthorizationRecords(previousProofs, authorizations))
    const savedCommand = command ? await this.getReceipt(workspaceId, command.receipt.transactionId) : null
    if (command && savedCommand && savedCommand.changeHash !== command.receipt.changeHash)
      throw new Error("Transaction ID conflicts with a committed change")
    ensureContextCurrent()
    if (this.workspaceCommitUnchanged(committed, snapshot, savedCommand ? undefined : command, compactChangeHashes, causalChanged,
      checkpointChanged, incomingProofChanged)) {
      return this.reuseCommittedWorkspace(workspaceId, committed, doc)
    }
    const proofChanged = await this.persistWorkspaceState(workspaceId, snapshot, previous, previousProofs, authorizations,
      command, causalChanged, checkpointChanged, activeTailChanges, activeTailBytes, expectedBasis, compactChangeHashes,
      ensureContextCurrent, onPhase)
    // Memory projections advance only after the durable transaction completes.
    this.rememberCommittedSnapshot(workspaceId, snapshot, doc)
    onPhase?.("completed")
    return { proofChanged, causalChanged }
  }

  private async assertWorkspaceBasisCurrent(workspaceId: string, expected: WorkspaceRevisionBasis): Promise<void> {
    const [revision, frontier, snapshot] = await Promise.all([
      this.readWorkspaceRevision(workspaceId), this.readDeltaFrontier(workspaceId), readWorkspaceSnapshot(workspaceId),
    ])
    const changed = (revision ?? null) !== expected.revision ||
      canonicalizeJson(frontier ?? null) !== canonicalizeJson(expected.frontier) ||
      (snapshot?.receivedHistory?.baselineId ?? null) !== expected.baselineId
    if (changed) throw new WorkspaceRevisionConflict()
  }

  private assertWorkspaceTransition(previous: StoredWorkspaceSnapshot | undefined, doc: Automerge.Doc<WorkspaceDocumentV2>): void {
    if (!previous || doc.archivedAt || previous.archivedAt === null) return
    const previousDoc = Automerge.load<WorkspaceDocumentV2>(previous.bytes)
    try {
      if (previousDoc.archivedAt && !includesWorkspaceHeads(doc, Automerge.getHeads(previousDoc)))
        throw new Error("Workspace was archived in another tab")
    } finally { Automerge.free(previousDoc) }
  }

  private workspaceCommitUnchanged(committed: StoredWorkspaceSnapshot | undefined, snapshot: StoredWorkspaceSnapshot,
    command: WorkspaceCommitCommand | undefined, compactHashes: string[], causalChanged: boolean,
    checkpointChanged: boolean, incomingProofChanged: boolean): committed is StoredWorkspaceSnapshot {
    return Boolean(committed && !command && compactHashes.length === 0 && !causalChanged && !checkpointChanged &&
      !incomingProofChanged && committed.heads.join() === snapshot.heads.join())
  }

  private persistWorkspaceState(workspaceId: string, snapshot: StoredWorkspaceSnapshot,
    previous: StoredWorkspaceSnapshot | undefined, previousProofs: WorkspaceChangeAuthorization[],
    authorizations: WorkspaceChangeAuthorization[], command: WorkspaceCommitCommand | undefined,
    causalChanged: boolean, checkpointChanged: boolean, activeTailChanges: number, activeTailBytes: number,
    expectedBasis: WorkspaceRevisionBasis, compactChangeHashes: string[],
    ensureContextCurrent: () => void, onPhase?: (phase: string) => void): Promise<boolean> {
    if (typeof indexedDB === "undefined") return persistWorkspaceLocally(workspaceId, snapshot, previous, previousProofs,
      authorizations, command, activeTailChanges, activeTailBytes, expectedBasis, compactChangeHashes, ensureContextCurrent)
    return persistWorkspaceInIndexedDb(workspaceId, snapshot, previous, previousProofs, authorizations, command,
      causalChanged, checkpointChanged, activeTailChanges, activeTailBytes, expectedBasis, compactChangeHashes,
      ensureContextCurrent, (transaction, id) => this.clearDeltaRows(transaction, id), onPhase)
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
    const includedHashes = Automerge.getChangesMetaSince(doc, []).map(change => change.hash)
    await this.withWorkspaceTransaction(workspaceId, async context => {
      const current = await context.loadWorkspaceDoc()
      if (!current) throw new Error("Workspace not found")
      try {
        if (current.heads.join() !== Automerge.getHeads(doc).sort().join()) throw new WorkspaceRevisionConflict()
        await context.commitWorkspace(current.doc, Automerge.save(current.doc), [], undefined, undefined, undefined, includedHashes)
      } finally { Automerge.free(current.doc) }
    })
    const prefix = `${workspaceId}:`
    for (const [key, change] of this.inMemory.changes.entries()) {
      if (key.startsWith(prefix) && includedHashes.includes(change.changeHash)) this.inMemory.changes.delete(key)
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
