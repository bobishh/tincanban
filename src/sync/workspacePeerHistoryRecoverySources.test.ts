import { IDBFactory } from "fake-indexeddb"
import { afterEach, expect, it, vi } from "vitest"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"

afterEach(() => vi.unstubAllGlobals())
async function fixture() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const { openWorkspaceJournal, transactionDone } = await import("../storageJournal")
  const { workspacePeerHistoryRecoverySources } = await import("./workspacePeerHistoryRecoverySources")
  const database = await openWorkspaceJournal(), workspaceId = "peer-history", baselineId = "A".repeat(43)
  const bytes = new Uint8Array([1, 2, 3]), objectId = await sha256Base64Url(bytes)
  const signedJson = new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId, baselineId, historyEpoch: 2 } }))
  const row = { id: `${workspaceId}:baseline:${baselineId}`, workspaceId, baselineId, state: "active", stageId: "stage",
    signedJson, document: new Uint8Array([8]), encryptedObjects: [], createdAt: "2026-10-15T00:00:00Z",
    peerProofs: { version: 1, objects: [{ objectId, bytes }] } }
  const transaction = database.transaction("receivedBaselines", "readwrite")
  transaction.objectStore("receivedBaselines").put(row)
  await transactionDone(transaction)
  return { workspaceId, baselineId, bytes, objectId, row, database, transactionDone, workspacePeerHistoryRecoverySources,
    binding: { workspaceId, historyEpoch: 2, indexId: "catalogue", objectKind: "record" as const, partIndex: 0, partCount: 1 } }
}

it("Given saved peer proof bytes without Rusty credentials, when collecting recovery sources, then read originals locally and request only missing archive data", async () => {
  const f = await fixture(), remote = vi.fn(async () => undefined)
  const sources = await f.workspacePeerHistoryRecoverySources("person", f.workspaceId, () => {}, remote)
  expect(sources).toHaveLength(1)
  expect(await sources[0]!.read(f.objectId, f.binding)).toEqual(f.bytes)
  expect(remote).not.toHaveBeenCalled()
  expect(await sources[0]!.read("B".repeat(43), f.binding)).toBeUndefined()
  expect(remote).toHaveBeenCalledWith(f.workspaceId, f.baselineId, "B".repeat(43), f.binding)
  await expect(sources[0]!.read(f.objectId, { ...f.binding, workspaceId: "another-board" })).rejects.toThrow(/another source/i)
})

it("Given identity access lost after source discovery, when reading an archive object, then return no retained bytes or remote request", async () => {
  const f = await fixture(), remote = vi.fn(async () => undefined)
  let current = true
  const sources = await f.workspacePeerHistoryRecoverySources("person", f.workspaceId, () => { if (!current) throw new Error("Access revoked") }, remote)
  current = false
  await expect(sources[0]!.read(f.objectId, f.binding)).rejects.toThrow("Access revoked")
  expect(remote).not.toHaveBeenCalled()
})

it("Given the same baseline ID with conflicting original signature bytes, when collecting sources, then refuse rather than choose a history by row order", async () => {
  const f = await fixture(), transaction = f.database.transaction("receivedBaselines", "readwrite")
  transaction.objectStore("receivedBaselines").put({ ...f.row, id: "other-row", stageId: "other-stage",
    signedJson: new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId: f.workspaceId, baselineId: f.baselineId, historyEpoch: 3 } })) })
  await f.transactionDone(transaction)
  await expect(f.workspacePeerHistoryRecoverySources("person", f.workspaceId, () => {})).rejects.toThrow(/conflicting original/i)
})
