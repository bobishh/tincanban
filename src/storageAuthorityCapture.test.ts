import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { WorkspaceStorage, WorkspaceRevisionConflict, isWorkspaceAuthorityMutation } from "./storage"
import { openWorkspaceJournal, requestResult, transactionDone, type StoredWorkspaceSnapshot } from "./storageJournal"

beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
})

async function savedBasis(progress: "current" | "missing" | "invalid" | "mismatched" = "current") {
  const id = crypto.randomUUID()
  const snapshot: StoredWorkspaceSnapshot = { id, workspaceId: id, title: "Retained board", heads: ["retained-head"],
    bytes: new Uint8Array(4 * 1024 * 1024).fill(137), savedAt: "2026-10-28T12:00:00.000Z",
    receivedHistory: { baselineId: "A".repeat(43), excludedLocalChangeHashes: [] } }
  const database = await openWorkspaceJournal()
  const transaction = database.transaction(["snapshots", "historyProgress", "revisions"], "readwrite")
  const done = transactionDone(transaction)
  transaction.objectStore("snapshots").put(snapshot)
  transaction.objectStore("revisions").put({ id, workspaceId: id, revision: "retained-revision" })
  if (progress !== "missing") transaction.objectStore("historyProgress").put({ id, workspaceId: id,
    baselineId: progress === "mismatched" ? "B".repeat(43) : snapshot.receivedHistory!.baselineId,
    admittedChanges: progress === "invalid" ? -1 : 0, encodedBytes: 0 })
  await done
  return { id, snapshot, database, storage: new WorkspaceStorage() }
}

function snapshotReads(contexts: unknown[]) {
  return contexts.filter(store => store instanceof IDBObjectStore && store.name === "snapshots").length
}

describe("workspace authority capture", () => {
  it("Given retained board bytes and current history metadata, When unchanged authority enters repeatedly, Then capture reads no board snapshots and preserves bytes and revision", async () => {
    const { id, snapshot, database, storage } = await savedBasis()
    const reads = vi.spyOn(IDBObjectStore.prototype, "get")
    try {
      for (let index = 0; index < 9; index++) await storage.withWorkspaceAuthorityMutation(id, async context => {
        expect(isWorkspaceAuthorityMutation(context, id, storage)).toBe(true)
      })
      await storage.withWorkspaceTransaction(id, async context => {
        expect(context.capturedBaselineId).toBe(snapshot.receivedHistory!.baselineId)
      })
      expect(snapshotReads(reads.mock.contexts)).toBe(0)
    } finally { reads.mockRestore() }
    expect(await storage.readWorkspaceRevision(id)).toBe("retained-revision")
    const transaction = database.transaction("snapshots", "readonly")
    const done = transactionDone(transaction)
    const retained = await requestResult(transaction.objectStore("snapshots").get(id)) as StoredWorkspaceSnapshot
    await done
    expect(retained.receivedHistory).toEqual(snapshot.receivedHistory)
    expect(retained.bytes.byteLength).toBe(snapshot.bytes.byteLength)
    expect(retained.bytes.every(byte => byte === 137)).toBe(true)
  })

  it.each(["missing", "invalid"] as const)("Given %s legacy history metadata, When authority captures its basis, Then derive the actual baseline without writing a repair", async progress => {
    const { id, snapshot, storage } = await savedBasis(progress)
    const reads = vi.spyOn(IDBObjectStore.prototype, "get")
    try {
      await storage.withWorkspaceTransaction(id, async context => {
        expect(context.capturedBaselineId).toBe(snapshot.receivedHistory!.baselineId)
      })
      expect(snapshotReads(reads.mock.contexts)).toBeGreaterThan(0)
    } finally { reads.mockRestore() }
    expect(await storage.readWorkspaceRevision(id)).toBe("retained-revision")
  })

  it("Given missing legacy metadata and a frontier awaiting repair, When capturing authority, Then read the raw snapshot baseline without materializing that frontier", async () => {
    const { id, snapshot, database, storage } = await savedBasis("missing")
    const transaction = database.transaction("frontiers", "readwrite")
    const done = transactionDone(transaction)
    transaction.objectStore("frontiers").put({ id, workspaceId: id, generation: "repair-generation", revision: 1,
      basisHash: "outdated-basis", basisHeads: snapshot.heads, basisSavedAt: snapshot.savedAt,
      authorityFingerprint: "authority", policy: "policy", heads: snapshot.heads, chainHash: "old-chain",
      title: snapshot.title, archivedAt: null, savedAt: snapshot.savedAt })
    await done
    await storage.withWorkspaceTransaction(id, async context => {
      expect(context.capturedBaselineId).toBe(snapshot.receivedHistory!.baselineId)
    })
    expect(await storage.readWorkspaceRevision(id)).toBe("retained-revision")
  })

  it("Given stale history metadata, When authority attempts a write, Then the actual snapshot comparison rejects before changing authority or revision", async () => {
    const { id, storage } = await savedBasis("mismatched")
    const persistAuthority = vi.fn(async () => {})
    await expect(storage.withWorkspaceAuthorityMutation(id, context => context.write(persistAuthority))).rejects.toBeInstanceOf(WorkspaceRevisionConflict)
    expect(persistAuthority).not.toHaveBeenCalled()
    expect(await storage.readWorkspaceRevision(id)).toBe("retained-revision")
  })

  it("Given current history metadata, When a cross-database authority write fails, Then the admission revision was invalidated first", async () => {
    const { id, storage } = await savedBasis()
    await expect(storage.withWorkspaceAuthorityMutation(id, context => context.write(async () => {
      expect(await storage.readWorkspaceRevision(id)).not.toBe("retained-revision")
      throw new Error("authority database write failed")
    }))).rejects.toThrow("authority database write failed")
    expect(await storage.readWorkspaceRevision(id)).not.toBe("retained-revision")
  })
})
