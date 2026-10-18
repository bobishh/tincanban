import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2, Heads } from "./domain/model"
import { listCommittedWorkspaces, readWorkspaceBasisSnapshot } from "./storageJournal"

export type WorkspaceMeta = { id: string; title: string; updatedAt: string; archivedAt?: string | null }

export function partitionCatalog(records: WorkspaceMeta[]) {
  return {
    available: records.filter(record => !record.archivedAt),
    archived: records.filter(record => Boolean(record.archivedAt)),
  }
}

export function includesWorkspaceHeads(doc: Automerge.Doc<WorkspaceDocumentV2>, heads: Heads): boolean {
  const changes = new Map(Automerge.getChangesMetaSince(doc, []).map(change => [change.hash, change.deps] as const))
  const reachable = new Set<string>()
  const pending = [...Automerge.getHeads(doc)]
  while (pending.length) {
    const hash = pending.pop()!
    if (reachable.has(hash)) continue
    reachable.add(hash)
    pending.push(...(changes.get(hash) ?? []))
  }
  return heads.every(hash => reachable.has(hash))
}

/** The committed journal is the only catalog source. */
export async function readWorkspaceCatalogRecords(): Promise<WorkspaceMeta[]> {
  const snapshots = await listCommittedWorkspaces()
  return Promise.all(snapshots.map(async snapshot => ({ ...snapshot,
    archivedAt: snapshot.archivedAt === undefined
      ? (await readWorkspaceBasisSnapshot(snapshot.id))?.archivedAt ?? null : snapshot.archivedAt,
  })))
}
