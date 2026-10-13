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
import { causalEvidenceChanged, snapshotCausalEvidence } from "./causalEvidence"
import { parseStoredSnapshot, type StoredSnapshot } from "./storageSnapshot"
import type { StoredProofsV1 } from "./domain/proofs"
import { toBase64Url, fromBase64Url } from "./domain/identity"
import { validateRekeyAuthorizations } from "./storageRekey"
import { getStorageRaw, removeStorageRaw, setStorageRaw } from "./storageRaw"
import { PersonalRootMapStore } from "./storagePersonalRoot"
import { StorageDeltaAccess } from "./storageDeltaAccess"
import { includesWorkspaceHeads, partitionCatalog, readWorkspaceCatalogRecords, type WorkspaceMeta } from "./storageCatalog"
import {
  deleteWorkspaceJournal,
  readWorkspaceSnapshot,
  readWorkspaceBasisSnapshot,
  type StoredWorkspaceSnapshot,
  openWorkspaceJournal,
  readLocalJournal,
  recordsForWorkspace,
  requestResult,
  transactionDone,
  withLocalJournalLock,
  writeLocalJournal,
  type StoredChange,
  type StoredProofRecord,
  type StoredReceiptRecord,
  type StoredCausalEvidence,
} from "./storageJournal"

export type { StoredChange } from "./storageJournal"
export * from "./storageLegacy"

const workspaceMetaPrefix = "tincanban.workspace-meta."

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
  snapshots: Map<string, StoredSnapshot> // key: workspaceId
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


export class WorkspaceStorage extends StorageDeltaAccess {
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

  private decodeSnapshot(snapshot: StoredSnapshot, reusable?: Automerge.Doc<WorkspaceDocumentV2>) {
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

  async registerWorkspace(id: string, title: string, archivedAt: string | null = null, allowRestore = false): Promise<void> {
    const committed = await this.delta.frontier(id) ?? await readWorkspaceBasisSnapshot(id)
    const legacy = committed?.archivedAt === undefined ? await getStorageRaw(`tincanban.workspace-meta.${id}`) : null
    const previousArchive = committed?.archivedAt === undefined ? (legacy ? (JSON.parse(legacy) as WorkspaceMeta).archivedAt : null) : committed.archivedAt
    if (!archivedAt && !allowRestore && previousArchive)
      throw new Error("Workspace was archived in another tab")
    const meta = { id, title, updatedAt: new Date().toISOString(), archivedAt }
    await setStorageRaw(`tincanban.workspace-meta.${id}`, JSON.stringify(meta))
    this.inMemory.workspaces.set(id, meta)
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

    await removeStorageRaw(`${workspaceMetaPrefix}${oldId}`)
    this.inMemory.snapshots.delete(oldId)
    this.rememberDocument(oldId)
    this.inMemory.workspaces.delete(oldId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${oldId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(oldId)
    for (const prefix of ["tincanban.snapshot.", "tincanban.v1.changes.", "tincanban.v1.proofs.", "tincanban.v1.receipts."]) {
      await removeStorageRaw(`${prefix}${oldId}`)
    }
    return moved
  }

  async purgeWorkspaceForTest(workspaceId: string): Promise<void> {
    this.delta.forget(workspaceId)
    await removeStorageRaw(`${workspaceMetaPrefix}${workspaceId}`)
    this.inMemory.snapshots.delete(workspaceId)
    this.rememberDocument(workspaceId)
    this.inMemory.workspaces.delete(workspaceId)
    for (const map of [this.inMemory.changes, this.inMemory.proofs, this.inMemory.receipts]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${workspaceId}:`)) map.delete(key)
      }
    }
    await deleteWorkspaceJournal(workspaceId)
    for (const prefix of ["tincanban.snapshot.", "tincanban.v1.changes.", "tincanban.v1.proofs.", "tincanban.v1.receipts."]) {
      await removeStorageRaw(`${prefix}${workspaceId}`)
    }
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
      const transaction = database.transaction(["changes", "proofs", "receipts"], "readwrite")
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
    command?: { receipt: TransactionReceipt; changeBytes: Uint8Array; proof: ChangeProof },
    causalEvidence?: StoredCausalEvidence,
    onPhase?: (phase: string) => void,
  ): Promise<{ proofChanged: boolean; causalChanged: boolean }> {
    checkStorageFailureHook()
    if (doc.id !== workspaceId) throw new Error("Workspace commit ID mismatch")
    onPhase?.("snapshot-read")
    const committed = await readWorkspaceSnapshot(workspaceId)
    const legacyRaw = committed ? null : await getStorageRaw(`tincanban.snapshot.${workspaceId}`)
    const previous = committed ?? (legacyRaw ? parseStoredSnapshot(legacyRaw, workspaceId) : null)
    if (previous && !doc.archivedAt && (!committed || committed.archivedAt !== null)) {
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
    }
    // Legacy proof storage is read-only during migration. The transaction also
    // rereads current proofs, so standalone proof updates cannot be overwritten.
    onPhase?.("proof-read")
    const previousProofs = await records(workspaceId)
    let proofChanged = false
    const causalChanged = causalEvidenceChanged(previous?.causalEvidence, snapshot.causalEvidence)
    const checkpointChanged = canonicalizeJson(previous?.causalEvidence?.admissionCheckpoint) !== canonicalizeJson(snapshot.causalEvidence?.admissionCheckpoint)
    const incomingProofChanged = canonicalizeJson(previousProofs) !== canonicalizeJson(mergeAuthorizationRecords(previousProofs, authorizations))
    if (committed && !command && !causalChanged && !checkpointChanged && !incomingProofChanged && committed.heads.join() === snapshot.heads.join()) {
      return this.reuseCommittedWorkspace(workspaceId, committed, doc)
    }
    const addCommand = (journal: ReturnType<typeof readLocalJournal>) => {
      if (!command) return
      const { receipt, changeBytes, proof } = command
      const saved = journal.receipts[receipt.transactionId]
      if (saved && saved.changeHash !== receipt.changeHash) throw new Error("Transaction ID conflicts with a committed change")
      if (saved) return
      journal.changes.push({ workspaceId, changeHash: receipt.changeHash, bytesBase64: toBase64Url(changeBytes), addedAt: snapshot.savedAt })
      journal.proofs[receipt.changeHash] = proof
      journal.receipts[receipt.transactionId] = receipt
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
        addCommand(journal)
        writeLocalJournal(workspaceId, journal)
      })
    } else {
      onPhase?.("journal-open")
      const database = await openWorkspaceJournal()
      const transaction = database.transaction(["snapshots", "authorizations", "changes", "proofs", "receipts", "frontiers", "deltas"], "readwrite")
      const completion = transactionDone(transaction)
      try {
        const snapshotStore = transaction.objectStore("snapshots")
        onPhase?.("transaction-read")
        const existingSnapshot = await requestResult(snapshotStore.get(workspaceId)) as StoredWorkspaceSnapshot | undefined
        const proofStore = transaction.objectStore("authorizations")
        const stored = await requestResult(proofStore.get(workspaceId)) as { records: WorkspaceChangeAuthorization[] } | undefined
        const existing = mergeAuthorizationRecords(previousProofs, stored?.records ?? [])
        const next = mergeAuthorizationRecords(existing, authorizations)
        proofChanged = canonicalizeJson(existing) !== canonicalizeJson(next)
        onPhase?.("transaction-write")
        if (!existingSnapshot || existingSnapshot.heads.join() !== snapshot.heads.join() || causalChanged || checkpointChanged)
          snapshotStore.put(snapshot)
        if (!stored || proofChanged) proofStore.put({ id: workspaceId, workspaceId, records: next })
        await this.clearDeltaRows(transaction, workspaceId)
        if (command) {
          const { receipt, changeBytes, proof } = command
          const receiptKey = `${workspaceId}:${receipt.transactionId}`
          const existingReceipt = await requestResult(transaction.objectStore("receipts").get(receiptKey)) as StoredReceiptRecord | undefined
          if (existingReceipt && existingReceipt.receipt.changeHash !== receipt.changeHash) throw new Error("Transaction ID conflicts with a committed change")
          if (!existingReceipt) {
            const changeKey = `${workspaceId}:${receipt.changeHash}`
            transaction.objectStore("changes").put({ id: changeKey, workspaceId, changeHash: receipt.changeHash, bytes: new Uint8Array(changeBytes), addedAt: snapshot.savedAt })
            transaction.objectStore("proofs").put({ id: changeKey, workspaceId, changeHash: receipt.changeHash, proof })
            transaction.objectStore("receipts").put({ id: receiptKey, workspaceId, transactionId: receipt.transactionId, receipt })
          }
        }
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
    const incremental = await this.delta.loadDocument(workspaceId, reusable)
    if (incremental) return incremental
    const committedSnapshot = await readWorkspaceSnapshot(workspaceId)
    const rawSnapshot = committedSnapshot ? null : await getStorageRaw(`tincanban.snapshot.${workspaceId}`)
    const parsedSnapshot = committedSnapshot ?? (rawSnapshot ? parseStoredSnapshot(rawSnapshot, workspaceId) : null)
    if (parsedSnapshot) this.inMemory.snapshots.set(workspaceId, parsedSnapshot)
    const snapshot = parsedSnapshot ?? this.inMemory.snapshots.get(workspaceId) ?? null

    let doc: Automerge.Doc<WorkspaceDocumentV2>

    if (snapshot) {
      doc = this.decodeSnapshot(snapshot, reusable)
    } else {
      doc = Automerge.init<WorkspaceDocumentV2>()
    }

    const changes = await this.listChanges(workspaceId)
    const missingChanges = changes.filter(change => !Automerge.hasHeads(doc, [change.changeHash]))
    if (missingChanges.length > 0) {
      const changeByteArrays = missingChanges.map((c) => c.bytes)
      try {
        const [updatedDoc] = Automerge.applyChanges(doc, changeByteArrays)
        doc = updatedDoc
      } catch {
        // If some changes were already present, apply individual
        for (const bytes of changeByteArrays) {
          try {
            const [next] = Automerge.applyChanges(doc, [bytes])
            doc = next
          } catch {
            // Already applied or dependent
          }
        }
      }
    }

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
