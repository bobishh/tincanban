import { Buffer } from "node:buffer"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { beforeAll, expect, it, vi } from "vitest"
import { fromBase64Url } from "../domain/identity"
import { openWorkspaceJournal, requestResult, transactionDone } from "../storageJournal"
import { createWorkspaceHistoryRecoveryEvidence } from "./workspaceHistoryRecoveryEvidence"
import { decodeWorkspaceRecoveryEvidence } from "./workspaceHistoryRecoveryDecode"

beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})

async function seed() {
  const workspaceId = crypto.randomUUID(), database = await openWorkspaceJournal()
  const transaction = database.transaction(["snapshots", "changes", "revisions"], "readwrite"), done = transactionDone(transaction)
  const bytes = new Uint8Array(600 * 1024).fill(19)
  transaction.objectStore("snapshots").put({ id: workspaceId, workspaceId, bytes, heads: ["head"], title: "original", savedAt: "original-time" })
  transaction.objectStore("changes").put({ id: `${workspaceId}:change`, workspaceId, changeHash: "original-change", bytes: new Uint8Array([7, 8, 9]), addedAt: "original-time" })
  transaction.objectStore("revisions").put({ id: workspaceId, workspaceId, revision: "captured-revision" })
  await done
  return { workspaceId, database, bytes }
}

it("Given exact current source bytes and original journal records, when backing up, then retain bounded binary parts and unchanged metadata", async () => {
  const f = await seed(), capture = await createWorkspaceHistoryRecoveryEvidence(f.workspaceId, () => {}), records = []
  for await (const record of capture.evidence) records.push(record)
  await capture.assertUnchanged()
  const metadata = records.filter(record => record.category === "snapshots-metadata")
  expect(metadata).toHaveLength(1)
  const metadataValue = JSON.parse(new TextDecoder().decode(fromBase64Url(metadata[0]!.data)))
  expect(metadataValue.record).toMatchObject({ workspaceId: f.workspaceId, title: "original", savedAt: "original-time", bytes: null })
  const field = metadataValue.binaryFields.find((field: { path: string[] }) => field.path.join("/") === "bytes")
  expect(field.byteLength).toBe(f.bytes.length)
  const parts = records.filter(record => record.id === field.id)
  expect(parts).toHaveLength(3)
  const decodedParts = parts.map(record => Buffer.from(fromBase64Url(record.data)))
  expect(decodedParts.every(bytes => bytes.length <= 256 * 1024)).toBe(true)
  expect(Buffer.concat(decodedParts).equals(f.bytes)).toBe(true)
  const transaction = f.database.transaction("snapshots", "readonly"), done = transactionDone(transaction)
  const unchanged = await requestResult(transaction.objectStore("snapshots").get(f.workspaceId)) as { bytes: Uint8Array }
  await done
  expect(Buffer.from(unchanged.bytes).equals(f.bytes)).toBe(true)
})

it("Given a workspace changes during export, when final source consistency is checked, then refuse a completion claim", async () => {
  const f = await seed(), capture = await createWorkspaceHistoryRecoveryEvidence(f.workspaceId, () => {})
  const transaction = f.database.transaction("revisions", "readwrite"), done = transactionDone(transaction)
  transaction.objectStore("revisions").put({ id: f.workspaceId, workspaceId: f.workspaceId, revision: "concurrent-revision" })
  await done
  await expect(capture.assertUnchanged()).rejects.toThrow(/changed/i)
})

it("Given another board's journal records, when capturing one workspace, then keep that board out of the private recovery stream", async () => {
  const selected = await seed(), other = await seed(), capture = await createWorkspaceHistoryRecoveryEvidence(selected.workspaceId, () => {})
  const metadata: string[] = []
  for await (const record of capture.evidence) if (record.category.endsWith("-metadata")) metadata.push(new TextDecoder().decode(fromBase64Url(record.data)))
  expect(metadata.join("\n")).toContain(selected.workspaceId)
  expect(metadata.join("\n")).not.toContain(other.workspaceId)
})

it("Given archived original rows, when exporting then decoding private recovery, then retain their exact bytes and authorization evidence", async () => {
  const f = await seed(), tx = f.database.transaction(["archivedChanges", "archivedAuthorizations"], "readwrite"), done = transactionDone(tx)
  const change = { id: `${f.workspaceId}:old-change`, workspaceId: f.workspaceId, bytes: new Uint8Array([31, 32, 33]),
    changeHash: "old-change", archivedUnderBaselineId: "previous-baseline", addedAt: "original-time" }
  const proofs = { id: `${f.workspaceId}:old-proofs`, workspaceId: f.workspaceId,
    records: [{ signature: "exact-original-proof" }], baselineId: "previous-baseline" }
  tx.objectStore("archivedChanges").put(change)
  tx.objectStore("archivedAuthorizations").put(proofs)
  await done
  const capture = await createWorkspaceHistoryRecoveryEvidence(f.workspaceId, () => {}), records = []
  for await (const record of capture.evidence) records.push(record)
  const decoded = await decodeWorkspaceRecoveryEvidence(records, f.workspaceId)
  expect(decoded.journal.archivedChanges).toEqual([{ id: change.id, value: change }])
  expect(decoded.journal.archivedAuthorizations).toEqual([{ id: proofs.id, value: proofs }])
  expect(decoded.journal.changes).toHaveLength(1)
  await capture.assertUnchanged()
})
