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
  }))).toEqual({ version: 7, sequences: [2, 10], revisions: true })
  await app.close()
})
}

test("Given a local journal created before the catalog index, when tincanban opens, then it keeps the board and loads", async ({ page, baseURL }) => {
  await page.route("**/old-journal.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Old journal</title>" }))
  await page.goto((baseURL ?? "http://127.0.0.1:4244") + "/old-journal.html")
  const workspaceId = await page.evaluate(async () => {
    const { initializePolicyBrowserRuntime } = await import("/src/iroh.ts")
    const { initializeAutomerge } = await import("/src/crdt.ts")
    const { createWorkspaceDoc } = await import("/src/test/boardFixture.ts")
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
    const { useTincanban } = await import("/src/test/stateFixture.ts")
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

})
