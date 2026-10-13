import type * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { StorageDeltaRepository } from "./storageDeltaRepository"
import type { StoredWorkspaceDelta, WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { openWorkspaceJournal, readWorkspaceSnapshot, requestResult, transactionDone, type StoredWorkspaceSnapshot, type StoredCausalEvidence } from "./storageJournal"
import { cloneCausalEvidence } from "./causalEvidence"

export abstract class StorageDeltaAccess {
  protected abstract checkDeltaWrites(): void
  abstract registerWorkspace(id: string, title: string, archivedAt?: string | null, allowRestore?: boolean): Promise<void>
  protected delta = new StorageDeltaRepository()

  async readDeltaFrontier(workspaceId: string) { return this.delta.frontier(workspaceId) }
  async readDeltaWorkspace(workspaceId: string) { return this.delta.read(workspaceId) }
  async installDeltaBasis(snapshot: StoredWorkspaceSnapshot, frontier: WorkspaceDeltaFrontier,
    authorizations: WorkspaceChangeAuthorization[], doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.checkDeltaWrites()
    const installed = await (await this.delta.journal()).install(snapshot, frontier, authorizations)
    if (installed) this.delta.remember({ basis: snapshot, frontier, deltas: [] }, doc)
    return installed
  }
  async commitDelta(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.checkDeltaWrites()
    const next = await this.delta.append(frontier, delta, doc)
    await this.registerWorkspace(doc.id, doc.title, doc.archivedAt ?? null, true)
    return next
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
    return cloneCausalEvidence(snapshot?.causalEvidence)
  }

  protected async clearDeltaRows(transaction: IDBTransaction, workspaceId: string) {
    transaction.objectStore("frontiers").delete(workspaceId)
    const deltas = transaction.objectStore("deltas")
    const keys = await requestResult(deltas.index("workspaceId").getAllKeys(workspaceId))
    for (const key of keys) deltas.delete(key)
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
