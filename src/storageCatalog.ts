import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2, Heads } from "./domain/model"
import { fromBase64Url } from "./domain/identity"
import { getStorageRaw, setStorageRaw, storageKeys } from "./storageRaw"
import { listCommittedWorkspaces, readWorkspaceSnapshot, type CommittedWorkspaceMeta } from "./storageJournal"

const workspaceMetaPrefix = "tincanban.workspace-meta."
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

async function repairLegacyCatalog(records: Map<string, WorkspaceMeta>, snapshots: CommittedWorkspaceMeta[]): Promise<void> {
  const committedIds = new Set(snapshots.map(snapshot => snapshot.id))
  for (const record of records.values()) {
    if (committedIds.has(record.id)) continue
    const key = `${workspaceMetaPrefix}${record.id}`
    if (await getStorageRaw(key) === null) await setStorageRaw(key, JSON.stringify(record))
  }
}

// Catalog recovery and migration check independent storage paths.
export async function readWorkspaceCatalogRecords(): Promise<WorkspaceMeta[]> {
  const records = new Map<string, WorkspaceMeta>()
  const keys = await storageKeys()
  await readLegacyCatalog(records, keys)
  const snapshots = await listCommittedWorkspaces()
  await mergeCommittedCatalog(records, snapshots)
  await repairLegacyCatalog(records, snapshots)
  return [...records.values()]
}

function acceptCatalogRecord(records: Map<string, WorkspaceMeta>, value: WorkspaceMeta) {
  if (value && typeof value.id === "string" && typeof value.title === "string") records.set(value.id, value)
}

async function readLegacyCatalog(records: Map<string, WorkspaceMeta>, keys: string[]) {
  for (const key of keys.filter(key => key.startsWith(workspaceMetaPrefix))) {
    try {
      const raw = await getStorageRaw(key)
      if (raw) acceptCatalogRecord(records, JSON.parse(raw) as WorkspaceMeta)
    } catch { /* Recover from the snapshot below. */ }
  }
  for (const key of keys.filter(key => key.startsWith("tincanban.snapshot."))) {
    const id = key.slice("tincanban.snapshot.".length)
    if (records.has(id)) continue
    const recovered = await recoverSnapshotCatalogRecord(key, id)
    if (recovered) acceptCatalogRecord(records, recovered)
  }
}

async function recoverSnapshotCatalogRecord(key: string, id: string): Promise<WorkspaceMeta | null> {
  let doc: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    const raw = await getStorageRaw(key)
    if (!raw) return null
    const saved = JSON.parse(raw) as { bytesBase64?: string; savedAt?: string } | number[]
    const bytes = Array.isArray(saved) ? new Uint8Array(saved) : saved.bytesBase64 ? fromBase64Url(saved.bytesBase64) : new Uint8Array()
    doc = Automerge.load<WorkspaceDocumentV2>(bytes)
    return doc.id === id && typeof doc.title === "string"
      ? { id, title: doc.title, updatedAt: Array.isArray(saved) ? "" : saved.savedAt ?? "", archivedAt: doc.archivedAt ?? null }
      : null
  } catch { return null } // Preserve unreadable data for manual recovery.
  finally { if (doc) Automerge.free(doc) }
}

async function mergeCommittedCatalog(records: Map<string, WorkspaceMeta>, snapshots: CommittedWorkspaceMeta[]) {
  for (const snapshot of snapshots) {
    const previous = records.get(snapshot.id)
    const committed = snapshot.archivedAt === undefined && (!previous || previous.updatedAt < snapshot.updatedAt) ? await readWorkspaceSnapshot(snapshot.id) : null
    acceptCatalogRecord(records, { ...snapshot, archivedAt: snapshot.archivedAt === undefined
      ? committed?.archivedAt ?? previous?.archivedAt ?? null : snapshot.archivedAt })
  }
}
