import { expect, test } from "./support/coverage"
import { openStorageHarness } from "./support/storageHarness"

test("Given two tabs persist different changes concurrently, when storage reopens, then both durable records remain", async ({ page }) => {
  await openStorageHarness(page)
  const result = await page.evaluate(async () => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const workspaceId = `concurrent-${crypto.randomUUID()}`
    const isolated = () => new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
    const first = isolated()
    const second = isolated()
    const receiptA = { transactionId: "tx-a", changeHash: "change-a", saved: true }
    const receiptB = { transactionId: "tx-b", changeHash: "change-b", saved: true }
    const proofA = { payload: { changeHash: "change-a" } }
    const proofB = { payload: { changeHash: "change-b" } }

    await Promise.all([
      first.commitTransaction(workspaceId, receiptA as never, new Uint8Array([1]), proofA as never),
      second.commitTransaction(workspaceId, receiptB as never, new Uint8Array([2]), proofB as never),
    ])

    const reopened = isolated()
    return {
      changes: (await reopened.listChanges(workspaceId)).map(change => change.changeHash).sort(),
      receipts: await Promise.all([reopened.getReceipt(workspaceId, "tx-a"), reopened.getReceipt(workspaceId, "tx-b")]),
      proofs: await Promise.all([reopened.getProof(workspaceId, "change-a"), reopened.getProof(workspaceId, "change-b")]),
    }
  })

  expect(result.changes).toEqual(["change-a", "change-b"])
  expect(result.receipts.every(Boolean)).toBe(true)
  expect(result.proofs.every(Boolean)).toBe(true)
})

test("Given proof persistence fails, when a transaction aborts, then no change or receipt leaks", async ({ page }) => {
  await openStorageHarness(page)
  const result = await page.evaluate(async () => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const workspaceId = `abort-${crypto.randomUUID()}`
    const isolated = () => new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
    const storage = isolated()
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "proofs") throw new Error("proof write failed")
      return originalPut.apply(this, args)
    }
    let error = ""
    try {
      await storage.commitTransaction(workspaceId,
        { transactionId: "tx-abort", changeHash: "change-abort", saved: true } as never,
        new Uint8Array([9]), { payload: { changeHash: "change-abort" } } as never)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }

    const reopened = isolated()
    return {
      error,
      changes: (await reopened.listChanges(workspaceId)).map(change => change.changeHash),
      receipt: await reopened.getReceipt(workspaceId, "tx-abort"),
      proof: await reopened.getProof(workspaceId, "change-abort"),
    }
  })

  expect(result.error).toContain("proof write failed")
  expect(result.changes).toEqual([])
  expect(result.receipt).toBeNull()
  expect(result.proof).toBeNull()
})

test("Given two open tabs, when both edit one workspace together, then both converge on both changes", async ({ page }) => {
  await page.goto("/")
  const second = await page.context().newPage()
  await second.goto("/")
  const edit = async (target: typeof page, id: string, title: string) => target.evaluate(async ({ id, title }) => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const doc = tincanban.getActiveDoc()!
    const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
    await tincanban.executeCommandAsync({ kind: "createItem", id, parentId: column.id, title })
  }, { id, title })

  try {
    await Promise.all([
      edit(page, crypto.randomUUID(), "Cross-tab A"),
      edit(second, crypto.randomUUID(), "Cross-tab B"),
    ])
    await expect.poll(async () => Promise.all([page, second].map(target => target.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const tincanban = useTincanban()
      await tincanban.whenReady()
      return Object.values(tincanban.getActiveDoc()!.entities)
        .map(entity => "title" in entity ? entity.title : "")
        .filter(title => title === "Cross-tab A" || title === "Cross-tab B")
        .sort()
    }))), { timeout: 15_000 }).toEqual([
      ["Cross-tab A", "Cross-tab B"],
      ["Cross-tab A", "Cross-tab B"],
    ])
  } finally {
    await second.close()
  }
})

test("Given independent tabs receive peer branches together, when both admissions finish, then reopened workspace keeps both", async ({ page }) => {
  await page.goto("/")
  const second = await page.context().newPage()
  await second.goto("/")
  try {
    const branches = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { executeCommand } = await import("/src/domain/commands.ts")
      const { prepareLocalChangeAuthorizations, exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
      const Automerge = await import("/@id/@automerge/automerge/slim")
      const tincanban = useTincanban()
      await tincanban.whenReady()
      const base = tincanban.getActiveDoc()!
      const profile = tincanban.getCurrentProfile()!
      const column = Object.values(base.entities).find(entity => entity.kind === "column")!
      return Promise.all(["Incoming A", "Incoming B"].map(async title => {
        const result = await executeCommand(Automerge.clone(base), { kind: "createItem", parentId: column.id, title }, profile)
        if (!result.ok) throw new Error(result.error.message)
        const proofs = await prepareLocalChangeAuthorizations(result.value.newDoc, profile, [result.value.receipt.changeHash])
        const bundle = await exportAuthorizationBundle(Automerge.save(base), profile)
        return { id: base.id, bytes: Array.from(Automerge.save(result.value.newDoc)), authorization: { ...bundle, records: [...bundle.records, ...proofs] } }
      }))
    })
    await Promise.all([
      ...[page, second].map((target, index) => target.evaluate(async branch => {
        const { useTincanban } = await import("/src/test/stateFixture.ts")
        await useTincanban().whenReady()
        await useTincanban().mergeAuthorizedWorkspace(branch.id, new Uint8Array(branch.bytes), branch.authorization)
      }, branches[index]!)),
      second.evaluate(async () => {
        const { useTincanban } = await import("/src/test/stateFixture.ts")
        const tincanban = useTincanban()
        await tincanban.whenReady()
        const column = Object.values(tincanban.getActiveDoc()!.entities).find(entity => entity.kind === "column")!
        await tincanban.executeCommandAsync({ kind: "createItem", parentId: column.id, title: "Local alongside peers" })
      }),
    ])
    await second.reload()
    await expect.poll(() => second.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      await useTincanban().whenReady()
      return Object.values(useTincanban().getActiveDoc()!.entities).flatMap(entity => "title" in entity && ["Incoming A", "Incoming B", "Local alongside peers"].includes(entity.title) ? [entity.title] : []).sort()
    })).toEqual(["Incoming A", "Incoming B", "Local alongside peers"])
  } finally { await second.close() }
})

test("Given authorization write fails during admission, when transaction aborts, then document, UI and notifications remain unchanged", async ({ page }) => {
  await page.goto("/")
  const result = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const { executeCommand } = await import("/src/domain/commands.ts")
    const { prepareLocalChangeAuthorizations, exportAuthorizationBundle, exportAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const Automerge = await import("/@id/@automerge/automerge/slim")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const base = tincanban.getActiveDoc()!
    const profile = tincanban.getCurrentProfile()!
    const column = Object.values(base.entities).find(entity => entity.kind === "column")!
    const command = await executeCommand(Automerge.clone(base), { kind: "createItem", parentId: column.id, title: "Rejected peer item" }, profile)
    if (!command.ok) throw new Error(command.error.message)
    const incoming = await prepareLocalChangeAuthorizations(command.value.newDoc, profile, [command.value.receipt.changeHash])
    const bundle = await exportAuthorizationBundle(Automerge.save(base), profile)
    const beforeProofs = JSON.stringify(await exportAuthorizations(Automerge.save(base)))
    let notifications = 0
    const unsubscribe = tincanban.subscribeLocalChanges(() => { notifications++ })
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "authorizations") throw new Error("authorization write failed")
      return originalPut.apply(this, args)
    }
    let error = ""
    try {
      await tincanban.mergeAuthorizedWorkspace(base.id, Automerge.save(command.value.newDoc), { ...bundle, records: [...bundle.records, ...incoming] })
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { IDBObjectStore.prototype.put = originalPut; unsubscribe() }
    const durable = (await new WorkspaceStorage().loadWorkspaceDoc(base.id))!.doc
    return { error, notifications, durableHeads: Automerge.getHeads(durable), beforeHeads: Automerge.getHeads(base), uiHeads: Automerge.getHeads(tincanban.getActiveDoc()!), beforeProofs, afterProofs: JSON.stringify(await exportAuthorizations(Automerge.save(durable))) }
  })
  expect(result.error).toContain("authorization write failed")
  expect(result.notifications).toBe(0)
  expect(result.durableHeads).toEqual(result.beforeHeads)
  expect(result.uiHeads).toEqual(result.beforeHeads)
  expect(result.afterProofs).toEqual(result.beforeProofs)
})

test("Given legacy snapshot and proof databases, when a command commits, then migration preserves history and reopened catalog", async ({ page }) => {
  await page.goto("/")
  const result = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const { writeLocal } = await import("/src/localDb.ts")
    const { toBase64Url } = await import("/src/domain/identity.ts")
    const { createWorkspaceDoc } = await import("/src/test/boardFixture.ts")
    const { prepareLocalChangeAuthorizations, exportAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const { persistAuthorizedCommand } = await import("/src/statePersistence.ts")
    const { recordGenesisAuthority } = await import("/src/sync/changeAuthorization.ts")
    const { openWorkspaceJournal, transactionDone } = await import("/src/storageJournal.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const profile = tincanban.getCurrentProfile()!
    const { initializeWasm } = A
    const { default: wasmUrl } = await import("/@id/@automerge/automerge/automerge.wasm?url")
    await initializeWasm(wasmUrl)
    const doc = A.from(createWorkspaceDoc(crypto.randomUUID(), "Legacy migration", profile.identity.personId, "blank"))
    await recordGenesisAuthority(doc, profile)
    const hashes = A.getAllChanges(doc).map(change => A.decodeChange(change).hash)
    const proofs = await prepareLocalChangeAuthorizations(doc, profile, hashes)
    // Seed the pre-migration databases, not the new snapshot/proof stores.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-write-authorizations-v1")
      request.onupgradeneeded = () => request.result.createObjectStore("records")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const seed = db.transaction("records", "readwrite")
    const seeded = transactionDone(seed)
    seed.objectStore("records").put(proofs, doc.id)
    await seeded
    db.close()
    const journal = await openWorkspaceJournal()
    const clear = journal.transaction("authorizations", "readwrite")
    const cleared = transactionDone(clear)
    clear.objectStore("authorizations").delete(doc.id)
    await cleared
    await writeLocal(`tincanban.snapshot.${doc.id}`, JSON.stringify({ heads: A.getHeads(doc), bytesBase64: toBase64Url(A.save(doc)), savedAt: new Date().toISOString() }))
    const storage = new WorkspaceStorage()
    const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
    await persistAuthorizedCommand((await storage.loadWorkspaceDoc(doc.id))!.doc, { kind: "createItem", parentId: column.id, title: "Migrated edit" }, profile, storage)
    const reopened = new WorkspaceStorage()
    const loaded = (await reopened.loadWorkspaceDoc(doc.id))!.doc
    const authorization = await exportAuthorizations(A.save(loaded))
    return { titles: Object.values(loaded.entities).map(entity => "title" in entity ? entity.title : ""), catalog: (await reopened.listWorkspaces()).find(workspace => workspace.id === doc.id)?.title, legacyProofPreserved: proofs.every(proof => authorization.some(record => record.signed.signature === proof.signed.signature)), coveredHashes: authorization.flatMap(record => record.signed.payload.hashes), allHashes: A.getAllChanges(loaded).map(change => A.decodeChange(change).hash) }
  })
  expect(result.titles).toContain("Migrated edit")
  expect(result.catalog).toBe("Legacy migration")
  expect(result.legacyProofPreserved).toBe(true)
  expect(result.coveredHashes).toEqual(expect.arrayContaining(result.allHashes))
})
