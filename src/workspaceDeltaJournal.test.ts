import { readFile } from "node:fs/promises"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity } from "./domain/identity"
import { createWorkspaceDoc } from "./domain/seeds"
import { executeCommand } from "./domain/commands"
import { createAdmissionCheckpoint } from "./sync/workspaceAdmissionCheckpoint"
import { prepareLocalChangeAuthorizations, recordGenesisAuthority } from "./sync/changeAuthorization"
import { requestResult, transactionDone, type StoredWorkspaceSnapshot } from "./storageJournal"
import { createDeltaBasis, prepareWorkspaceDelta, WorkspaceDeltaJournal } from "./workspaceDeltaJournal"
import { StorageDeltaRepository } from "./storageDeltaRepository"

beforeAll(async () => {
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
      for (const name of ["snapshots", "frontiers", "deltas", "changes", "proofs", "receipts"]) {
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
  const next = await f.journal.append(f.frontier, f.delta)
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

async function appendRename(f: Awaited<ReturnType<typeof fixture>>, title: string) {
  const frontier = (await f.journal.readFrontier(f.doc.id))!
  const result = await executeCommand(f.created, { kind: "renameWorkspace", title }, f.profile)
  if (!result.ok) throw new Error(result.error.message)
  const delta = await prepareWorkspaceDelta(frontier, { ...f.delta.command, title,
    receipt: result.value.receipt, proof: result.value.proof,
    changeBytes: Automerge.getLastLocalChange(result.value.newDoc)!,
    authorizations: await prepareLocalChangeAuthorizations(result.value.newDoc, f.profile, [result.value.receipt.changeHash]),
  })
  await f.journal.append(frontier, delta)
  f.created = result.value.newDoc
  return delta
}

it("Given a warm tab with a checked prefix, When another tab appends a command, Then catch-up reads no snapshot or old deltas and applies only the new tail", async () => {
  const f = await fixture()
  await f.journal.append(f.frontier, f.delta)
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
  await f.journal.append(f.frontier, f.delta)
  const tail = vi.spyOn(f.journal, "readAfter")
  const loaded = await reader.loadDocument(f.doc.id, f.created)
  expect(loaded!.doc.title).toBe(f.created.title)
  expect(tail).toHaveBeenCalledOnce()
  tail.mockRestore()
  reader.forget(f.doc.id)
  Automerge.free(loaded!.doc)
  f.database.close()
})

it("Given a checked prefix ending at nine, When commands ten through twelve arrive, Then the numeric index returns exactly the new ordered tail", async () => {
  const f = await fixture()
  await f.journal.append(f.frontier, f.delta)
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
  await f.journal.append(f.frontier, f.delta)
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
  await f.journal.append(f.frontier, f.delta)
  const first = f.created
  await appendRename(f, "Later committed edit")
  const current = await reader.append(f.frontier, f.delta, first)
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
  const results = await Promise.allSettled([f.journal.append(f.frontier, f.delta), new WorkspaceDeltaJournal(f.database).append(f.frontier, competing)])
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"])
  expect((await f.journal.read(f.doc.id))!.deltas).toHaveLength(1)
  expect((await f.journal.readFrontier(f.doc.id))!.revision).toBe(1)
  f.database.close()
})

it("Given a command already committed, When the same append retries, Then its receipt is idempotent and the frontier does not advance", async () => {
  const f = await fixture()
  const committed = await f.journal.append(f.frontier, f.delta)
  expect(await f.journal.append(f.frontier, f.delta)).toEqual(committed)
  expect((await f.journal.read(f.doc.id))!.deltas).toHaveLength(1)
  f.database.close()
})

it("Given a failure after writing delta and frontier, When the receipt write fails, Then the transaction preserves the basis and publishes no partial command", async () => {
  const f = await fixture()
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
  await expect(f.journal.append(f.frontier, f.delta)).rejects.toThrow("Receipt write failed")
  injected.mockRestore()
  expect(await f.journal.readFrontier(f.doc.id)).toEqual(f.frontier)
  expect((await f.journal.read(f.doc.id))!.deltas).toEqual([])
  for (const name of ["receipts", "proofs", "changes"]) {
    const read = f.database.transaction(name, "readonly")
    const done = transactionDone(read)
    expect(await requestResult(read.objectStore(name).getAll())).toEqual([])
    await done
  }
  f.database.close()
})

it.each(["bytes", "authorization", "decision", "heads", "missing"])("Given altered %s in the saved delta chain, When a cold reader checks it, Then it refuses the frontier", async alteration => {
  const f = await fixture()
  await f.journal.append(f.frontier, f.delta)
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
