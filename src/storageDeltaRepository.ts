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
    if (cached) {
      // Own a handle across awaits; another read or append can replace the cached entry.
      const document = Automerge.clone(cached.document)
      try {
        const tail = await (await this.journal()).readAfter(cached.checked.frontier)
        if (tail) {
          const checked = { ...cached.checked, frontier: tail.frontier, deltas: [...cached.checked.deltas, ...tail.deltas] }
          const doc = createDeltaWorkspaceDocument(checked, { document, revision: cached.checked.frontier.revision })
          const { inheritLocalMoveAccess } = await import("./sync/workspaceAccess")
          inheritLocalMoveAccess(document, doc)
          this.remember(checked, doc)
          Automerge.free(doc)
          return checked
        }
      } finally { Automerge.free(document) }
    }
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
    if (!frontier || frontier.invalidated) return undefined
    const cached = this.entries.get(workspaceId)
    const candidate = reusable ?? cached?.document
    if (cached && canonicalizeJson(cached.checked.frontier) === canonicalizeJson(frontier) &&
      candidate?.id === workspaceId && Automerge.getHeads(candidate).sort().join() === frontier.heads.join())
      return { doc: Automerge.clone(candidate), heads: [...frontier.heads] }
    const checked = await this.read(workspaceId)
    return checked ? { doc: Automerge.clone(this.entries.get(workspaceId)!.document), heads: [...checked.frontier.heads] } : undefined
  }

  async append(frontier: WorkspaceDeltaFrontier, delta: StoredWorkspaceDelta, doc: Automerge.Doc<WorkspaceDocumentV2>) {
    const next = await (await this.journal()).append(frontier, delta)
    const entry = this.entries.get(frontier.workspaceId)
    if (entry && next.revision === delta.sequence && next.chainHash === delta.chainHash &&
      canonicalizeJson(entry.checked.frontier) === canonicalizeJson(frontier)) {
      this.remember({ ...entry.checked, frontier: next, deltas: [...entry.checked.deltas, delta] }, doc)
    } else this.forget(frontier.workspaceId)
    return next
  }
}
