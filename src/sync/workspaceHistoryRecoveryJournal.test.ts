import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson } from "../domain/identity"
import { defaultStorage } from "../storage"
import { openWorkspaceJournal, requestResult, transactionDone } from "../storageJournal"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"
import { readPendingWorkspaceRecoveryActivation, readStoredWorkspaceRecoveryCopy,
  readStoredWorkspaceRecoveryImport, restoreWorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryJournal"

const workspaceId = "recovery-journal-workspace"
const personId = "recovery-journal-person"
let recoveryId: string
const stores = ["changes", "archivedChanges", "proofs", "receipts", "snapshots", "authorizations", "archivedAuthorizations", "frontiers", "deltas", "revisions", "receivedBaselines"] as const
let database: IDBDatabase
type RestoreOptions = Omit<Parameters<typeof restoreWorkspaceRecoveryJournal>[2], "transaction">

function restoreCandidate(options: RestoreOptions, rows = candidate()): Promise<void> {
  return defaultStorage.withWorkspaceTransaction(workspaceId, transaction =>
    restoreWorkspaceRecoveryJournal(workspaceId, rows, { ...options, transaction }))
}

function candidate(title = "Recovered"): WorkspaceRecoveryJournal {
  return {
    changes: [{ id: `${workspaceId}:change-new`, value: { id: `${workspaceId}:change-new`, workspaceId, content: "new change" } }],
    archivedChanges: [], archivedAuthorizations: [], proofs: [], receipts: [], snapshots: [{ id: workspaceId, value: { id: workspaceId, workspaceId, title, savedAt: "2026-10-15T00:00:00.000Z" } }],
    authorizations: [], frontiers: [], deltas: [], revisions: [], receivedBaselines: [],
  }
}

async function getRows(name: typeof stores[number]): Promise<unknown[]> {
  const tx = database.transaction(name, "readonly"), done = transactionDone(tx)
  const rows = await requestResult(tx.objectStore(name).index("workspaceId").getAll(workspaceId))
  await done
  return rows as unknown[]
}

async function seedOriginal() {
  const tx = database.transaction([...stores], "readwrite"), done = transactionDone(tx)
  tx.objectStore("snapshots").put({ id: workspaceId, workspaceId, title: "Original", savedAt: "2026-10-14T00:00:00.000Z" })
  tx.objectStore("changes").put({ id: `${workspaceId}:change-old`, workspaceId, content: new Uint8Array([1, 2, 3]) })
  tx.objectStore("proofs").put({ id: `${workspaceId}:proof-old`, workspaceId, proof: "retained" })
  tx.objectStore("receipts").put({ id: `${workspaceId}:receipt-old`, workspaceId, receipt: "retained" })
  tx.objectStore("receivedBaselines").put({ id: `${workspaceId}:baseline-old`, workspaceId, baseline: "retained" })
  tx.objectStore("archivedChanges").put({ id: `${workspaceId}:archived-old`, workspaceId, bytes: new Uint8Array([8, 9]), archivedUnderBaselineId: "previous-basis" })
  tx.objectStore("archivedAuthorizations").put({ id: `${workspaceId}:archived-proofs-old`, workspaceId, records: [{ original: "unchanged" }] })
  tx.objectStore("revisions").put({ id: workspaceId, workspaceId, revision: "before-recovery" })
  await done
}

beforeAll(async () => {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? options as () => Promise<unknown>)() } })
  vi.stubGlobal("indexedDB", new IDBFactory())
  database = await openWorkspaceJournal()
})

beforeEach(async () => {
  recoveryId = crypto.randomUUID()
  const tx = database.transaction([...stores, "historyProgress"], "readwrite"), done = transactionDone(tx)
  for (const name of stores) tx.objectStore(name).clear()
  tx.objectStore("historyProgress").clear()
  await done
})

async function putProgress(value: Record<string, unknown>) {
  const tx = database.transaction("historyProgress", "readwrite"), done = transactionDone(tx)
  tx.objectStore("historyProgress").put({ id: workspaceId, workspaceId, baselineId: null, admittedChanges: 12, encodedBytes: 4096, ...value })
  await done
}
async function readProgress(): Promise<unknown> {
  const tx = database.transaction("historyProgress", "readonly"), done = transactionDone(tx)
  const value = await requestResult(tx.objectStore("historyProgress").get(workspaceId))
  await done
  return value
}

it("Given an unfinished history transition with frozen workers, when restoring a backup, then preserve target rows and transition without creating an activation", async () => {
  await seedOriginal()
  const transitionId = crypto.randomUUID()
  await putProgress({ transitionId, transitionPreviousBaselineId: null })
  const progress = await readProgress()
  await expect(restoreCandidate({ replace: true, ensureCurrent: () => {},
    expectedRevision: canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" }), recoveryId, personId }))
    .rejects.toThrow(/history.*transition|transition.*history/i)
  expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Original" })])
  expect(await readProgress()).toEqual(progress)
  expect(await readPendingWorkspaceRecoveryActivation(personId, workspaceId, recoveryId)).toBeUndefined()
})

it.each([
  { admittedChanges: 13 },
  { transitionId: "550e8400-e29b-41d4-a716-446655440000", transitionPreviousBaselineId: null },
])("Given unchanged workspace revision but concurrently changed history progress %j, when target activation runs, then reject its exact progress CAS before writes", async mutation => {
  await seedOriginal()
  await putProgress({})
  const original = BrowserMeshStore.prototype.updateRecords
  let changed = false
  const spy = vi.spyOn(BrowserMeshStore.prototype, "updateRecords").mockImplementation(async function (this: BrowserMeshStore, store, keys, change) {
    const result = await original.call(this, store, keys, change)
    if (!changed && keys.some(key => key.startsWith("workspace-recovery.v1.activation."))) {
      changed = true
      await putProgress(mutation)
    }
    return result
  })
  try {
    await expect(restoreCandidate({ replace: true, ensureCurrent: () => {},
      expectedRevision: canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" }), recoveryId, personId }))
      .rejects.toThrow(/history.*changed|history.*transition|progress.*changed/i)
    expect(changed).toBe(true)
    expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Original" })])
    expect(await getRows("changes")).toEqual([expect.objectContaining({ id: `${workspaceId}:change-old` })])
    expect(await readProgress()).toMatchObject(mutation)
    expect(await readPendingWorkspaceRecoveryActivation(personId, workspaceId, recoveryId)).toMatchObject({ status: "pending" })
  } finally { spy.mockRestore() }
})

it("Given an existing workspace journal, when restoring admitted recovery rows, then preserve every old row privately before atomically replacing only that workspace", async () => {
  await seedOriginal()
  const priorRevision = canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" })
  const guard = vi.fn()
  await restoreCandidate({ replace: true, ensureCurrent: guard,
    expectedRevision: priorRevision, recoveryId, personId })

  expect(guard).toHaveBeenCalled()
  expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Recovered" })])
  expect(await getRows("changes")).toEqual([expect.objectContaining({ id: `${workspaceId}:change-new` })])
  expect(await getRows("proofs")).toEqual([])
  const revisions = await getRows("revisions") as Array<{ recoveryId?: string; revision?: string }>
  expect(revisions).toHaveLength(1)
  expect(revisions[0]).toMatchObject({ recoveryId })
  expect(revisions[0]!.revision).not.toBe("before-recovery")

  const copy = await readStoredWorkspaceRecoveryCopy(personId, workspaceId, recoveryId)
  expect(copy?.journal.snapshots).toEqual([{ id: workspaceId, value: expect.objectContaining({ title: "Original" }) }])
  expect(copy?.journal.changes).toEqual([expect.objectContaining({ value: expect.objectContaining({ content: new Uint8Array([1, 2, 3]) }) })])
  expect(copy?.journal.proofs).toHaveLength(1)
  expect(copy?.journal.receipts).toHaveLength(1)
  expect(copy?.journal.receivedBaselines).toHaveLength(1)
  expect(copy?.journal.archivedChanges).toEqual([expect.objectContaining({ value: expect.objectContaining({ bytes: new Uint8Array([8, 9]) }) })])
  expect(copy?.journal.archivedAuthorizations).toHaveLength(1)
  expect(await readPendingWorkspaceRecoveryActivation(personId, workspaceId, recoveryId)).toBeUndefined()
})

it("Given an existing workspace snapshot, when replacement is not authorized, then leave target journal unchanged", async () => {
  await seedOriginal()
  await expect(restoreCandidate({ replace: false, ensureCurrent: () => {},
    expectedRevision: canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" }), recoveryId, personId }))
    .rejects.toThrow(/already exists|replace/i)
  expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Original" })])
  expect(await getRows("changes")).toHaveLength(1)
})

it("Given a changed revision row, when restoring recovery rows, then fail the CAS without changing target data", async () => {
  await seedOriginal()
  await expect(restoreCandidate({ replace: true, ensureCurrent: () => {},
    expectedRevision: canonicalizeJson({ id: workspaceId, workspaceId, revision: "stale" }), recoveryId, personId }))
    .rejects.toThrow(/changed|revision|concurrent/i)
  expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Original" })])
  expect(await getRows("changes")).toHaveLength(1)
})

it("Given an interrupted activation, when reading pending state, then expose safe recovery metadata and keep retryable activation", async () => {
  await seedOriginal()
  const priorRevision = canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" })
  let activationSaved = false
  const original = BrowserMeshStore.prototype.updateRecords
  const spy = vi.spyOn(BrowserMeshStore.prototype, "updateRecords").mockImplementation(async function (this: BrowserMeshStore, store, keys, change) {
    const result = await original.call(this, store, keys, change)
    if (keys.some(key => key.startsWith("workspace-recovery.v1.activation."))) activationSaved = true
    return result
  })
  try {
    await expect(restoreCandidate({ replace: true,
      ensureCurrent: () => { if (activationSaved) throw new Error("profile changed") }, expectedRevision: priorRevision, recoveryId, personId }))
      .rejects.toThrow(/profile changed/)
    const pending = await readPendingWorkspaceRecoveryActivation(personId, workspaceId, recoveryId)
    expect(pending).toMatchObject({ version: 1, workspaceId, recoveryId, status: "pending" })
    expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Original" })])
  } finally { spy.mockRestore() }
})

it("Given successful restoration followed by a new history transition, when retrying completed recovery, then verify candidate and retain the new transition", async () => {
  await seedOriginal()
  await putProgress({})
  const options = { replace: true, ensureCurrent: () => {},
    expectedRevision: canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" }), recoveryId, personId }
  await restoreCandidate(options)
  expect(await readProgress()).toBeUndefined()
  await putProgress({ transitionId: crypto.randomUUID(), transitionPreviousBaselineId: null })
  const progress = await readProgress()
  await restoreCandidate(options)
  expect(await readProgress()).toEqual(progress)
  expect(await getRows("snapshots")).toEqual([expect.objectContaining({ title: "Recovered" })])
})

it("Given a completed recovery marker, when the current candidate rows were changed afterward, then an idempotent retry rejects instead of trusting the recovery ID", async () => {
  await seedOriginal()
  const priorRevision = canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" })
  await restoreCandidate({ replace: true, ensureCurrent: () => {},
    expectedRevision: priorRevision, recoveryId, personId })
  const tx = database.transaction("snapshots", "readwrite")
  tx.objectStore("snapshots").put({ id: workspaceId, workspaceId, title: "Later edit" })
  await transactionDone(tx)
  await expect(restoreCandidate({ replace: true, ensureCurrent: () => {},
    expectedRevision: priorRevision, recoveryId, personId })).rejects.toThrow(/candidate|recovery|changed/i)
})

it("Given a sanitized active candidate and its full imported source journal, when restoring, then retain original deltas and frontiers in a separate immutable import copy", async () => {
  await seedOriginal()
  const priorRevision = canonicalizeJson({ id: workspaceId, workspaceId, revision: "before-recovery" })
  const source = candidate()
  source.deltas.push({ id: `${workspaceId}:source-delta`, value: { id: `${workspaceId}:source-delta`, workspaceId, raw: new Uint8Array([7, 8]) } })
  source.frontiers.push({ id: workspaceId, value: { id: workspaceId, workspaceId, generation: "source-generation" } })
  await restoreCandidate({ replace: true, ensureCurrent: () => {},
    expectedRevision: priorRevision, recoveryId, personId, sourceJournal: source })
  expect(await getRows("deltas")).toEqual([])
  const imported = await readStoredWorkspaceRecoveryImport(personId, workspaceId, recoveryId)
  expect(imported?.journal.deltas).toEqual(source.deltas)
  expect(imported?.journal.frontiers).toEqual(source.frontiers)
})
