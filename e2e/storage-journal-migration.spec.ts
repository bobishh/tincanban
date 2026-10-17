import { expect, test } from "./support/coverage"

test("Given a held legacy journal with committed board and receipts, when tincanban opens and edits, then migration preserves data and does not replay compacted changes", async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const holder = await context.newPage()
  await holder.route("**/journal-fixture.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Journal fixture</title>" }))
  await holder.goto((baseURL ?? "http://127.0.0.1:4244") + "/journal-fixture.html")
  const seeded = await holder.evaluate(async () => {
    const { initializePolicyBrowserRuntime } = await import("/src/iroh.ts")
    const { initializeAutomerge } = await import("/src/crdt.ts")
    await initializePolicyBrowserRuntime()
    await initializeAutomerge()
    const A = await import("/@id/@automerge/automerge/slim")
    const { default: wasmUrl } = await import("/@id/@automerge/automerge/automerge.wasm?url")
    await A.initializeWasm(wasmUrl)
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { createWorkspaceDoc } = await import("/src/test/boardFixture.ts")
    const { executeCommand } = await import("/src/domain/commands.ts")
    const { recordGenesisAuthority, prepareLocalChangeAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const { openWorkspaceJournal, transactionDone } = await import("/src/storageJournal.ts")
    const { writeLocal } = await import("/src/localDb.ts")
    const profile = await bootstrapIdentity("Migration owner")
    const doc = A.from(createWorkspaceDoc(crypto.randomUUID(), "Preserved legacy board", profile.identity.personId, "blank"))
    await recordGenesisAuthority(doc, profile)
    const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
    const changed = await executeCommand(doc, { kind: "createItem", parentId: column.id, title: "Preserved legacy card" }, profile)
    if (!changed.ok) throw new Error(changed.error.message)
    const { newDoc, receipt, proof } = changed.value
    const bytes = A.getLastLocalChange(newDoc)!
    const authorizations = await prepareLocalChangeAuthorizations(newDoc, profile, A.getAllChanges(newDoc).map(change => A.decodeChange(change).hash))
    const initialized = await openWorkspaceJournal()
    initialized.close()
    for (const name of ["tincanban-workspace-state", "tincanban-workspace-journal-v1"]) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error("Fixture database remained open"))
      })
    }
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-workspace-journal-v1", 1)
      request.onupgradeneeded = () => {
        for (const name of ["changes", "proofs", "receipts", "snapshots", "authorizations"]) {
          const store = request.result.createObjectStore(name, { keyPath: "id" })
          store.createIndex("workspaceId", "workspaceId", { unique: false })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = ["changes", "proofs", "receipts", "snapshots", "authorizations"]
    const transaction = legacy.transaction(stores, "readwrite")
    const committed = transactionDone(transaction)
    const changeId = `${doc.id}:${receipt.changeHash}`
    transaction.objectStore("changes").put({ id: changeId, workspaceId: doc.id, changeHash: receipt.changeHash, bytes, addedAt: new Date().toISOString() })
    transaction.objectStore("proofs").put({ id: changeId, workspaceId: doc.id, changeHash: receipt.changeHash, proof })
    transaction.objectStore("receipts").put({ id: `${doc.id}:${receipt.transactionId}`, workspaceId: doc.id, transactionId: receipt.transactionId, receipt })
    transaction.objectStore("snapshots").put({ id: doc.id, workspaceId: doc.id, title: newDoc.title, heads: A.getHeads(newDoc), bytes: A.save(newDoc), savedAt: new Date().toISOString() })
    transaction.objectStore("authorizations").put({ id: doc.id, workspaceId: doc.id, records: authorizations })
    await committed
    await writeLocal("tincanban.active_workspace_id", doc.id)
    // Deliberately retain a connection that ignores versionchange.
    ;(window as Window & { legacyJournal?: IDBDatabase }).legacyJournal = legacy
    return { workspaceId: doc.id, transactionId: receipt.transactionId, changeHash: receipt.changeHash, receipt, proof }
  })
  const app = await context.newPage()
  await app.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(app.getByRole("heading", { name: /Preserved legacy board/ })).toBeVisible({ timeout: 15_000 })
  await expect(app.getByText("Preserved legacy card", { exact: true })).toBeVisible()
  const preserved = await app.evaluate(async seed => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const receipt = await defaultStorage.getReceipt(seed.workspaceId, seed.transactionId)
    const proof = await defaultStorage.getProof(seed.workspaceId, seed.changeHash)
    const replayHash = "different-replayed-change"
    const replayReceipt = await defaultStorage.commitTransaction(seed.workspaceId,
      { ...seed.receipt, changeHash: replayHash }, new Uint8Array([9, 8, 7]),
      { ...seed.proof, changeHash: replayHash })
    const replayProof = await defaultStorage.getProof(seed.workspaceId, replayHash)
    const replayChange = (await defaultStorage.listChanges(seed.workspaceId)).some(change => change.changeHash === replayHash)
    await defaultStorage.compactWorkspace(seed.workspaceId, tincanban.getActiveDoc()!)
    const compacted = (await defaultStorage.listChanges(seed.workspaceId)).length
    const column = Object.values(tincanban.getActiveDoc()!.entities).find(entity => entity.kind === "column")!
    await tincanban.executeCommandAsync({ kind: "createItem", parentId: column.id, title: "Saved after migration" })
    return { receipt, proof, compacted, replayReceipt, replayProof, replayChange }
  }, seeded)
  expect(preserved.receipt).toEqual(seeded.receipt)
  expect(preserved.proof).toEqual(seeded.proof)
  expect(preserved.replayReceipt).toEqual(seeded.receipt)
  expect(preserved.replayProof).toBeNull()
  expect(preserved.replayChange).toBe(false)
  expect(preserved.compacted).toBe(0)
  await app.reload()
  await expect(app.getByText("Preserved legacy card", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(app.getByText("Saved after migration", { exact: true })).toBeVisible()
  const reloaded = await app.evaluate(async seed => {
    const { defaultStorage } = await import("/src/storage.ts")
    const changes = await defaultStorage.listChanges(seed.workspaceId)
    return { oldChangeReimported: changes.some(change => change.changeHash === seed.changeHash), receipt: await defaultStorage.getReceipt(seed.workspaceId, seed.transactionId) }
  }, seeded)
  expect(reloaded.oldChangeReimported).toBe(false)
  expect(reloaded.receipt).toEqual(seeded.receipt)
  expect(await holder.evaluate(() => (window as Window & { legacyJournal?: IDBDatabase }).legacyJournal?.version)).toBe(1)
  await context.close()
})
