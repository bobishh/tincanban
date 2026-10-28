import { readFile } from "node:fs/promises"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity } from "./domain/identity"
import { createWorkspaceDoc } from "./test/boardFixture"
import { executeCommand } from "./domain/commands"
import type { ChangeProof, TransactionReceipt } from "./domain/model"
import { createAdmissionCheckpoint } from "./sync/workspaceAdmissionCheckpoint"
import { prepareLocalChangeAuthorizations, recordGenesisAuthority } from "./sync/changeAuthorization"
import { requestResult, transactionDone, type StoredWorkspaceSnapshot } from "./storageJournal"
import { createDeltaBasis, prepareWorkspaceDelta, WorkspaceDeltaJournal } from "./workspaceDeltaJournal"
import { StorageDeltaRepository } from "./storageDeltaRepository"
import { WorkspaceStorage } from "./storage"
import * as storageJournal from "./storageJournal"

beforeAll(async () => {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? options as () => Promise<unknown>)() } })
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

async function fixture() {
  const profile = await bootstrapIdentity("Delta owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Delta board", profile.identity.personId, "blank"))
  await recordGenesisAuthority(doc, profile)
  const heads = Automerge.getHeads(doc).sort()
  const snapshot: StoredWorkspaceSnapshot = { id: doc.id, workspaceId: doc.id, title: doc.title,
    archivedAt: null, heads, bytes: Automerge.save(doc), savedAt: new Date().toISOString(),
    causalEvidence: { bytes: Automerge.save(doc), decisions: [],
      admissionCheckpoint: await createAdmissionCheckpoint("verified-basis", heads, []) } }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = new IDBFactory().open("delta-fixture", 1)
    request.onupgradeneeded = () => {
      for (const name of ["snapshots", "authorizations", "frontiers", "deltas", "changes", "proofs", "receipts", "revisions", "historyProgress"]) {
        const store = request.result.createObjectStore(name, { keyPath: "id" })
        store.createIndex("workspaceId", "workspaceId")
        if (name === "deltas") store.createIndex("sequence", ["workspaceId", "generation", "sequence"], { unique: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const frontier = await createDeltaBasis(snapshot, "verified-current-rights")
  const journal = new WorkspaceDeltaJournal(database)
  const install = database.transaction(["snapshots", "frontiers"], "readwrite")
  const installed = transactionDone(install)
  install.objectStore("snapshots").put(snapshot)
  install.objectStore("frontiers").put(frontier)
  await installed
  const created = await executeCommand(doc, { kind: "renameWorkspace", title: "Changed title" }, profile)
  if (!created.ok) throw new Error(created.error.message)
  const authorizations = await prepareLocalChangeAuthorizations(created.value.newDoc, profile, [created.value.receipt.changeHash])
  const delta = await prepareWorkspaceDelta(frontier, {
    changeBytes: Automerge.getLastLocalChange(created.value.newDoc)!, receipt: created.value.receipt,
    proof: created.value.proof, authorizations, role: "owner", title: created.value.newDoc.title, archivedAt: null,
  })
  return { journal, database, frontier, delta, snapshot, doc, profile, created: created.value.newDoc }
}

it("Given an admitted basis, When one local command commits, Then only the delta is written and a fresh reader sees its exact history, proof and receipt", async () => {
  const f = await fixture()
  const next = await appendDelta(f, f.frontier, f.delta)
  expect(next.revision).toBe(1)
  expect(next.heads).toEqual(Automerge.getHeads(f.created).sort())
  const cold = await new WorkspaceDeltaJournal(f.database).read(f.doc.id)
  expect(cold!.basis.bytes).toEqual(f.snapshot.bytes)
  expect(cold!.deltas).toHaveLength(1)
  expect(cold!.deltas[0]!.command.receipt).toEqual(f.delta.command.receipt)
  const [restored] = Automerge.applyChanges(Automerge.load(f.snapshot.bytes), cold!.deltas.map(delta => delta.command.changeBytes))
  expect(restored).toEqual(f.created)
  const read = f.database.transaction(["receipts", "proofs", "changes"], "readonly")
  const done = transactionDone(read)
  expect(await requestResult(read.objectStore("receipts").get(`${f.doc.id}:${f.delta.command.receipt.transactionId}`))).toMatchObject({ receipt: f.delta.command.receipt })
  expect(await requestResult(read.objectStore("proofs").get(`${f.doc.id}:${f.delta.command.receipt.changeHash}`))).toMatchObject({ proof: f.delta.command.proof })
  expect(await requestResult(read.objectStore("changes").get(`${f.doc.id}:${f.delta.command.receipt.changeHash}`))).toMatchObject({ bytes: f.delta.command.changeBytes })
  await done
  f.database.close()
})

it.each(["basis install", "tail append"] as const)("Given a recovered workspace with pending secondary state, when %s advances its local revision, then retain the recovery identity and current history", async stage => {
  const f = await fixture(), recoveryId = crypto.randomUUID()
  const seed = f.database.transaction(["frontiers", "revisions"], "readwrite"), seeded = transactionDone(seed)
  if (stage === "basis install") seed.objectStore("frontiers").delete(f.doc.id)
  seed.objectStore("revisions").put({ id: f.doc.id, workspaceId: f.doc.id, revision: "recovered-revision", recoveryId })
  await seeded
  try {
    if (stage === "basis install") expect(await f.journal.install(f.snapshot, f.frontier, [], "recovered-revision", () => {}, "basis-installed")).toBe(true)
    else await appendDelta(f, f.frontier, f.delta)
    const read = f.database.transaction("revisions", "readonly"), done = transactionDone(read)
    expect(await requestResult(read.objectStore("revisions").get(f.doc.id))).toMatchObject({ recoveryId })
    await done
    expect((await f.journal.read(f.doc.id))!.frontier.heads).toEqual(stage === "basis install" ? f.snapshot.heads : Automerge.getHeads(f.created).sort())
  } finally { f.database.close() }
})

it("Given a compact history basis, When a new admitted delta commits, Then threshold counters advance by that exact change only", async () => {
  const f = await fixture()
  const prepare = f.database.transaction(["snapshots", "historyProgress"], "readwrite")
  const prepareDone = transactionDone(prepare)
  prepare.objectStore("snapshots").put({ ...f.snapshot, receivedHistory: { baselineId: "B".repeat(43), excludedLocalChangeHashes: [] } })
  prepare.objectStore("historyProgress").put({ id: f.doc.id, workspaceId: f.doc.id, baselineId: "B".repeat(43),
    admittedChanges: 7, encodedBytes: 1234 })
  await prepareDone

  await appendDelta(f, f.frontier, f.delta)
  const transaction = f.database.transaction("historyProgress", "readonly")
  const done = transactionDone(transaction)
  const progress = await requestResult(transaction.objectStore("historyProgress").get(f.doc.id)) as {
    admittedChanges: number; encodedBytes: number
  }
  await done
  expect(progress.admittedChanges).toBe(8)
  expect(progress.encodedBytes).toBe(1234 + f.delta.command.changeBytes.byteLength)
})

async function appendRename(f: Awaited<ReturnType<typeof fixture>>, title: string) {
  const frontier = (await f.journal.readFrontier(f.doc.id))!
  const result = await executeCommand(f.created, { kind: "renameWorkspace", title }, f.profile)
  if (!result.ok) throw new Error(result.error.message)
  const delta = await prepareWorkspaceDelta(frontier, { ...f.delta.command, title,
    receipt: result.value.receipt, proof: result.value.proof,
    changeBytes: Automerge.getLastLocalChange(result.value.newDoc)!,
    authorizations: await prepareLocalChangeAuthorizations(result.value.newDoc, f.profile, [result.value.receipt.changeHash]),
  })
  await appendDelta(f, frontier, delta)
  f.created = result.value.newDoc
  return delta
}

async function readRevision(f: Awaited<ReturnType<typeof fixture>>) {
  const transaction = f.database.transaction("revisions", "readonly")
  const done = transactionDone(transaction)
  const row = await requestResult(transaction.objectStore("revisions").get(f.doc.id)) as { revision?: string } | undefined
  await done
  return row?.revision ?? null
}

async function readWorkspaceRows(f: Awaited<ReturnType<typeof fixture>>) {
  const names = ["snapshots", "authorizations", "frontiers", "deltas", "changes", "proofs", "receipts", "revisions", "historyProgress"] as const
  const transaction = f.database.transaction([...names], "readonly")
  const done = transactionDone(transaction)
  const rows = Object.fromEntries(await Promise.all(names.map(async name => [name,
    await requestResult(transaction.objectStore(name).index("workspaceId").getAll(f.doc.id))] as const)))
  await done
  return rows
}

async function appendDelta(f: Awaited<ReturnType<typeof fixture>>, frontier: typeof f.frontier,
  delta: typeof f.delta, journal = f.journal, expectedRevision?: string | null) {
  return journal.append(frontier, delta, expectedRevision === undefined ? await readRevision(f) : expectedRevision, () => {})
}

async function commitLegacyCommand(storage: WorkspaceStorage, workspaceId: string,
  command: { receipt: TransactionReceipt; changeBytes: Uint8Array; proof: ChangeProof }) {
  await storage.withWorkspaceTransaction(workspaceId, async transaction => {
    const current = await transaction.loadWorkspaceDoc()
    if (!current) throw new Error("Workspace disappeared before legacy command commit")
    const [doc] = Automerge.applyChanges(current.doc, [command.changeBytes])
    await transaction.commitWorkspace(doc, Automerge.save(doc), [], command)
  })
}

it("Given a stale snapshot basis after a delta commit, When snapshot CAS is attempted, Then every durable source row and the unseen delta remain unchanged", async () => {
  const f = await fixture()
  const capturedRevision = await readRevision(f)
  await appendDelta(f, f.frontier, f.delta, f.journal, capturedRevision)
  const before = await readWorkspaceRows(f)

  const installed = await f.journal.install(f.snapshot, f.frontier, [], capturedRevision, () => {}, "stale-snapshot-candidate")

  expect(installed).toBe(false)
  expect(await readWorkspaceRows(f)).toEqual(before)
  const checked = await f.journal.read(f.doc.id)
  expect(checked?.deltas).toHaveLength(1)
  expect(checked?.deltas[0]?.command.receipt).toEqual(f.delta.command.receipt)
  expect((await f.journal.readFrontier(f.doc.id))?.heads).toEqual(Automerge.getHeads(f.created).sort())
  f.database.close()
})

it("Given a checked IndexedDB frontier, When a legacy transaction writes new evidence, Then revision changes and the old frontier is retired atomically while retries remain idle", async () => {
  const f = await fixture()
  await appendDelta(f, f.frontier, f.delta)
  const next = await executeCommand(f.created, { kind: "renameWorkspace", title: "Legacy writer" }, f.profile)
  if (!next.ok) throw new Error(next.error.message)
  const previousIndexedDB = globalThis.indexedDB
  vi.stubGlobal("indexedDB", new IDBFactory())
  f.database.close()
  f.database = await storageJournal.openWorkspaceJournal()
  f.journal = new WorkspaceDeltaJournal(f.database)
  const seed = f.database.transaction("snapshots", "readwrite")
  const seeded = transactionDone(seed)
  seed.objectStore("snapshots").put(f.snapshot)
  await seeded
  expect(await f.journal.install(f.snapshot, f.frontier, [], null, () => {}, crypto.randomUUID())).toBe(true)
  await appendDelta(f, f.frontier, f.delta)
  const storage = new WorkspaceStorage()
  try {
    const before = await storage.readWorkspaceRevision(f.doc.id)
    const { receipt, proof, newDoc } = next.value
    const bytes = Automerge.getLastLocalChange(newDoc)!
    await commitLegacyCommand(storage, f.doc.id, { receipt, changeBytes: bytes, proof })
    const after = await storage.readWorkspaceRevision(f.doc.id)
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    const read = f.database.transaction("frontiers", "readonly")
    const done = transactionDone(read)
    expect(await requestResult(read.objectStore("frontiers").get(f.doc.id))).toBeUndefined()
    await done
    expect((await storage.loadWorkspaceDoc(f.doc.id))?.doc.title).toBe("Legacy writer")
    await commitLegacyCommand(storage, f.doc.id, { receipt, changeBytes: bytes, proof })
    expect(await storage.readWorkspaceRevision(f.doc.id)).toBe(after)
  } finally { vi.stubGlobal("indexedDB", previousIndexedDB) }
})

it("Given an IndexedDB legacy change reclassified as quarantined, When a later legacy command arrives and storage reopens, Then the admitted view excludes quarantine while raw recovery retains both changes", async () => {
  const f = await fixture()
  f.database.close()
  const previousIndexedDB = globalThis.indexedDB
  vi.stubGlobal("indexedDB", new IDBFactory())
  const storage = new WorkspaceStorage()
  try {
    await storage.withWorkspaceTransaction(f.doc.id, transaction => transaction.commitWorkspace(
      f.doc, f.snapshot.bytes, f.delta.command.authorizations))
    await commitLegacyCommand(storage, f.doc.id, f.delta.command)
    await storage.withWorkspaceTransaction(f.doc.id, transaction => transaction.commitWorkspace(
      f.doc, f.snapshot.bytes, f.delta.command.authorizations, undefined, {
        bytes: Automerge.save(f.created), decisions: [{ hash: f.delta.command.receipt.changeHash,
          status: { type: "quarantined", reason: "rights changed" } }],
      }))
    expect((await storage.loadWorkspaceDoc(f.doc.id))!.doc.title).toBe("Delta board")
    const next = await executeCommand(Automerge.clone(f.doc), { kind: "renameWorkspace", title: "Admitted legacy tail" }, f.profile)
    if (!next.ok) throw new Error(next.error.message)
    await commitLegacyCommand(storage, f.doc.id, { receipt: next.value.receipt,
      changeBytes: Automerge.getLastLocalChange(next.value.newDoc)!, proof: next.value.proof })
    const reopened = new WorkspaceStorage()
    expect((await reopened.loadWorkspaceDoc(f.doc.id))!.doc.title).toBe("Admitted legacy tail")
    const evidence = (await reopened.loadCausalEvidence(f.doc.id))!
    const raw = Automerge.load(evidence.bytes)
    expect(Automerge.hasHeads(raw, [f.delta.command.receipt.changeHash, next.value.receipt.changeHash])).toBe(true)
    expect(evidence.decisions).toEqual([{ hash: f.delta.command.receipt.changeHash, status: { type: "quarantined", reason: "rights changed" } }])
    expect(evidence.admissionCheckpoint).toBeUndefined()
    Automerge.free(raw)
  } finally { vi.stubGlobal("indexedDB", previousIndexedDB) }
})

it("Given a warm tab with a checked prefix, When another tab appends a command, Then catch-up reads no snapshot or old deltas and applies only the new tail", async () => {
  const f = await fixture()
  await appendDelta(f, f.frontier, f.delta)
  const reader = new StorageDeltaRepository()
  vi.spyOn(reader, "journal").mockResolvedValue(f.journal)
  await reader.read(f.doc.id)
  await appendRename(f, "Other tab edit")
  const cold = vi.spyOn(f.journal, "read")
  const transactions = vi.spyOn(f.database, "transaction")
  const digest = vi.spyOn(crypto.subtle, "digest")
  try {
    const loaded = await reader.loadDocument(f.doc.id)
    expect(loaded!.doc.title).toBe("Other tab edit")
    expect((await reader.read(f.doc.id))!.deltas).toHaveLength(2)
    expect(cold).not.toHaveBeenCalled()
    expect(transactions.mock.calls.some(([stores]) => Array.from(typeof stores === "string" ? [stores] : stores).includes("snapshots"))).toBe(false)
    expect(digest.mock.calls.some(([, bytes]) => bytes.byteLength === f.snapshot.bytes.byteLength)).toBe(false)
    Automerge.free(loaded!.doc)
  } finally { cold.mockRestore(); transactions.mockRestore(); digest.mockRestore(); reader.forget(f.doc.id); f.database.close() }
})

it("Given a warm stored prefix and a reusable document already at newer heads, When loading, Then storage still verifies the new tail before reusing admission and access", async () => {
  const f = await fixture()
  const reader = new StorageDeltaRepository()
  vi.spyOn(reader, "journal").mockResolvedValue(f.journal)
  await reader.read(f.doc.id)
  await appendDelta(f, f.frontier, f.delta)
  const tail = vi.spyOn(f.journal, "readAfter")
  const loaded = await reader.loadDocument(f.doc.id, f.created)
  expect(loaded!.doc.title).toBe(f.created.title)
  expect(tail).toHaveBeenCalledOnce()
  tail.mockRestore()
  reader.forget(f.doc.id)
  Automerge.free(loaded!.doc)
  f.database.close()
})

it.each(["evicted", "replaced"] as const)("Given a load suspended after verification, When its cache is %s, Then it returns an owned document at the verified heads", async cacheAction => {
  const f = await fixture()
  await appendDelta(f, f.frontier, f.delta)
  const reader = new StorageDeltaRepository()
  vi.spyOn(reader, "journal").mockResolvedValue(f.journal)
  const prefix = (await reader.read(f.doc.id))!
  const prefixLease = (await reader.loadDocument(f.doc.id))!
  await appendRename(f, "Latest admitted edit")
  const latest = (await f.journal.read(f.doc.id))!

  let resume!: () => void
  let entered!: () => void
  const suspended = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  const originalRead = reader.read.bind(reader)
  const readSpy = vi.spyOn(reader, "read").mockImplementation(async workspaceId => {
    const checked = await originalRead(workspaceId)
    if (!checked) throw new Error("Workspace disappeared during cache interleaving")
    entered()
    await gate
    return checked
  })
  let loaded: Awaited<ReturnType<typeof reader.loadDocument>> | undefined
  try {
    const pending = reader.loadDocument(f.doc.id)
    await suspended
    if (cacheAction === "evicted") reader.forget(f.doc.id)
    else reader.remember(prefix, prefixLease.doc)
    resume()
    loaded = await pending
    expect(loaded?.heads).toEqual(latest.frontier.heads)
    expect(Automerge.getHeads(loaded!.doc).sort()).toEqual(latest.frontier.heads)
    expect(loaded!.doc.title).toBe("Latest admitted edit")
    reader.forget(f.doc.id)
    // Cache release must not free the caller's independent load lease.
    expect(Automerge.getHeads(loaded!.doc).sort()).toEqual(latest.frontier.heads)
    expect(Automerge.getHeads(prefixLease.doc).sort()).toEqual(prefix.frontier.heads)
  } finally {
    resume()
    readSpy.mockRestore()
    reader.forget(f.doc.id)
    if (loaded) Automerge.free(loaded.doc)
    Automerge.free(prefixLease.doc)
    f.database.close()
  }
})

it("Given a checked prefix ending at nine, When commands ten through twelve arrive, Then the numeric index returns exactly the new ordered tail", async () => {
  const f = await fixture()
  await appendDelta(f, f.frontier, f.delta)
  for (let index = 2; index <= 9; index++) await appendRename(f, `Edit ${index}`)
  const previous = (await f.journal.read(f.doc.id))!.frontier
  for (let index = 10; index <= 12; index++) await appendRename(f, `Edit ${index}`)
  const tail = await f.journal.readAfter(previous)
  expect(tail!.deltas.map(delta => delta.sequence)).toEqual([10, 11, 12])
  expect(tail!.frontier.title).toBe("Edit 12")
  expect(tail!.frontier).toEqual((await f.journal.read(f.doc.id))!.frontier)
  f.database.close()
})

it.each(["bytes", "proof", "role", "missing"])("Given a warm tab and altered %s in a new tail, When it catches up, Then it refuses the new frontier and can recover after the damaged record is restored", async alteration => {
  const f = await fixture()
  await appendDelta(f, f.frontier, f.delta)
  const reader = new StorageDeltaRepository()
  vi.spyOn(reader, "journal").mockResolvedValue(f.journal)
  await reader.read(f.doc.id)
  const delta = await appendRename(f, "Verified recovery")
  const damaged = structuredClone(delta)
  if (alteration === "bytes") damaged.command.changeBytes[0]! ^= 1
  if (alteration === "proof") damaged.command.authorizations[0]!.publicKey = "changed-key"
  if (alteration === "role") damaged.command.role = "visitor"
  const write = f.database.transaction("deltas", "readwrite")
  const done = transactionDone(write)
  if (alteration === "missing") write.objectStore("deltas").delete(delta.id)
  else write.objectStore("deltas").put(damaged)
  await done
  await expect(reader.loadDocument(f.doc.id)).rejects.toThrow(/delta|frontier|chain/i)
  const repair = f.database.transaction("deltas", "readwrite")
  const repaired = transactionDone(repair)
  repair.objectStore("deltas").put(delta)
  await repaired
  expect((await reader.loadDocument(f.doc.id))!.doc.title).toBe("Verified recovery")
  reader.forget(f.doc.id)
  f.database.close()
})

it("Given a checked old basis, When another tab commits a replacement basis and generation, Then catch-up validates the new basis through a cold read", async () => {
  const f = await fixture()
  const reader = new StorageDeltaRepository()
  vi.spyOn(reader, "journal").mockResolvedValue(f.journal)
  await reader.read(f.doc.id)
  const replacement = { ...f.snapshot, title: f.created.title, heads: Automerge.getHeads(f.created).sort(),
    bytes: Automerge.save(f.created), causalEvidence: { bytes: Automerge.save(f.created), decisions: [],
      admissionCheckpoint: await createAdmissionCheckpoint("replacement-basis", Automerge.getHeads(f.created), []) } }
  const frontier = await createDeltaBasis(replacement, "replacement-rights")
  const write = f.database.transaction(["snapshots", "frontiers"], "readwrite")
  const done = transactionDone(write)
  write.objectStore("snapshots").put(replacement)
  write.objectStore("frontiers").put(frontier)
  await done
  const cold = vi.spyOn(f.journal, "read")
  expect((await reader.loadDocument(f.doc.id))!.doc.title).toBe(f.created.title)
  expect(cold).toHaveBeenCalledOnce()
  expect((await reader.read(f.doc.id))!.frontier).toEqual(frontier)
  cold.mockRestore()
  reader.forget(f.doc.id)
  f.database.close()
})

it("Given a stale cached prefix and an already committed command followed by another write, When the old append retries, Then the cache retains neither stale content nor a false current frontier", async () => {
  const f = await fixture()
  const reader = new StorageDeltaRepository()
  vi.spyOn(reader, "journal").mockResolvedValue(f.journal)
  await reader.read(f.doc.id)
  await appendDelta(f, f.frontier, f.delta)
  const first = f.created
  await appendRename(f, "Later committed edit")
  const current = await reader.append(f.frontier, f.delta, first, await readRevision(f), () => {})
  expect(current.revision).toBe(2)
  const loaded = await reader.loadDocument(f.doc.id)
  expect(Automerge.getHeads(loaded!.doc).sort()).toEqual(loaded!.heads)
  expect(loaded!.doc.title).toBe("Later committed edit")
  Automerge.free(loaded!.doc)
  reader.forget(f.doc.id)
  f.database.close()
})

it("Given a stale tab frontier, When two different commands append concurrently, Then exactly one commits and the other cannot overwrite it", async () => {
  const f = await fixture()
  const result = await executeCommand(f.doc, { kind: "renameWorkspace", title: "Competing title" }, f.profile)
  if (!result.ok) throw new Error(result.error.message)
  const competing = await prepareWorkspaceDelta(f.frontier, { ...f.delta.command,
    title: result.value.newDoc.title, receipt: result.value.receipt, proof: result.value.proof,
    changeBytes: Automerge.getLastLocalChange(result.value.newDoc)!,
    authorizations: await prepareLocalChangeAuthorizations(result.value.newDoc, f.profile, [result.value.receipt.changeHash]),
  })
  const expectedRevision = await readRevision(f)
  const results = await Promise.allSettled([
    appendDelta(f, f.frontier, f.delta, f.journal, expectedRevision),
    appendDelta(f, f.frontier, competing, new WorkspaceDeltaJournal(f.database), expectedRevision),
  ])
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"])
  expect((await f.journal.read(f.doc.id))!.deltas).toHaveLength(1)
  expect((await f.journal.readFrontier(f.doc.id))!.revision).toBe(1)
  f.database.close()
})

it("Given a command already committed, When the same append retries, Then its receipt is idempotent and the frontier does not advance", async () => {
  const f = await fixture()
  const committed = await appendDelta(f, f.frontier, f.delta)
  const before = await readRevision(f)
  expect(await appendDelta(f, f.frontier, f.delta)).toEqual(committed)
  expect(await readRevision(f)).toBe(before)
  expect((await f.journal.read(f.doc.id))!.deltas).toHaveLength(1)
  f.database.close()
})

it("Given a failure after writing delta and frontier, When the receipt write fails, Then the transaction preserves the basis and publishes no partial command", async () => {
  const f = await fixture()
  const before = await readWorkspaceRows(f)
  const transaction = f.database.transaction.bind(f.database)
  const injected = vi.spyOn(f.database, "transaction").mockImplementation((...args: Parameters<IDBDatabase["transaction"]>) => {
    const result = transaction(...args)
    if (args[1] === "readwrite") {
      const objectStore = result.objectStore.bind(result)
      vi.spyOn(result, "objectStore").mockImplementation(name => {
        const store = objectStore(name)
        if (name === "receipts") vi.spyOn(store, "add").mockImplementation(() => { throw new Error("Receipt write failed") })
        return store
      })
    }
    return result
  })
  await expect(appendDelta(f, f.frontier, f.delta)).rejects.toThrow("Receipt write failed")
  injected.mockRestore()
  expect(await readWorkspaceRows(f)).toEqual(before)
  expect(await f.journal.readFrontier(f.doc.id)).toEqual(f.frontier)
  expect((await f.journal.read(f.doc.id))!.deltas).toEqual([])
  for (const name of ["receipts", "proofs", "changes", "revisions"]) {
    const read = f.database.transaction(name, "readonly")
    const done = transactionDone(read)
    expect(await requestResult(read.objectStore(name).getAll())).toEqual([])
    await done
  }
  f.database.close()
})

it.each(["bytes", "authorization", "decision", "heads", "missing"])("Given altered %s in the saved delta chain, When a cold reader checks it, Then it refuses the frontier", async alteration => {
  const f = await fixture()
  await appendDelta(f, f.frontier, f.delta)
  const damaged = structuredClone(f.delta)
  if (alteration === "bytes") damaged.command.changeBytes[0]! ^= 1
  if (alteration === "authorization") damaged.command.authorizations[0]!.publicKey = "changed-key"
  if (alteration === "decision") damaged.command.role = "visitor"
  if (alteration === "heads") damaged.command.receipt.afterHeads = ["changed-head"]
  const write = f.database.transaction("deltas", "readwrite")
  const done = transactionDone(write)
  if (alteration === "missing") write.objectStore("deltas").delete(damaged.id)
  else write.objectStore("deltas").put(damaged)
  await done
  await expect(new WorkspaceDeltaJournal(f.database).read(f.doc.id)).rejects.toThrow(/delta|frontier|chain/i)
  f.database.close()
})

it.each(["policy", "rights", "generation"])("Given changed %s in local frontier metadata, When a cold reader checks it, Then the integrity chain cannot be reused", async alteration => {
  const f = await fixture()
  const altered = structuredClone(f.frontier)
  if (alteration === "policy") altered.policy = "old-policy"
  if (alteration === "rights") altered.authorityFingerprint = "other-authority"
  if (alteration === "generation") altered.generation = "other-generation"
  const write = f.database.transaction("frontiers", "readwrite")
  const done = transactionDone(write)
  write.objectStore("frontiers").put(altered)
  await done
  await expect(f.journal.read(f.doc.id)).rejects.toThrow(/delta|frontier|chain/i)
  f.database.close()
})

it("Given pending history in a saved snapshot, When creating an incremental basis, Then storage refuses to mark it fully admitted", async () => {
  const f = await fixture()
  f.snapshot.causalEvidence!.decisions.push({ hash: "pending", status: { type: "pending", reason: "Missing dependency" } })
  await expect(createDeltaBasis(f.snapshot, "verified-current-rights")).rejects.toThrow(/fully admitted/)
  f.database.close()
})
