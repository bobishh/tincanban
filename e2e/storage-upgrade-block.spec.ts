import { expect, test } from "./support/coverage"

for (const version of [2, 3]) {
test(`Given a held version ${version} journal with existing deltas, When the storage upgrade is blocked, Then startup explains recovery and preserves ordered records with revision storage after the old tab closes`, async ({ page, context, baseURL }) => {
  await page.route("**/version-two.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Version two holder</title>" }))
  await page.goto((baseURL ?? "http://127.0.0.1:4244") + "/version-two.html")
  await page.evaluate(version => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("tincanban-workspace-state", version)
    request.onupgradeneeded = () => {
      for (const name of ["changes", "proofs", "receipts", "snapshots", "authorizations", "frontiers", "deltas"]) {
        const store = request.result.createObjectStore(name, { keyPath: "id" })
        store.createIndex("workspaceId", "workspaceId", { unique: false })
        if (name === "snapshots") store.createIndex("catalog", ["workspaceId", "title", "savedAt"])
        if (name === "deltas" && version === 3) store.createIndex("sequence", ["workspaceId", "generation", "sequence"], { unique: true })
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const write = database.transaction("deltas", "readwrite")
      for (const sequence of [10, 2]) write.objectStore("deltas").put({ id: `retained-${sequence}`,
        workspaceId: "upgrade-proof", generation: "retained", sequence, command: { retained: true } })
      write.oncomplete = () => resolve()
      write.onabort = () => reject(write.error)
      ;(window as Window & { versionTwoJournal?: IDBDatabase }).versionTwoJournal = database
    }
  }), version)
  const app = await context.newPage()
  await app.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(app.getByRole("alert")).toContainText("Close other tincanban tabs and reload", { timeout: 8_000 })
  await page.close()
  await app.reload()
  await expect(app.getByRole("button", { name: "Sync", exact: true })).toBeEnabled({ timeout: 15_000 })
  expect(await app.evaluate(() => new Promise<{ version: number; sequences: number[]; revisions: boolean }>((resolve, reject) => {
    const request = indexedDB.open("tincanban-workspace-state")
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction("deltas", "readonly")
      const rows = read.objectStore("deltas").index("sequence").getAll(IDBKeyRange.bound(
        ["upgrade-proof", "retained", 1], ["upgrade-proof", "retained", 20]))
      rows.onsuccess = () => { resolve({ version: database.version, sequences: rows.result.map((row: { sequence: number }) => row.sequence), revisions: database.objectStoreNames.contains("revisions") }); database.close() }
      rows.onerror = () => { reject(rows.error); database.close() }
    }
  }))).toEqual({ version: 4, sequences: [2, 10], revisions: true })
  await app.close()
})
}

test("Given a local journal created before the catalog index, when tincanban opens, then it keeps the board and loads", async ({ page, baseURL }) => {
  await page.route("**/old-journal.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Old journal</title>" }))
  await page.goto((baseURL ?? "http://127.0.0.1:4244") + "/old-journal.html")
  const workspaceId = await page.evaluate(async () => {
    const { initializePolicyBrowserRuntime } = await import("/src/iroh.ts")
    const { initializeAutomerge } = await import("/src/crdt.ts")
    const { createWorkspaceDoc } = await import("/src/domain/seeds.ts")
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { recordGenesisAuthority } = await import("/src/sync/changeAuthorization.ts")
    const Automerge = await import("/@id/@automerge/automerge/slim")
    await initializePolicyBrowserRuntime()
    await initializeAutomerge()
    const { default: wasmUrl } = await import("/@id/@automerge/automerge/automerge.wasm?url")
    await Automerge.initializeWasm(wasmUrl)
    const profile = await bootstrapIdentity("Upgrade owner")
    const id = crypto.randomUUID()
    const doc = Automerge.from(createWorkspaceDoc(id, "Older local board", profile.identity.personId, "blank"))
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-workspace-state", 1)
      request.onupgradeneeded = () => {
        for (const name of ["changes", "proofs", "receipts", "snapshots", "authorizations"]) {
          const store = request.result.createObjectStore(name, { keyPath: "id" })
          store.createIndex("workspaceId", "workspaceId", { unique: false })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction("snapshots", "readwrite")
    transaction.objectStore("snapshots").put({ id, workspaceId: id, title: doc.title,
      heads: Automerge.getHeads(doc), bytes: Automerge.save(doc), savedAt: new Date().toISOString() })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
    await recordGenesisAuthority(doc as never, profile)
    return id
  })
  await page.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(page.getByRole("status", { name: "Board status" })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeEnabled({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    return useTincanban().getActiveDoc()?.id
  }), { timeout: 15_000 }).toBe(workspaceId)
  expect(await page.evaluate(async id => {
    const { defaultStorage } = await import("/src/storage.ts")
    return (await defaultStorage.loadWorkspaceDoc(id))?.doc.title
  }, workspaceId)).toBe("Older local board")
})

test("Given normal browser storage, when tincanban starts, then workspace controls load", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole("status", { name: "Board status" })).toHaveCount(0)
  const databaseNames = await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name))
  expect(databaseNames).toContain("tincanban-workspace-state")
  expect(databaseNames).not.toContain("tincanban-workspace-journal-v1")
})

test("Given a legacy version upgrade is pending, when tincanban opens it unversioned, then timeout is distinguishable and recovers", async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const holder = await context.newPage()
  await holder.route("**/legacy-holder.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Legacy holder</title>" }))
  await holder.goto((baseURL ?? "http://127.0.0.1:4244") + "/legacy-holder.html")
  await holder.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("tincanban-workspace-journal-v1", 1)
    request.onupgradeneeded = () => {
      for (const name of ["changes", "proofs", "receipts", "snapshots", "authorizations"]) {
        const store = request.result.createObjectStore(name, { keyPath: "id" })
        store.createIndex("workspaceId", "workspaceId", { unique: false })
      }
    }
    request.onsuccess = () => { (window as Window & { legacyDb?: IDBDatabase }).legacyDb = request.result; resolve() }
    request.onerror = () => reject(request.error)
  }))
  const upgrader = await context.newPage()
  await upgrader.route("**/legacy-upgrader.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Legacy upgrader</title>" }))
  await upgrader.goto((baseURL ?? "http://127.0.0.1:4244") + "/legacy-upgrader.html")
  await upgrader.evaluate(() => new Promise<void>(resolve => {
    const request = indexedDB.open("tincanban-workspace-journal-v1", 2)
    const state = window as Window & { legacyUpgradeState?: string; legacyUpgradeRequest?: IDBOpenDBRequest }
    state.legacyUpgradeRequest = request
    request.onblocked = () => { state.legacyUpgradeState = "blocked"; resolve() }
    request.onsuccess = () => { state.legacyUpgradeState = "complete"; request.result.close() }
    request.onerror = () => { state.legacyUpgradeState = request.error?.name ?? "failed" }
  }))
  await expect.poll(() => upgrader.evaluate(() => (window as Window & { legacyUpgradeState?: string }).legacyUpgradeState)).toBe("blocked")
  const app = await context.newPage()
  const storageEvents: string[] = []
  app.on("console", message => {
    if (message.text().startsWith("[tincanban.storage]")) storageEvents.push(message.text())
  })
  await app.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(app.getByRole("alert")).toBeVisible({ timeout: 8_000 })
  await expect(app.getByRole("alert")).toContainText("Could not open your local data")
  await expect.poll(() => storageEvents.some(event => event.includes("legacy-open-timeout"))).toBe(true)
  expect(storageEvents.some(event => event.includes("legacy-open-blocked"))).toBe(false)
  await holder.close()
  await expect.poll(() => upgrader.evaluate(() => (window as Window & { legacyUpgradeState?: string }).legacyUpgradeState)).toBe("complete")
  await expect.poll(() => storageEvents.some(event => event.includes("legacy-open-success"))).toBe(true)
  await app.reload()
  await expect(app.getByRole("button", { name: "Sync", exact: true })).toBeEnabled({ timeout: 15_000 })
  await expect(app.getByRole("status", { name: "Board status" })).toHaveCount(0)
  await context.close()
})

test("Given legacy records conflict with current receipt, when migration aborts and conflict is fixed, then retry copies all records atomically", async ({ page, baseURL }) => {
  await page.route("**/journal-abort.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Journal abort fixture</title>" }))
  await page.goto((baseURL ?? "http://127.0.0.1:4244") + "/journal-abort.html")
  const result = await page.evaluate(async () => {
    const stores = ["changes", "proofs", "receipts", "snapshots", "authorizations"]
    const open = (name: string, catalog: boolean) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onupgradeneeded = () => {
        for (const storeName of stores) {
          const store = request.result.createObjectStore(storeName, { keyPath: "id" })
          store.createIndex("workspaceId", "workspaceId", { unique: false })
          if (catalog && storeName === "snapshots") store.createIndex("catalog", ["workspaceId", "title", "savedAt"], { unique: false })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const workspaceId = "abort-retry-workspace"
    const changeId = workspaceId + ":legacy-change"
    const receiptId = workspaceId + ":legacy-transaction"
    const source = await open("tincanban-workspace-journal-v1", false)
    const sourceTx = source.transaction(stores, "readwrite")
    sourceTx.objectStore("changes").put({ id: changeId, workspaceId, changeHash: "legacy-change", bytes: new Uint8Array([1, 2]), addedAt: "old" })
    sourceTx.objectStore("proofs").put({ id: changeId, workspaceId, changeHash: "legacy-change", proof: { signature: "legacy-proof" } })
    sourceTx.objectStore("receipts").put({ id: receiptId, workspaceId, transactionId: "legacy-transaction", receipt: { transactionId: "legacy-transaction", changeHash: "legacy-change" } })
    sourceTx.objectStore("snapshots").put({ id: workspaceId, workspaceId, title: "legacy", heads: [], bytes: new Uint8Array([3]), savedAt: "old" })
    sourceTx.objectStore("authorizations").put({ id: workspaceId, workspaceId, records: [{ signature: "legacy-authorization" }] })
    await new Promise<void>((resolve, reject) => { sourceTx.oncomplete = () => resolve(); sourceTx.onabort = () => reject(sourceTx.error) })
    const targetSeed = await open("tincanban-workspace-state", true)
    const conflictingTx = targetSeed.transaction("receipts", "readwrite")
    conflictingTx.objectStore("receipts").put({ id: receiptId, workspaceId, transactionId: "legacy-transaction", receipt: { transactionId: "legacy-transaction", changeHash: "wrong-current-change" } })
    await new Promise<void>((resolve, reject) => { conflictingTx.oncomplete = () => resolve(); conflictingTx.onabort = () => reject(conflictingTx.error) })
    targetSeed.close()

    const { openWorkspaceJournal, transactionDone, requestResult } = await import("/src/storageJournal.ts")
    let conflict = ""
    try { await openWorkspaceJournal() } catch (error) { conflict = error instanceof Error ? error.message : String(error) }
    const afterAbort = await open("tincanban-workspace-state", true)
    const check = afterAbort.transaction(stores, "readonly")
    const afterAbortDone = transactionDone(check)
    const [snapshot, changes, proofs, receipts, authorizations] = await Promise.all([
      requestResult(check.objectStore("snapshots").get(workspaceId)),
      requestResult(check.objectStore("changes").getAll()),
      requestResult(check.objectStore("proofs").getAll()),
      requestResult(check.objectStore("receipts").getAll()),
      requestResult(check.objectStore("authorizations").getAll()),
    ]) as [unknown, unknown[], unknown[], Array<{ id: string; receipt: { changeHash: string } }>, unknown[]]
    await afterAbortDone
    const markerPresent = authorizations.some(row => (row as { id: string }).id === "__meta__legacy-journal-migration-complete__")
    const rowsAfterAbort = { snapshot: Boolean(snapshot), changes: changes.length, proofs: proofs.length, receipts: receipts.length, markerPresent }
    afterAbort.close()

    const fix = await open("tincanban-workspace-state", true)
    const fixTx = fix.transaction("receipts", "readwrite")
    fixTx.objectStore("receipts").delete(receiptId)
    await new Promise<void>((resolve, reject) => { fixTx.oncomplete = () => resolve(); fixTx.onabort = () => reject(fixTx.error) })
    fix.close()
    const migrated = await openWorkspaceJournal()
    const copyTx = migrated.transaction(stores, "readonly")
    const copyDone = transactionDone(copyTx)
    const [copiedSnapshot, copiedChanges, copiedProofs, copiedReceipt, copiedAuthorizations] = await Promise.all([
      requestResult(copyTx.objectStore("snapshots").get(workspaceId)),
      requestResult(copyTx.objectStore("changes").getAll()),
      requestResult(copyTx.objectStore("proofs").getAll()),
      requestResult(copyTx.objectStore("receipts").get(receiptId)) as Promise<{ receipt?: { changeHash?: string } } | undefined>,
      requestResult(copyTx.objectStore("authorizations").get(workspaceId)) as Promise<{ records?: unknown[] } | undefined>,
    ])
    await copyDone
    migrated.close()
    source.close()
    return {
      conflict, rowsAfterAbort,
      copied: Boolean(copiedSnapshot) && copiedChanges.length === 1 && copiedProofs.length === 1 &&
        copiedReceipt?.receipt?.changeHash === "legacy-change" && copiedAuthorizations?.records?.length === 1,
    }
  })
  expect(result.conflict).toContain("receipt conflicts")
  expect(result.rowsAfterAbort).toEqual({ snapshot: false, changes: 0, proofs: 0, receipts: 1, markerPresent: false })
  expect(result.copied).toBe(true)
})
