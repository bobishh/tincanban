import * as Automerge from "@automerge/automerge/slim"
import type { Heads, WorkspaceDocumentV2 } from "./domain/model"
import { canonicalizeJson } from "./domain/identity"
import type { WorkspaceChangeAuthorization } from "./product-replica/workspaceAuthorizationRecords"
import { StorageHistoryAccess } from "./storageHistoryAccess"
import { WorkspaceRevisionConflict, type WorkspaceRevisionBasis, type WorkspaceCommitCommand } from "./storageCommitSupport"
import { openWorkspaceJournal, readWorkspaceBasisSnapshot, updateLocalJournal,
  requestResult, transactionDone, type StoredWorkspaceSnapshot, type StoredCausalEvidence } from "./storageJournal"
import { withWorkspaceMutation } from "./workspaceMutation"
import type { StoredWorkspaceDelta, WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { isCurrentWorkspaceTransaction, isLiveWorkspaceTransaction, registerWorkspaceTransaction,
  type RegisteredWorkspaceTransaction } from "./storageTransactionClaims"

export interface WorkspaceTransactionContext {
  readonly workspaceId: string
  readonly capturedRevision: string | null
  readonly capturedFrontier: WorkspaceDeltaFrontier | null
  readonly capturedBaselineId: string | null
  loadWorkspaceDoc(): Promise<{ doc: Automerge.Doc<WorkspaceDocumentV2>; heads: Heads } | null>
  loadCausalEvidence(): Promise<StoredCausalEvidence | null>
  getVerifiedReceivedHistoryBaseline(): ReturnType<StorageTransactionAccess["getVerifiedReceivedHistoryBaseline"]>
  readDeltaFrontier(): ReturnType<StorageTransactionAccess["readDeltaFrontier"]>
  readDeltaWorkspace(): ReturnType<StorageTransactionAccess["readDeltaWorkspace"]>
  readWorkspaceBasisSnapshot(): ReturnType<typeof readWorkspaceBasisSnapshot>
  invalidateAuthorityBasis(): Promise<void>
  commitDelta(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta,
    doc: Automerge.Doc<WorkspaceDocumentV2>): Promise<WorkspaceDeltaFrontier>
  installDeltaBasis(snapshot: StoredWorkspaceSnapshot, frontier: WorkspaceDeltaFrontier,
    authorizations: WorkspaceChangeAuthorization[], doc: Automerge.Doc<WorkspaceDocumentV2>): Promise<boolean>
  commitWorkspace(doc: Automerge.Doc<WorkspaceDocumentV2>, bytes: Uint8Array,
    authorizations: WorkspaceChangeAuthorization[], command?: WorkspaceCommitCommand,
    causalEvidence?: StoredCausalEvidence, onPhase?: (phase: string) => void,
    compactChangeHashes?: string[]): Promise<{ proofChanged: boolean; causalChanged: boolean }>
}

type WorkspaceTransactionState = RegisteredWorkspaceTransaction & {
  storage: StorageTransactionAccess
}

export interface WorkspaceAuthorityMutationContext { readonly workspaceId: string; write<T>(operation: () => Promise<T>): Promise<T> }
type WorkspaceAuthorityMutationState = {
  storage: StorageTransactionAccess
  workspaceId: string
  live: boolean
  contextCurrent: () => boolean
  write: <T>(operation: () => Promise<T>) => Promise<T>
  invalidation?: Promise<void>
}
const workspaceAuthorityMutationStates = new WeakMap<object, WorkspaceAuthorityMutationState>()

export function isWorkspaceAuthorityMutation(context: WorkspaceAuthorityMutationContext | undefined,
  workspaceId: string, storage: StorageTransactionAccess): boolean {
  const state = context && workspaceAuthorityMutationStates.get(context as object)
  return !!state && state.live && state.contextCurrent() && state.storage === storage && state.workspaceId === workspaceId
}

export abstract class StorageTransactionAccess extends StorageHistoryAccess {
  protected readonly workspaceLifecycles = new Map<string, number>()
  abstract loadWorkspaceDoc(workspaceId: string, reusable?: Automerge.Doc<WorkspaceDocumentV2>):
    Promise<{ doc: Automerge.Doc<WorkspaceDocumentV2>; heads: Heads } | null>

  async withWorkspaceTransaction<T>(workspaceId: string,
    operation: (context: WorkspaceTransactionContext) => Promise<T>): Promise<T> {
    return withWorkspaceMutation(workspaceId, () => this.runWorkspaceTransaction(workspaceId, operation))
  }

  async withWorkspaceAuthorityMutation<T>(workspaceId: string,
    operation: (context: WorkspaceAuthorityMutationContext) => Promise<T>): Promise<T> {
    return this.withWorkspaceTransaction(workspaceId, transaction => this.runAuthorityMutation(workspaceId, transaction, operation))
  }

  protected advanceWorkspaceLifecycle(workspaceId: string): void {
    this.workspaceLifecycles.set(workspaceId, (this.workspaceLifecycles.get(workspaceId) ?? 0) + 1)
  }

  protected abstract commitWorkspaceAtRevision(workspaceId: string, doc: Automerge.Doc<WorkspaceDocumentV2>, bytes: Uint8Array,
    authorizations: WorkspaceChangeAuthorization[], command: WorkspaceCommitCommand | undefined,
    causalEvidence: StoredCausalEvidence | undefined, onPhase: ((phase: string) => void) | undefined,
    expectedBasis: WorkspaceRevisionBasis, compactChangeHashes: string[],
    ensureCurrent: () => void): Promise<{ proofChanged: boolean; causalChanged: boolean }>

  private async runWorkspaceTransaction<T>(workspaceId: string,
    operation: (context: WorkspaceTransactionContext) => Promise<T>): Promise<T> {
    const state = await this.captureTransactionState(workspaceId)
    const context = this.createTransactionContext(state)
    state.context = context as object
    registerWorkspaceTransaction(context as object, state)
    try {
      return await operation(context)
    } finally {
      state.live = false
    }
  }

  private async captureTransactionState(workspaceId: string): Promise<WorkspaceTransactionState> {
    const frontier = await this.readDeltaFrontier(workspaceId)
    const snapshot = await readWorkspaceBasisSnapshot(workspaceId)
    const revision = (await this.readWorkspaceRevision(workspaceId)) ?? null
    const lifecycle = this.workspaceLifecycles.get(workspaceId) ?? 0
    return {
      storage: this, workspaceId,
      basis: { revision, frontier: frontier ?? null, baselineId: snapshot?.receivedHistory?.baselineId ?? null },
      lifecycle, live: true, used: false,
      lifecycleCurrent: () => lifecycle === (this.workspaceLifecycles.get(workspaceId) ?? 0),
    }
  }

  private createTransactionContext(state: WorkspaceTransactionState): WorkspaceTransactionContext {
    const assertCurrent = () => this.assertTransactionCurrent(state)
    const assertLive = () => {
      assertCurrent()
      if (state.used) throw new Error("Workspace transaction context is missing, stale, or already used")
    }
    const context: WorkspaceTransactionContext = {
      workspaceId: state.workspaceId,
      capturedRevision: state.basis.revision,
      get capturedFrontier() { assertLive(); return state.basis.frontier ? structuredClone(state.basis.frontier) : null },
      capturedBaselineId: state.basis.baselineId,
      loadWorkspaceDoc: () => { assertLive(); return this.loadWorkspaceDoc(state.workspaceId) },
      loadCausalEvidence: () => { assertLive(); return this.loadCausalEvidence(state.workspaceId) },
      getVerifiedReceivedHistoryBaseline: () => {
        assertLive()
        return this.historyProgressForRead(state.workspaceId).then(progress =>
          this.getVerifiedReceivedHistoryBaseline(state.workspaceId, assertCurrent, progress))
      },
      readDeltaFrontier: () => { assertLive(); return this.readDeltaFrontier(state.workspaceId) },
      readDeltaWorkspace: () => { assertLive(); return this.readDeltaWorkspace(state.workspaceId) },
      readWorkspaceBasisSnapshot: () => { assertLive(); return readWorkspaceBasisSnapshot(state.workspaceId) },
      invalidateAuthorityBasis: async () => {
        assertLive()
        await this.invalidateAuthorityBasis(state.workspaceId, state.basis, assertCurrent)
        this.delta.forget(state.workspaceId)
        state.used = true
      },
      commitDelta: (frontier, delta, doc) => {
        assertLive()
        state.used = true
        return this.commitDelta(frontier, delta, doc, state.basis.revision, assertCurrent)
      },
      installDeltaBasis: (snapshot, frontier, authorizations, doc) => this.installCapturedDeltaBasis(
        state, snapshot, frontier, authorizations, doc, assertLive, assertCurrent),
      commitWorkspace: (doc, bytes, authorizations, command, causalEvidence, onPhase, compactChangeHashes) => {
        assertLive()
        state.used = true
        return this.commitWorkspaceAtRevision(state.workspaceId, doc, bytes, authorizations, command, causalEvidence,
          onPhase, state.basis, compactChangeHashes ?? [], assertCurrent)
      },
    }
    return Object.freeze(context)
  }

  private async installCapturedDeltaBasis(state: WorkspaceTransactionState, snapshot: StoredWorkspaceSnapshot,
    frontier: WorkspaceDeltaFrontier, authorizations: WorkspaceChangeAuthorization[], doc: Automerge.Doc<WorkspaceDocumentV2>,
    assertLive: () => void, assertCurrent: () => void): Promise<boolean> {
    assertLive()
    const nextRevision = crypto.randomUUID()
    const installed = await this.installDeltaBasis(snapshot, frontier, authorizations, doc, state.basis.revision,
      assertCurrent, nextRevision)
    if (!installed) return false
    state.basis = { ...state.basis, revision: nextRevision, frontier: structuredClone(frontier) }
    state.used = true
    return true
  }

  private async runAuthorityMutation<T>(workspaceId: string, transaction: WorkspaceTransactionContext,
    operation: (context: WorkspaceAuthorityMutationContext) => Promise<T>): Promise<T> {
    if (!isLiveWorkspaceTransaction(transaction as object, workspaceId, this)) throw new WorkspaceRevisionConflict()
    const state: WorkspaceAuthorityMutationState = {
      storage: this, workspaceId, live: true,
      contextCurrent: () => isLiveWorkspaceTransaction(transaction as object, workspaceId, this),
      write: operation => this.writeAuthorityMutation(state, transaction, operation),
    }
    const context = Object.freeze({ workspaceId, write: <R>(write: () => Promise<R>) => state.write(write) })
    workspaceAuthorityMutationStates.set(context, state)
    try {
      return await operation(context)
    } finally {
      state.live = false
      workspaceAuthorityMutationStates.delete(context)
    }
  }

  private async writeAuthorityMutation<T>(state: WorkspaceAuthorityMutationState, transaction: WorkspaceTransactionContext,
    operation: () => Promise<T>): Promise<T> {
    if (!state.live || !state.contextCurrent()) throw new WorkspaceRevisionConflict()
    if (!state.invalidation) state.invalidation = transaction.invalidateAuthorityBasis()
    await state.invalidation
    if (!state.live || !state.contextCurrent()) throw new WorkspaceRevisionConflict()
    return operation()
  }

  private assertTransactionCurrent(state: WorkspaceTransactionState): void {
    if (!isCurrentWorkspaceTransaction(state.context, state, this)) throw new WorkspaceRevisionConflict()
  }

  private async invalidateAuthorityBasis(workspaceId: string, basis: WorkspaceRevisionBasis,
    ensureCurrent: () => void): Promise<void> {
    this.checkDeltaWrites()
    const nextRevision = crypto.randomUUID()
    if (typeof indexedDB === "undefined") {
      updateLocalJournal(workspaceId, journal => {
        ensureCurrent()
        this.assertBasisMatches(journal.revision ?? null, journal.frontier ?? null,
          journal.snapshot?.receivedHistory?.baselineId ?? null, basis)
        return { ...journal, frontier: journal.frontier ? { ...journal.frontier, invalidated: true } : undefined,
          revision: nextRevision }
      })
      return
    }
    const database = await openWorkspaceJournal()
    const transaction = database.transaction(["frontiers", "revisions", "snapshots"], "readwrite")
    const completion = transactionDone(transaction)
    try {
      const [frontier, revision, snapshot] = await Promise.all([
        requestResult(transaction.objectStore("frontiers").get(workspaceId)) as Promise<WorkspaceDeltaFrontier | undefined>,
        requestResult(transaction.objectStore("revisions").get(workspaceId)) as Promise<{ revision: string } | undefined>,
        requestResult(transaction.objectStore("snapshots").get(workspaceId)) as Promise<StoredWorkspaceSnapshot | undefined>,
      ])
      ensureCurrent()
      this.assertBasisMatches(revision?.revision ?? null, frontier ?? null,
        snapshot?.receivedHistory?.baselineId ?? null, basis)
      if (frontier) transaction.objectStore("frontiers").put({ ...frontier, invalidated: true })
      transaction.objectStore("revisions").put({ id: workspaceId, workspaceId, revision: nextRevision })
    } catch (error) {
      transaction.abort()
      await completion.catch(() => undefined)
      throw error
    }
    await completion
  }

  private assertBasisMatches(revision: string | null, frontier: WorkspaceDeltaFrontier | null,
    baselineId: string | null, basis: WorkspaceRevisionBasis): void {
    if (revision !== basis.revision || canonicalizeJson(frontier) !== canonicalizeJson(basis.frontier) ||
        baselineId !== basis.baselineId) throw new WorkspaceRevisionConflict()
  }
}
