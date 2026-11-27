import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "./domain/identity"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { openWorkspaceJournal } from "./storageJournal"
import { WorkspaceDeltaJournal, createDeltaWorkspaceDocument, type StoredWorkspaceDelta, type WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"

type Checked = NonNullable<Awaited<ReturnType<WorkspaceDeltaJournal["read"]>>>
type Entry = { checked: Checked; document: Automerge.Doc<WorkspaceDocumentV2> }

export class StorageDeltaRepository {
  private entries = new Map<string, Entry>()

  async journal() {
    return new WorkspaceDeltaJournal(typeof indexedDB === "undefined" ? undefined : await openWorkspaceJournal())
  }

  async frontier(workspaceId: string) { return (await this.journal()).readFrontier(workspaceId) }

  forget(workspaceId: string) {
    const entry = this.entries.get(workspaceId)
    if (entry) Automerge.free(entry.document)
    this.entries.delete(workspaceId)
  }

  remember(checked: Checked, doc: Automerge.Doc<WorkspaceDocumentV2>) {
    this.forget(checked.frontier.workspaceId)
    this.entries.set(checked.frontier.workspaceId, { checked, document: Automerge.clone(doc) })
    if (this.entries.size > 8) this.forget(this.entries.keys().next().value!)
  }

  async read(workspaceId: string): Promise<Checked | undefined> {
    const frontier = await this.frontier(workspaceId)
    if (!frontier) { this.forget(workspaceId); return }
    const cached = this.entries.get(workspaceId)
    if (cached && canonicalizeJson(cached.checked.frontier) === canonicalizeJson(frontier)) return cached.checked
    const appended = cached && await this.readAppended(cached)
    if (appended) return appended
    const checked = await (await this.journal()).read(workspaceId)
    if (checked) {
      const doc = createDeltaWorkspaceDocument(checked)
      this.remember(checked, doc)
      Automerge.free(doc)
    } else this.forget(workspaceId)
    return checked
  }

  async loadDocument(workspaceId: string, reusable?: Automerge.Doc<WorkspaceDocumentV2>) {
    const frontier = await this.frontier(workspaceId)
    if (!frontier || frontier.invalidated) return
    const cached = this.entries.get(workspaceId)
    const candidate = reusable ?? cached?.document
    if (cached && canonicalizeJson(cached.checked.frontier) === canonicalizeJson(frontier) &&
      candidate?.id === workspaceId && Automerge.getHeads(candidate).sort().join() === frontier.heads.join())
      return { doc: Automerge.clone(candidate), heads: [...frontier.heads], frontier }
    const checked = await this.read(workspaceId)
    if (checked) return this.projectChecked(checked)
  }

  async loadWarmDocument(workspaceId: string) {
    if (!this.entries.has(workspaceId)) return
    const frontier = await this.frontier(workspaceId)
    if (!frontier || frontier.invalidated) return
    const cached = this.entries.get(workspaceId)
    if (!cached || cached.checked.basis.receivedHistory) return
    if (canonicalizeJson(cached.checked.frontier) === canonicalizeJson(frontier)) return this.projectChecked(cached.checked)
    const checked = await this.readAppended(cached)
    if (checked) return this.projectChecked(checked)
  }

  private projectChecked(checked: Checked) {
    const current = this.entries.get(checked.frontier.workspaceId)
    const doc = current && canonicalizeJson(current.checked.frontier) === canonicalizeJson(checked.frontier)
      ? Automerge.clone(current.document) : createDeltaWorkspaceDocument(checked)
    return { doc, heads: [...checked.frontier.heads], frontier: checked.frontier }
  }

  private async readAppended(cached: Entry) {
    // A concurrent read or append can replace the cached entry across awaits.
    const document = Automerge.clone(cached.document)
    try {
      const tail = await (await this.journal()).readAfter(cached.checked.frontier)
      if (!tail) return
      const { inheritLocalMoveAccess } = await import("./sync/workspaceAccess")
      const checked = { ...cached.checked, frontier: tail.frontier, deltas: [...cached.checked.deltas, ...tail.deltas] }
      const doc = createDeltaWorkspaceDocument(checked, { document, revision: cached.checked.frontier.revision })
      try {
        inheritLocalMoveAccess(document, doc)
        this.remember(checked, doc)
        return checked
      } finally { Automerge.free(doc) }
    } finally { Automerge.free(document) }
  }

  async append(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, doc: Automerge.Doc<WorkspaceDocumentV2>,
    expectedRevision: string | null, ensureCurrent: () => void) {
    const next = await (await this.journal()).append(frontier, delta, expectedRevision, ensureCurrent)
    const entry = this.entries.get(frontier.workspaceId)
    if (entry && next.revision === delta.sequence && next.chainHash === delta.chainHash &&
      canonicalizeJson(entry.checked.frontier) === canonicalizeJson(frontier)) {
      this.remember({ ...entry.checked, frontier: next, deltas: [...entry.checked.deltas, delta] }, doc)
    } else this.forget(frontier.workspaceId)
    return next
  }
}
