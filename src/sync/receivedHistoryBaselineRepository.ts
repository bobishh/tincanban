import * as Automerge from "@automerge/automerge/slim"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { canonicalizeJson } from "@meta-uber/mesh-identity"
import { toBase64Url } from "../domain/identity"
import type { WireHistoryBaseline } from "../product-replica/historyBaselineReceiver"
import type { WorkspaceRevisionBasis } from "../storageCommitSupport"
import type { WorkspaceTransactionContext } from "../storageTransactionAccess"
import { claimWorkspaceTransaction, resolveWorkspaceTransactionClaim } from "../storageTransactionClaims"
import { captureReceivedHistoryCandidate, type ReceivedHistoryCandidate } from "./receivedHistoryCandidate"
import { readVerifiedHistoryAncestors, type VerifiedHistoryAncestors } from "./verifiedHistoryAncestors"
import { retainActiveHistoryAncestors, retainHistoryAncestorRows } from "./receivedHistoryAncestorRetention"
import { advanceWorkspaceRevision, openWorkspaceJournal, requestResult, transactionDone,
  type StoredReceivedHistoryBaseline, type StoredWorkspaceSnapshot, type StoredHistoryProgress } from "../storageJournal"

const MAX_BASELINE_DOCUMENT_BYTES = 256 * 1024 * 1024
const MAX_EXPORTED_ARCHIVE_BYTES = 512 * 1024 * 1024

function snapshotMatches(left: StoredWorkspaceSnapshot | undefined, right: StoredWorkspaceSnapshot | null) {
  if (!left || !right) return left === undefined && right === null
  const withoutBytes = (snapshot: StoredWorkspaceSnapshot) => ({ ...snapshot, bytes: null,
    causalEvidence: snapshot.causalEvidence ? { ...snapshot.causalEvidence, bytes: null } : undefined })
  const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a?.length === b?.length &&
    (!a || a.every((byte, index) => byte === b?.[index]))
  return canonicalizeJson(withoutBytes(left)) === canonicalizeJson(withoutBytes(right)) &&
    sameBytes(left.bytes, right.bytes) && sameBytes(left.causalEvidence?.bytes, right.causalEvidence?.bytes)
}

function samePeerProofs(left: StoredReceivedHistoryBaseline["peerProofs"], right: StoredReceivedHistoryBaseline["peerProofs"]) {
  if (!left || !right) return left === right
  if (left.version !== right.version || left.objects.length !== right.objects.length) return false
  const ordered = (value: NonNullable<StoredReceivedHistoryBaseline["peerProofs"]>) =>
    [...value.objects].sort((a, b) => a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0)
  const a = ordered(left), b = ordered(right)
  return a.every((item, index) => item.objectId === b[index]!.objectId && item.bytes.length === b[index]!.bytes.length &&
    item.bytes.every((byte, offset) => byte === b[index]!.bytes[offset]))
}

function assertStagingScope(workspaceId: string, captured: ReceivedHistoryCandidate, expected: StoredWorkspaceSnapshot | null) {
  if (captured.workspaceId !== workspaceId || (expected && expected.workspaceId !== workspaceId)) {
    throw new Error("Received history candidate belongs to another workspace")
  }
  if (expected && expected.bytes.length > MAX_BASELINE_DOCUMENT_BYTES) {
    throw new Error("Preactivation workspace snapshot exceeds its retention bound")
  }
}

function assertStagingState(snapshot: StoredWorkspaceSnapshot | undefined, expected: StoredWorkspaceSnapshot | null,
  existingRows: StoredReceivedHistoryBaseline[]) {
  if (!snapshotMatches(snapshot, expected)) throw new Error("Workspace changed before received history could be staged")
  if (existingRows.some(row => row.state === "staged")) throw new Error("A received history baseline is already staged")
  if (expected?.receivedHistory && !existingRows.some(row => row.state === "active" &&
      row.baselineId === expected.receivedHistory?.baselineId)) {
    throw new Error("Current received history parent is missing from the local archive")
  }
}

function assertStagedCandidate(staged: StoredReceivedHistoryBaseline | undefined, captured: ReceivedHistoryCandidate, stageId: string): asserts staged is StoredReceivedHistoryBaseline {
  if (!staged || staged.state !== "staged" || staged.stageId !== stageId ||
      staged.scopeId !== captured.scopeId || staged.keyEpoch !== captured.keyEpoch ||
      canonicalizeJson(staged.pinnedStorage) !== canonicalizeJson(captured.pinnedStorage) ||
      staged.signedJson.length !== captured.signedJson.length || !staged.signedJson.every((byte, index) => byte === captured.signedJson[index]) ||
      staged.document.length !== captured.document.length || !staged.document.every((byte, index) => byte === captured.document[index]) ||
      !samePeerProofs(staged.peerProofs, captured.peerProofs)) {
    throw new Error("Received history candidate does not match the staged candidate")
  }
}

function assertStagedSnapshot(snapshot: StoredWorkspaceSnapshot | undefined, staged: StoredReceivedHistoryBaseline) {
  if (!snapshotMatches(snapshot, staged.expectedSnapshot) ||
      (snapshot?.receivedHistory?.baselineId ?? undefined) !== staged.previousBaselineId) {
    throw new Error("Workspace changed after received history was staged")
  }
}

function assertVerifiedParent(baselineId: string | undefined, parent: StoredReceivedHistoryBaseline | undefined) {
  if (baselineId && parent?.state !== "active") throw new Error("Verified history parent is missing")
}

function assertStagedRevision(revision: { revision?: string } | undefined, frontier: unknown,
  snapshot: StoredWorkspaceSnapshot | undefined, staged: StoredReceivedHistoryBaseline, expected: WorkspaceRevisionBasis) {
  if ((revision?.revision ?? undefined) !== staged.expectedWorkspaceRevision ||
      canonicalizeJson(frontier ?? null) !== canonicalizeJson(staged.expectedFrontier ?? null) ||
      (revision?.revision ?? null) !== expected.revision || canonicalizeJson(frontier ?? null) !== canonicalizeJson(expected.frontier) ||
      (snapshot?.receivedHistory?.baselineId ?? null) !== expected.baselineId ||
      (staged.expectedWorkspaceRevision ?? null) !== expected.revision ||
      canonicalizeJson(staged.expectedFrontier ?? null) !== canonicalizeJson(expected.frontier) ||
      (staged.previousBaselineId ?? null) !== expected.baselineId) {
    throw new Error("Workspace history changed after received history was staged")
  }
}

function archiveActiveChanges(transaction: IDBTransaction, workspaceId: string, baselineId: string,
  changes: Array<{ id: string; workspaceId: string; changeHash: string; bytes: Uint8Array; addedAt: string }>) {
  const archivedChanges = transaction.objectStore("archivedChanges")
  const activeChanges = transaction.objectStore("changes")
  for (const change of changes) {
    if (change.workspaceId !== workspaceId || !change.changeHash || !(change.bytes instanceof Uint8Array)) {
      throw new Error("Active workspace change row is malformed")
    }
    archivedChanges.put({ ...change, id: change.id,
      archivedUnderBaselineId: baselineId })
    activeChanges.delete(change.id)
  }
}

function snapshotMetadata(snapshot: StoredWorkspaceSnapshot): Omit<StoredWorkspaceSnapshot, "bytes"> {
  const metadata: Partial<StoredWorkspaceSnapshot> = { ...snapshot }
  delete metadata.bytes
  return metadata as Omit<StoredWorkspaceSnapshot, "bytes">
}

function assertRestorableParent(snapshot: StoredWorkspaceSnapshot | undefined, archive: StoredReceivedHistoryBaseline | undefined): asserts archive is StoredReceivedHistoryBaseline {
  if (!snapshot?.receivedHistory || archive?.state !== "active" ||
      archive.baselineId !== snapshot.receivedHistory.baselineId || !Object.hasOwn(archive, "priorSnapshot")) {
    throw new Error("The received history basis has no restorable local parent")
  }
}

function assertRollbackSnapshot(snapshot: StoredWorkspaceSnapshot | undefined, archive: StoredReceivedHistoryBaseline,
  revision: { revision?: string } | undefined, frontier: unknown) {
  if (!archive.activationRevision || !archive.activatedSnapshotMetadata || revision?.revision !== archive.activationRevision ||
      !snapshotMatches(snapshot, { ...archive.activatedSnapshotMetadata, bytes: archive.document }) || frontier !== undefined) {
    throw new Error("Workspace changed after history activation; preserve its current tail before restoring a parent")
  }
}
function assertRollbackTail(archive: StoredReceivedHistoryBaseline, historyProgress: StoredHistoryProgress | undefined,
  changeCount: number, activeAuthorizations: { records?: unknown[] } | undefined) {
  if (changeCount !== 0 || !Array.isArray(activeAuthorizations?.records) || activeAuthorizations.records.length !== 0 ||
      !historyProgress || historyProgress.baselineId !== archive.baselineId || historyProgress.admittedChanges !== 0 || historyProgress.encodedBytes !== 0) {
    throw new Error("Workspace changed after history activation; preserve its current tail before restoring a parent")
  }
  if (historyProgress.transitionId !== undefined || archive.priorHistoryProgress?.transitionId !== undefined) {
    throw new Error("A history transition makes local parent rollback unsafe; finish it and use private recovery")
  }
}
function assertPreservedAuthorizations(value: { records?: unknown[] } | undefined): asserts value is { records: unknown[] } {
  if (!value || !Array.isArray(value.records)) throw new Error("The received history basis is missing its preserved local authorizations")
}

/** Durable two-phase receiver. Staging preserves source bytes; activation is a workspace-journal CAS. */
class ReceivedHistoryBaselineRepository {
  constructor(readonly workspaceId: string, readonly ensureCurrent: () => void) {}

  async readStored(): Promise<StoredReceivedHistoryBaseline | undefined> {
    const { workspaceId } = this
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["receivedBaselines", "snapshots"], "readonly")
    const done = transactionDone(transaction)
    const [rows, snapshot] = await Promise.all([
      requestResult(transaction.objectStore("receivedBaselines").index("workspaceId").getAll(workspaceId)) as Promise<StoredReceivedHistoryBaseline[]>,
      requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
    ])
    await done
    this.ensureCurrent()
    const staged = rows.find(row => row.state === "staged")
    const active = snapshot?.receivedHistory
      ? rows.find(row => row.baselineId === snapshot.receivedHistory?.baselineId && row.state === "active") : undefined
    return structuredClone(staged ?? active)
  }

  /** expectedSnapshot must be the exact basis row from readWorkspaceBasisSnapshot, before any activation. */
  async stage(candidate: WasmVerifiedReceivedHistoryBaseline, expectedSnapshot: StoredWorkspaceSnapshot | null,
    wire?: WireHistoryBaseline, ancestors?: VerifiedHistoryAncestors): Promise<string> {
    const { workspaceId } = this
    const captured = captureReceivedHistoryCandidate(candidate, wire)
    const historical = readVerifiedHistoryAncestors(ancestors, candidate)
    const expected = expectedSnapshot ? structuredClone(expectedSnapshot) : null
    assertStagingScope(workspaceId, captured, expected)
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["snapshots", "receivedBaselines", "frontiers", "revisions", "historyProgress"], "readwrite")
    const done = transactionDone(transaction)
    try {
      const [snapshot, existingRows, frontier, revision, historyProgress] = await Promise.all([
        requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
        requestResult(transaction.objectStore("receivedBaselines").index("workspaceId").getAll(workspaceId)) as Promise<StoredReceivedHistoryBaseline[]>,
        requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<unknown>,
        requestResult(transaction.objectStore("revisions").get(workspaceId)) as Promise<{ revision?: string } | undefined>,
        requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as Promise<StoredHistoryProgress | undefined>,
      ])
      assertStagingState(snapshot, expected, existingRows)
      this.ensureCurrent()
      const stageId = crypto.randomUUID()
      const row: StoredReceivedHistoryBaseline = {
        id: `${workspaceId}:staged:${stageId}`, workspaceId, stageId, baselineId: captured.baselineId, state: "staged", signedJson: captured.signedJson,
        document: captured.document, encryptedObjects: captured.encryptedObjects,
        ...(captured.peerProofs ? { peerProofs: structuredClone(captured.peerProofs) } : {}),
        ...(captured.wire ? { wire: captured.wire } : {}),
        expectedSnapshot: expected,
        expectedWorkspaceRevision: revision?.revision,
        expectedFrontier: frontier ? structuredClone(frontier) : null,
        priorHistoryProgress: historyProgress ? structuredClone(historyProgress) : undefined,
        scopeId: captured.scopeId,
        keyEpoch: captured.keyEpoch,
        pinnedStorage: captured.pinnedStorage,
        previousBaselineId: expected?.receivedHistory?.baselineId,
        createdAt: new Date().toISOString(),
      }
      retainHistoryAncestorRows(transaction.objectStore("receivedBaselines"), existingRows, historical)
      transaction.objectStore("receivedBaselines").add(row)
      await done
      this.ensureCurrent()
      return stageId
    } catch (error) {
      try { transaction.abort() } catch { /* Transaction already completed. */ }
      await done.catch(() => undefined)
      throw error
    }
  }

  async retainVerifiedAncestors(candidate: WasmVerifiedReceivedHistoryBaseline, ancestors?: VerifiedHistoryAncestors): Promise<void> {
    await retainActiveHistoryAncestors(this.workspaceId, candidate, ancestors, this.ensureCurrent)
  }

  async readStaged(): Promise<StoredReceivedHistoryBaseline | undefined> {
    const stored = await this.readStored()
    return stored?.state === "staged" ? stored : undefined
  }

  async readActive(): Promise<StoredReceivedHistoryBaseline | undefined> {
    const { workspaceId } = this
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["snapshots", "receivedBaselines"], "readonly")
    const done = transactionDone(transaction)
    const snapshot = await requestResult(transaction.objectStore("snapshots").get(workspaceId)) as StoredWorkspaceSnapshot | undefined
    const stored = snapshot?.receivedHistory
      ? await requestResult(transaction.objectStore("receivedBaselines").get(`${workspaceId}:baseline:${snapshot.receivedHistory.baselineId}`)) as StoredReceivedHistoryBaseline | undefined
      : undefined
    await done
    this.ensureCurrent()
    return stored?.state === "active" ? structuredClone(stored) : undefined
  }

  /** Keep original source and preactivation bytes available for export and restore. */
  async readArchiveRecord(): Promise<StoredReceivedHistoryBaseline | undefined> {
    return this.readStored()
  }

  async readArchiveRecords(): Promise<StoredReceivedHistoryBaseline[]> {
    const { workspaceId } = this
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction("receivedBaselines", "readonly")
    const done = transactionDone(transaction)
    const rows = await requestResult(transaction.objectStore("receivedBaselines").index("workspaceId").getAll(workspaceId)) as StoredReceivedHistoryBaseline[]
    await done
    this.ensureCurrent()
    return structuredClone(rows.sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0)))
  }

  /** Attach authenticated Rusty routing to the exact already-active signed basis without reactivating it. */
  async recordActiveWireRoute(baselineId: string, signedJson: Uint8Array, wire: WireHistoryBaseline): Promise<void> {
    const { workspaceId } = this
    const capturedSigned = signedJson.slice()
    const capturedWire = structuredClone(wire)
    if (capturedWire.signedJson !== toBase64Url(capturedSigned)) {
      throw new Error("Rusty history route does not match the active baseline signature")
    }
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["snapshots", "receivedBaselines"], "readwrite")
    const done = transactionDone(transaction)
    try {
      const snapshot = await requestResult(transaction.objectStore("snapshots").get(workspaceId)) as StoredWorkspaceSnapshot | undefined
      const active = snapshot?.receivedHistory?.baselineId === baselineId
        ? await requestResult(transaction.objectStore("receivedBaselines").get(`${workspaceId}:baseline:${baselineId}`)) as StoredReceivedHistoryBaseline | undefined
        : undefined
      if (active?.state !== "active" || active.workspaceId !== workspaceId || active.signedJson.length !== capturedSigned.length ||
          !active.signedJson.every((byte, index) => byte === capturedSigned[index])) {
        throw new Error("Rusty route does not match the exact active baseline")
      }
      if (active.wire && canonicalizeJson(active.wire) !== canonicalizeJson(capturedWire)) {
        throw new Error("The active baseline already has a different Rusty route")
      }
      this.ensureCurrent()
      transaction.objectStore("receivedBaselines").put({ ...active, wire: capturedWire })
      await done
      this.ensureCurrent()
    } catch (error) {
      try { transaction.abort() } catch { /* Transaction already completed. */ }
      await done.catch(() => undefined)
      throw error
    }
  }

  /** Export original signed/document/ciphertext evidence; never regenerate it from the active projection. */
  async exportArchive(): Promise<StoredReceivedHistoryBaseline[]> {
    const rows = await this.readArchiveRecords()
    let retainedBytes = 0
    for (const row of rows) {
      retainedBytes += row.signedJson.byteLength + row.document.byteLength + (row.controlJson?.byteLength ?? 0)
      for (const entry of row.encryptedObjects ?? []) {
        retainedBytes += new TextEncoder().encode(canonicalizeJson(entry)).byteLength
        if (retainedBytes > MAX_EXPORTED_ARCHIVE_BYTES) throw new Error("Received history export exceeds its bounded size")
      }
      if (retainedBytes > MAX_EXPORTED_ARCHIVE_BYTES) throw new Error("Received history export exceeds its bounded size")
    }
    return rows
  }

  async activate(stageId: string, candidate: WasmVerifiedReceivedHistoryBaseline,
    context: WorkspaceTransactionContext): Promise<void> {
    const { workspaceId } = this
    const claim = claimWorkspaceTransaction(context, workspaceId)
    const basisClaim = resolveWorkspaceTransactionClaim(claim, workspaceId)
    const ensureActivationCurrent = () => { basisClaim.ensureCurrent(); this.ensureCurrent() }
    const captured = captureReceivedHistoryCandidate(candidate)
    if (captured.workspaceId !== workspaceId) throw new Error("Received history candidate belongs to another workspace")
    const doc = Automerge.load<{ id: string; title: string; archivedAt?: string | null }>(captured.document)
    try {
      if (doc.id !== workspaceId) throw new Error("Received history basis document belongs to another workspace")
      const heads = Automerge.getHeads(doc).sort()
      const database = await openWorkspaceJournal()
      ensureActivationCurrent()
      const transaction = database.transaction(["snapshots", "receivedBaselines", "changes", "archivedChanges", "authorizations", "archivedAuthorizations", "frontiers", "revisions", "historyProgress"], "readwrite")
      const done = transactionDone(transaction)
      try {
        const [snapshot, staged, changes, frontier, authorizationRow, revision, historyProgress] = await Promise.all([
          requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
          requestResult(transaction.objectStore("receivedBaselines").get(`${workspaceId}:staged:${stageId}`)) as Promise<StoredReceivedHistoryBaseline | undefined>,
          requestResult(transaction.objectStore("changes").index("workspaceId").getAll(workspaceId)) as Promise<Array<{ id: string; workspaceId: string; changeHash: string; bytes: Uint8Array; addedAt: string }>>,
          requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<unknown>,
          requestResult(transaction.objectStore("authorizations").get(workspaceId)) as Promise<{ records?: unknown[] } | undefined>,
          requestResult(transaction.objectStore("revisions").get(workspaceId)) as Promise<{ revision?: string } | undefined>,
          requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as Promise<StoredHistoryProgress | undefined>,
        ])
        assertStagedCandidate(staged, captured, stageId)
        assertStagedSnapshot(snapshot, staged)
        const parent = staged.previousBaselineId
          ? await requestResult(transaction.objectStore("receivedBaselines").get(`${workspaceId}:baseline:${staged.previousBaselineId}`)) as StoredReceivedHistoryBaseline | undefined
          : undefined
        assertVerifiedParent(staged.previousBaselineId, parent)
        assertStagedRevision(revision, frontier, snapshot, staged, structuredClone(basisClaim.basis))
        const nextSnapshot: StoredWorkspaceSnapshot = {
          id: workspaceId, workspaceId, title: doc.title, archivedAt: doc.archivedAt ?? null, heads,
          bytes: captured.document.slice(), savedAt: new Date().toISOString(),
          receivedHistory: { baselineId: captured.baselineId, excludedLocalChangeHashes: [] },
        }
        const activatedSnapshotMetadata = snapshotMetadata(nextSnapshot)
        const activationRevision = crypto.randomUUID()
        const active: StoredReceivedHistoryBaseline = {
          ...staged, id: `${workspaceId}:baseline:${captured.baselineId}`, state: "active",
          baselineId: captured.baselineId, controlJson: captured.controlJson,
          expectedSnapshot: null,
          priorSnapshot: snapshot ? structuredClone(snapshot) : null,
          priorFrontier: frontier ? structuredClone(frontier) : null,
          priorHistoryProgress: historyProgress ? structuredClone(historyProgress) : undefined,
          activatedAt: nextSnapshot.savedAt, activationRevision, activatedSnapshotMetadata,
        }
        ensureActivationCurrent()
        archiveActiveChanges(transaction, workspaceId, captured.baselineId, changes)
        const archivedAuthorizations = transaction.objectStore("archivedAuthorizations")
        archivedAuthorizations.put({ id: `${workspaceId}:baseline:${captured.baselineId}`, workspaceId,
          baselineId: captured.baselineId, records: structuredClone(authorizationRow?.records ?? []) })
        transaction.objectStore("authorizations").put({ id: workspaceId, workspaceId, records: [] })
        transaction.objectStore("snapshots").put(nextSnapshot)
        transaction.objectStore("receivedBaselines").put(active)
        transaction.objectStore("receivedBaselines").delete(staged.id)
        transaction.objectStore("frontiers").delete(workspaceId)
        transaction.objectStore("historyProgress").put({ id: workspaceId, workspaceId,
          baselineId: captured.baselineId, admittedChanges: 0, encodedBytes: 0,
          ...(historyProgress?.transitionId ? { transitionId: historyProgress.transitionId,
            transitionPreviousBaselineId: historyProgress.transitionPreviousBaselineId } : {}) })
        transaction.objectStore("revisions").put({ id: workspaceId, workspaceId, revision: activationRevision })
        await done
        ensureActivationCurrent()
      } catch (error) {
        try { transaction.abort() } catch { /* Transaction already completed. */ }
        await done.catch(() => undefined)
        throw error
      }
    } finally { Automerge.free(doc) }
  }

  /** A confirmed storage CAS refusal leaves the original active basis intact; retain the failed candidate as inactive evidence. */
  async retainCheckpointConflictCandidate(baselineId: string): Promise<void> {
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["receivedBaselines", "snapshots"], "readwrite"), done = transactionDone(transaction)
    try {
      const rows = await requestResult(transaction.objectStore("receivedBaselines").index("workspaceId").getAll(this.workspaceId)) as StoredReceivedHistoryBaseline[]
      const snapshot = await requestResult(transaction.objectStore("snapshots").get(this.workspaceId)) as StoredWorkspaceSnapshot | undefined
      if (snapshot?.receivedHistory?.baselineId === baselineId) throw new Error("An active history basis cannot be abandoned as a checkpoint conflict")
      const staged = rows.find(row => row.state === "staged" && row.baselineId === baselineId)
      this.ensureCurrent()
      if (staged) transaction.objectStore("receivedBaselines").put({ ...staged, state: "restored" })
      await done
      this.ensureCurrent()
    } catch (cause) {
      try { transaction.abort() } catch { /* Transaction may already be complete. */ }
      await done.catch(() => undefined)
      throw cause
    }
  }

  async restorePriorLocalHistory(): Promise<void> {
    const { workspaceId } = this
    this.ensureCurrent()
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["snapshots", "receivedBaselines", "frontiers", "revisions", "historyProgress", "archivedChanges", "changes", "archivedAuthorizations", "authorizations"], "readwrite")
    const done = transactionDone(transaction)
    try {
      const snapshot = await requestResult(transaction.objectStore("snapshots").get(workspaceId)) as StoredWorkspaceSnapshot | undefined
      const archive = snapshot?.receivedHistory
        ? await requestResult(transaction.objectStore("receivedBaselines").get(`${workspaceId}:baseline:${snapshot.receivedHistory.baselineId}`)) as StoredReceivedHistoryBaseline | undefined
        : undefined
      assertRestorableParent(snapshot, archive)
      const [archivedChanges, archivedAuthorizations, revision, frontier, historyProgress, changeCount, activeAuthorizations] = await Promise.all([
        requestResult(transaction.objectStore("archivedChanges").index("activeBaseline").getAll(
          IDBKeyRange.only([workspaceId, archive.baselineId]))) as Promise<Array<{
          id: string; workspaceId: string; changeHash: string; bytes: Uint8Array; addedAt: string; archivedUnderBaselineId: string
        }>>,
        requestResult(transaction.objectStore("archivedAuthorizations").get(`${workspaceId}:baseline:${archive.baselineId}`)) as Promise<{
          records?: unknown[]
        } | undefined>,
        requestResult(transaction.objectStore("revisions").get(workspaceId)) as Promise<{ revision?: string } | undefined>,
        requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<unknown>,
        requestResult(transaction.objectStore("historyProgress").get(workspaceId)) as Promise<StoredHistoryProgress | undefined>,
        requestResult(transaction.objectStore("changes").index("workspaceId").count(workspaceId)) as Promise<number>,
        requestResult(transaction.objectStore("authorizations").get(workspaceId)) as Promise<{ records?: unknown[] } | undefined>,
      ])
      assertRollbackSnapshot(snapshot, archive, revision, frontier)
      assertRollbackTail(archive, historyProgress, changeCount, activeAuthorizations)
      assertPreservedAuthorizations(archivedAuthorizations)
      this.ensureCurrent()
      const activeChanges = transaction.objectStore("changes")
      for (const item of archivedChanges) {
        activeChanges.put({ id: `${workspaceId}:${item.changeHash}`, workspaceId, changeHash: item.changeHash,
          bytes: new Uint8Array(item.bytes), addedAt: item.addedAt })
      }
      transaction.objectStore("authorizations").put({ id: workspaceId, workspaceId,
        records: structuredClone(archivedAuthorizations.records) })
      if (archive.priorSnapshot) transaction.objectStore("snapshots").put(structuredClone(archive.priorSnapshot))
      else transaction.objectStore("snapshots").delete(workspaceId)
      transaction.objectStore("receivedBaselines").put({ ...archive, state: "restored" })
      transaction.objectStore("frontiers").delete(workspaceId)
      if (archive.priorFrontier) transaction.objectStore("frontiers").put(structuredClone(archive.priorFrontier))
      if (archive.priorHistoryProgress) transaction.objectStore("historyProgress").put(structuredClone(archive.priorHistoryProgress))
      else transaction.objectStore("historyProgress").delete(workspaceId)
      advanceWorkspaceRevision(transaction, workspaceId)
      await done
      this.ensureCurrent()
    } catch (error) {
      try { transaction.abort() } catch { /* Transaction already completed. */ }
      await done.catch(() => undefined)
      throw error
    }
  }
}

export function createReceivedHistoryBaselineRepository(workspaceId: string, ensureCurrent: () => void) {
  if (!workspaceId || workspaceId.length > 256 || typeof ensureCurrent !== "function") throw new Error("Invalid received history repository scope")
  return new ReceivedHistoryBaselineRepository(workspaceId, ensureCurrent)
}
