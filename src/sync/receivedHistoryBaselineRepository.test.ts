import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { StoredWorkspaceSnapshot } from "../storageJournal"
import { defaultStorage } from "../storage"

beforeAll(async () => {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? options as () => Promise<unknown>)() } })
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

function opaqueCandidate(document: Uint8Array, signedJson: Uint8Array, baselineId = "baseline-1", previousBaselineId?: string): WasmVerifiedReceivedHistoryBaseline {
  const candidate = Object.create(WasmVerifiedReceivedHistoryBaseline.prototype) as WasmVerifiedReceivedHistoryBaseline
  Object.defineProperties(candidate, {
    document: { value: () => document.slice() },
    originalJson: { value: () => signedJson.slice() },
    controlJson: { value: () => new TextEncoder().encode("{}") },
    encryptedObjects: { value: () => new Map([["ciphertext-1", { version: 1, nonce: "AA", ciphertext: "AA" }]]) },
    plaintextObjects: { value: () => new Map() },
    storageVerification: { value: () => "encrypted-correspondence" },
    free: { value: () => {} },
    verifyPreviousBaseline: { value: (parent: WasmVerifiedReceivedHistoryBaseline) => {
      if ((parent.envelope() as { payload: { baselineId: string } }).payload.baselineId !== previousBaselineId) throw new Error("Wrong signed parent")
    } },
    envelope: { value: () => ({ payload: { workspaceId: "history-workspace", baselineId, previousBaselineId,
      storage: { keyEpoch: 1, authority: { scopeId: "scope-1", servicePublicKey: "service-key", policyRevision: 1 } } } }) },
  })
  return candidate
}

async function setup() {
  const { openWorkspaceJournal, requestResult, transactionDone } = await import("../storageJournal")
  const database = await openWorkspaceJournal()
  const stores = Array.from(database.objectStoreNames)
  const cleanup = database.transaction(stores, "readwrite")
  for (const store of stores) cleanup.objectStore(store).clear()
  await new Promise<void>((resolve, reject) => {
    cleanup.oncomplete = () => resolve()
    cleanup.onerror = () => reject(cleanup.error)
    cleanup.onabort = () => reject(cleanup.error ?? new Error("Could not reset received history test database"))
  })
  const { createReceivedHistoryBaselineRepository } = await import("./receivedHistoryBaselineRepository")
  const profile = Automerge.from<WorkspaceDocumentV2>({ id: "history-workspace", title: "Incoming basis", version: 2 } as unknown as WorkspaceDocumentV2)
  const document = Automerge.save(profile)
  const prior = Automerge.from<WorkspaceDocumentV2>({ id: "history-workspace", title: "Local before receive", version: 2 } as unknown as WorkspaceDocumentV2)
  const priorSnapshot: StoredWorkspaceSnapshot = { id: "history-workspace", workspaceId: "history-workspace", title: prior.title,
    archivedAt: null, heads: Automerge.getHeads(prior).sort(), bytes: Automerge.save(prior), savedAt: "2026-10-15T10:00:00.000Z" }
  const priorFrontier = { id: "history-workspace", workspaceId: "history-workspace", generation: "generation-1", revision: 1,
    basisHash: "basis", basisHeads: priorSnapshot.heads, basisSavedAt: priorSnapshot.savedAt, authorityFingerprint: "authority",
    policy: "mesh-causal-admission@3", heads: priorSnapshot.heads, chainHash: "chain", title: priorSnapshot.title,
    archivedAt: null, savedAt: priorSnapshot.savedAt }
  const priorDelta = { id: "history-workspace:generation-1:1", workspaceId: "history-workspace", generation: "generation-1",
    sequence: 1, command: { receipt: { changeHash: "delta-change" } } }
  const seed = database.transaction(["snapshots", "changes", "authorizations", "proofs", "receipts", "frontiers", "deltas"], "readwrite")
  seed.objectStore("snapshots").put(priorSnapshot)
  seed.objectStore("authorizations").put({ id: "history-workspace", workspaceId: "history-workspace", records: [{ exactOriginal: "signed-proof" }] })
  seed.objectStore("changes").put({ id: "history-workspace:old-change", workspaceId: "history-workspace", changeHash: "old-change", bytes: new Uint8Array([1]), addedAt: priorSnapshot.savedAt })
  seed.objectStore("proofs").put({ id: "history-workspace:old-change", workspaceId: "history-workspace", changeHash: "old-change", proof: { preserved: true } })
  seed.objectStore("receipts").put({ id: "history-workspace:old-receipt", workspaceId: "history-workspace", transactionId: "old-receipt", receipt: { preserved: true } })
  seed.objectStore("frontiers").put(priorFrontier)
  seed.objectStore("deltas").put(priorDelta)
  await transactionDone(seed)
  const ensureCurrent = vi.fn()
  const repository = createReceivedHistoryBaselineRepository("history-workspace", ensureCurrent)
  return { repository, ensureCurrent, candidate: opaqueCandidate(document, new TextEncoder().encode('{"signed":true}')), priorSnapshot,
    priorFrontier, priorDelta, openWorkspaceJournal, requestResult, transactionDone }
}

async function activate(f: Awaited<ReturnType<typeof setup>>, stageId: string, candidate: WasmVerifiedReceivedHistoryBaseline) {
  return defaultStorage.withWorkspaceTransaction("history-workspace", transaction => f.repository.activate(stageId, candidate, transaction))
}

describe("received history baseline activation", () => {
  it("Given a recovered workspace, when a verified compact basis activates, then retain its recovery identity for pending secondary state", async () => {
    const f = await setup(), recoveryId = crypto.randomUUID(), database = await f.openWorkspaceJournal()
    const seed = database.transaction("revisions", "readwrite"), seeded = f.transactionDone(seed)
    seed.objectStore("revisions").put({ id: "history-workspace", workspaceId: "history-workspace", revision: "recovered-revision", recoveryId })
    await seeded
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    await activate(f, stageId, f.candidate)
    const read = database.transaction("revisions", "readonly"), done = f.transactionDone(read)
    expect(await f.requestResult(read.objectStore("revisions").get("history-workspace"))).toMatchObject({ recoveryId })
    await done
  })

  it("stages verified source durably against exact prior snapshot and rejects a stale parent", async () => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    const reopened = f.repository
    await expect(reopened.readStaged()).resolves.toMatchObject({ stageId, state: "staged",
      signedJson: new TextEncoder().encode('{"signed":true}') })
    await expect(f.repository.stage(f.candidate, { ...f.priorSnapshot, savedAt: "stale" })).rejects.toThrow(/changed/i)
  })

  it("atomically installs the verified basis while retaining preactivation snapshot and raw evidence", async () => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    await activate(f, stageId, f.candidate)
    const database = await f.openWorkspaceJournal()
    const transaction = database.transaction(["snapshots", "receivedBaselines", "changes", "archivedChanges", "authorizations", "archivedAuthorizations", "proofs", "receipts", "frontiers", "deltas"], "readonly")
    const [snapshot, baseline, changes, proofs, receipts, frontier, delta, archivedChanges, activeAuthorizations, archivedAuthorizations] = await Promise.all([
      f.requestResult(transaction.objectStore("snapshots").get("history-workspace")),
      f.requestResult(transaction.objectStore("receivedBaselines").get("history-workspace:baseline:baseline-1")),
      f.requestResult(transaction.objectStore("changes").get("history-workspace:old-change")),
      f.requestResult(transaction.objectStore("proofs").get("history-workspace:old-change")),
      f.requestResult(transaction.objectStore("receipts").get("history-workspace:old-receipt")),
      f.requestResult(transaction.objectStore("frontiers").get("history-workspace")),
      f.requestResult(transaction.objectStore("deltas").get(f.priorDelta.id)),
      f.requestResult(transaction.objectStore("archivedChanges").get("history-workspace:old-change")),
      f.requestResult(transaction.objectStore("authorizations").get("history-workspace")),
      f.requestResult(transaction.objectStore("archivedAuthorizations").get("history-workspace:baseline:baseline-1")),
    ])
    await f.transactionDone(transaction)
    expect(snapshot).toMatchObject({ title: "Incoming basis", receivedHistory: { baselineId: "baseline-1", excludedLocalChangeHashes: [] } })
    expect((snapshot as StoredWorkspaceSnapshot).bytes).toEqual(f.candidate.document())
    expect(baseline).toMatchObject({ state: "active", priorSnapshot: f.priorSnapshot, signedJson: new TextEncoder().encode('{"signed":true}') })
    expect(changes).toBeUndefined()
    expect(archivedChanges).toMatchObject({ bytes: new Uint8Array([1]), changeHash: "old-change", archivedUnderBaselineId: "baseline-1" })
    expect(activeAuthorizations).toMatchObject({ records: [] })
    expect(archivedAuthorizations).toMatchObject({ baselineId: "baseline-1", records: [{ exactOriginal: "signed-proof" }] })
    expect(proofs).toBeDefined()
    expect(receipts).toBeDefined()
    expect(frontier).toBeUndefined()
    expect(delta).toEqual(f.priorDelta)
    const { WorkspaceStorage } = await import("../storage")
    const storage = new WorkspaceStorage()
    await expect(storage.loadWorkspaceDoc("history-workspace")).rejects.toThrow(/received workspace history/i)
    await storage.acceptVerifiedReceivedHistoryBaseline(f.candidate, () => undefined)
    await expect(storage.loadWorkspaceDoc("history-workspace")).resolves.toMatchObject({ doc: { title: "Incoming basis" } })
  })

  it("Given a borrowed Native basis, when its cache entry is replaced, evicted or identity-invalidated, then keep the outstanding borrow alive without exposing stale authority", async () => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    await activate(f, stageId, f.candidate)
    const { WorkspaceStorage } = await import("../storage")
    const { stateRuntime } = await import("../stateContext")
    const previousProfile = stateRuntime.currentProfile
    stateRuntime.currentProfile = { identity: { personId: "owner" }, device: { deviceId: "device" } } as never
    const storage = new class extends WorkspaceStorage { evict() { this.forgetReceivedHistory("history-workspace") } }()
    const tracked = () => {
      let alive = true
      const candidate = Object.create(WasmVerifiedReceivedHistoryBaseline.prototype) as WasmVerifiedReceivedHistoryBaseline
      for (const method of ["originalJson", "document", "envelope"] as const) Object.defineProperty(candidate, method, {
        value: () => { if (!alive) throw new Error("null pointer passed to rust"); return f.candidate[method]() },
      })
      const free = vi.fn(() => { alive = false })
      Object.defineProperty(candidate, "free", { value: free })
      return { candidate, free }
    }
    try {
      const first = tracked(), replacement = tracked()
      await storage.acceptVerifiedReceivedHistoryBaseline(first.candidate, () => {})
      const borrowed = await storage.getVerifiedReceivedHistoryBaseline("history-workspace")
      await storage.acceptVerifiedReceivedHistoryBaseline(replacement.candidate, () => {})
      expect(() => borrowed!.envelope()).not.toThrow()
      expect(first.free).not.toHaveBeenCalled()
      const nextBorrowed = await storage.getVerifiedReceivedHistoryBaseline("history-workspace")
      expect(nextBorrowed).toBe(replacement.candidate)
      storage.evict()
      await expect(storage.getVerifiedReceivedHistoryBaseline("history-workspace")).resolves.toBeUndefined()
      expect(() => nextBorrowed!.envelope()).not.toThrow()
      expect(replacement.free).not.toHaveBeenCalled()
      await storage.acceptVerifiedReceivedHistoryBaseline(replacement.candidate, () => {})
      stateRuntime.currentProfile = { identity: { personId: "other" }, device: { deviceId: "other-device" } } as never
      await expect(storage.getVerifiedReceivedHistoryBaseline("history-workspace")).resolves.toBeUndefined()
      expect(() => nextBorrowed!.envelope()).not.toThrow()
      expect(replacement.free).not.toHaveBeenCalled()
    } finally { stateRuntime.currentProfile = previousProfile }
  })

  it("Given a peer-admitted active basis, when Rusty repeats its exact signed baseline, then retain only the matching Rusty read route", async () => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    await activate(f, stageId, f.candidate)
    const signedJson = f.candidate.originalJson()
    const wire = { version: 1 as const, signedJson: (await import("@meta-uber/mesh-replication/rusty-replica")).encodeBlindBytes(signedJson),
      basis: { context: {}, reference: {}, locatorRoot: {}, coverage: {} } } as never
    await f.repository.recordActiveWireRoute("baseline-1", signedJson, wire)
    const row = (await f.repository.readActive())!
    expect(row.wire).toBeDefined()
    expect(row.peerProofs).toBeUndefined()
    expect(row.signedJson).toEqual(signedJson)
    await expect(f.repository.recordActiveWireRoute("baseline-1", new Uint8Array([9]), wire)).rejects.toThrow(/signature|active baseline/i)
    await expect(f.repository.readActive()).resolves.toMatchObject({ wire })
  })

  it("does not activate a different candidate than the one durably staged", async () => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    const other = Automerge.from<WorkspaceDocumentV2>({ id: "history-workspace", title: "Substituted basis", version: 2 } as unknown as WorkspaceDocumentV2)
    const substitutedBytes = Automerge.save(other)
    Automerge.free(other)
    const substituted = opaqueCandidate(substitutedBytes, new TextEncoder().encode('{"signed":false}'))
    await expect(activate(f, stageId, substituted)).rejects.toThrow(/staged candidate/i)
    await expect(f.repository.readStaged()).resolves.toMatchObject({ stageId, state: "staged" })
  })

  it("restores the exact local snapshot and delta frontier while retaining the received source record", async () => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    await activate(f, stageId, f.candidate)
    await f.repository.restorePriorLocalHistory()
    const database = await f.openWorkspaceJournal()
    const transaction = database.transaction(["snapshots", "receivedBaselines", "changes", "proofs", "receipts"], "readonly")
    const [snapshot, archive, change, proof, receipt] = await Promise.all([
      f.requestResult(transaction.objectStore("snapshots").get("history-workspace")),
      f.requestResult(transaction.objectStore("receivedBaselines").get("history-workspace:baseline:baseline-1")),
      f.requestResult(transaction.objectStore("changes").get("history-workspace:old-change")),
      f.requestResult(transaction.objectStore("proofs").get("history-workspace:old-change")),
      f.requestResult(transaction.objectStore("receipts").get("history-workspace:old-receipt")),
    ])
    await f.transactionDone(transaction)
    expect(snapshot).toEqual(f.priorSnapshot)
    expect(archive).toMatchObject({ state: "restored", signedJson: new TextEncoder().encode('{"signed":true}') })
    expect(change).toBeDefined()
    expect(proof).toBeDefined()
    expect(receipt).toBeDefined()
    const restoredHistory = await f.openWorkspaceJournal()
    const restoredTransaction = restoredHistory.transaction(["frontiers", "deltas"], "readonly")
    const [frontier, delta] = await Promise.all([
      f.requestResult(restoredTransaction.objectStore("frontiers").get("history-workspace")),
      f.requestResult(restoredTransaction.objectStore("deltas").get(f.priorDelta.id)),
    ])
    await f.transactionDone(restoredTransaction)
    expect(frontier).toEqual(f.priorFrontier)
    expect(delta).toEqual(f.priorDelta)
  })

  it.each(["snapshot", "revision", "frontier", "authorization", "history-transition"] as const)("refuses parent rollback after a post-activation %s mutation without losing the new source", async mutation => {
    const f = await setup()
    const stageId = await f.repository.stage(f.candidate, f.priorSnapshot)
    await activate(f, stageId, f.candidate)
    const database = await f.openWorkspaceJournal()
    const tx = database.transaction(["snapshots", "revisions", "frontiers", "authorizations", "historyProgress"], "readwrite")
    const saved = await f.requestResult(tx.objectStore("snapshots").get("history-workspace")) as StoredWorkspaceSnapshot
    if (mutation === "snapshot") tx.objectStore("snapshots").put({ ...saved, savedAt: "2026-10-15T19:00:00.000Z", title: "Later write" })
    if (mutation === "revision") tx.objectStore("revisions").put({ id: "history-workspace", workspaceId: "history-workspace", revision: "later" })
    if (mutation === "frontier") tx.objectStore("frontiers").put({ ...f.priorFrontier, generation: "new-active-tail" })
    if (mutation === "authorization") tx.objectStore("authorizations").put({ id: "history-workspace", workspaceId: "history-workspace", records: [{ later: "signed-tail" }] })
    if (mutation === "history-transition") tx.objectStore("historyProgress").put({ id: "history-workspace", workspaceId: "history-workspace",
      baselineId: "baseline-1", admittedChanges: 0, encodedBytes: 0, transitionId: crypto.randomUUID(), transitionPreviousBaselineId: "baseline-1" })
    await f.transactionDone(tx)
    await expect(f.repository.restorePriorLocalHistory()).rejects.toThrow(/changed|unsafe|transition|tail/i)
    const verify = database.transaction(["snapshots", "receivedBaselines"], "readonly")
    const snapshot = await f.requestResult(verify.objectStore("snapshots").get("history-workspace")) as StoredWorkspaceSnapshot
    const archive = await f.requestResult(verify.objectStore("receivedBaselines").get("history-workspace:baseline:baseline-1"))
    await f.transactionDone(verify)
    expect(snapshot.receivedHistory?.baselineId).toBe("baseline-1")
    expect(snapshot.title).toBe(mutation === "snapshot" ? "Later write" : "Incoming basis")
    expect(archive).toMatchObject({ state: "active" })
  })
})

it("Given storage CAS refused a staged candidate, when restarting capture, then retain candidate evidence and original active bytes while permitting a new stage", async () => {
  const f = await setup()
  const first = await f.repository.stage(f.candidate, f.priorSnapshot)
  await f.repository.retainCheckpointConflictCandidate("baseline-1")
  expect(await f.repository.readStaged()).toBeUndefined()
  const retained = await f.repository.readArchiveRecords()
  expect(retained).toContainEqual(expect.objectContaining({ stageId: first, state: "restored", baselineId: "baseline-1",
    document: f.candidate.document(), signedJson: f.candidate.originalJson() }))
  const database = await f.openWorkspaceJournal(), transaction = database.transaction("snapshots", "readonly")
  expect(await f.requestResult(transaction.objectStore("snapshots").get("history-workspace"))).toEqual(f.priorSnapshot)
  await f.transactionDone(transaction)
  expect(await f.repository.stage(f.candidate, f.priorSnapshot)).not.toBe(first)
})

it("Given a fully verified enrollment ancestor chain, when staging its current basis, then retain parents inactive atomically without changing the workspace", async () => {
  const f = await setup()
  const parent = opaqueCandidate(f.candidate.document(), new Uint8Array([1]), "parent")
  const current = opaqueCandidate(f.candidate.document(), new Uint8Array([2]), "current", "parent")
  const { captureVerifiedHistoryAncestors } = await import("./verifiedHistoryAncestors")
  const evidence = captureVerifiedHistoryAncestors(current, [parent])
  await expect(f.repository.stage(current, { ...f.priorSnapshot, savedAt: "stale" }, undefined, evidence)).rejects.toThrow(/changed/i)
  expect(await f.repository.readArchiveRecords()).toEqual([])
  await f.repository.stage(current, f.priorSnapshot, undefined, evidence)
  expect(await f.repository.readArchiveRecords()).toEqual(expect.arrayContaining([
    expect.objectContaining({ baselineId: "parent", state: "restored", signedJson: new Uint8Array([1]), document: parent.document() }),
    expect.objectContaining({ baselineId: "current", state: "staged" }),
  ]))
  expect(await f.repository.readActive()).toBeUndefined()
})

it("Given an already-active enrolled basis, when adding its verified ancestors, then preserve the exact current snapshot and reject another head", async () => {
  const f = await setup()
  const parent = opaqueCandidate(f.candidate.document(), new Uint8Array([1]), "parent")
  const current = opaqueCandidate(f.candidate.document(), new Uint8Array([2]), "current", "parent")
  const { captureVerifiedHistoryAncestors } = await import("./verifiedHistoryAncestors")
  const evidence = captureVerifiedHistoryAncestors(current, [parent])
  const stageId = await f.repository.stage(current, f.priorSnapshot)
  await activate(f, stageId, current)
  const before = await f.repository.readActive()
  await f.repository.retainVerifiedAncestors(current, evidence)
  expect(await f.repository.readActive()).toEqual(before)
  expect((await f.repository.readArchiveRecords()).find(row => row.baselineId === "parent")?.state).toBe("restored")
  await expect(f.repository.retainVerifiedAncestors(f.candidate, evidence)).rejects.toThrow(/head/i)
})
