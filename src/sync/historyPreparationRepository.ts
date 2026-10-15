import { BrowserMeshStore, MemoryMeshStore } from "@meta-uber/mesh-browser-store"
import { createHistoryPreparationJournal, type HistoryPreparationIdentity } from "@meta-uber/mesh-replication/history-preparation-journal"

const memory = new MemoryMeshStore()

/** Separate private records; this repository never changes the active workspace or grants baseline authority. */
export function createWorkspaceHistoryPreparation(identity: HistoryPreparationIdentity, ensureCurrent: () => void) {
  const store = typeof indexedDB === "undefined" ? memory : new BrowserMeshStore("tincanban-history-preparations-v1", ["records"])
  return createHistoryPreparationJournal(identity, {
    read: key => store.get<string>("records", key),
    scan: (prefix, after, limit) => store.scan<string>("records", prefix, after, limit),
    compareAndSwap: (conditions, writes, guard) => store.compareAndSwap(conditions.map(item => ({ ...item, store: "records" })),
      writes.map(item => ({ ...item, type: "put", store: "records" })), guard),
  }, ensureCurrent)
}
