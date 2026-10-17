import { expect, test } from "./support/coverage"

test("Given snapshots in local kv and changes in legacy journal, when default storage loads workspace, then it restores both", async ({ page, baseURL }) => {
  await page.route("**/storage-offline-shape.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Offline storage fixture</title>" }))
  await page.goto((baseURL ?? "http://127.0.0.1:4244") + "/storage-offline-shape.html")
  const result = await page.evaluate(async () => {
    const { initializeAutomerge } = await import("/src/crdt.ts")
    await initializeAutomerge()
    const A = await import("/@id/@automerge/automerge/slim")
    const { default: wasmUrl } = await import("/@id/@automerge/automerge/automerge.wasm?url")
    await A.initializeWasm(wasmUrl)
    const { createWorkspaceDoc } = await import("/src/test/boardFixture.ts")
    const { writeLocal } = await import("/src/localDb.ts")
    const { defaultStorage } = await import("/src/storage.ts")

    const workspaceId = crypto.randomUUID()
    const initial = A.from(createWorkspaceDoc(workspaceId, "Offline fixture", "fixture-owner", "blank"))
    const changed = A.change(initial, draft => { draft.title = "Restored fixture" })
    const changeBytes = A.getLastLocalChange(changed)!
    const changeHash = A.decodeChange(changeBytes).hash
    const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")

    const local = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-local-state-v1", 1)
      request.onupgradeneeded = () => request.result.createObjectStore("kv")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const localTx = local.transaction("kv", "readwrite")
    localTx.objectStore("kv").put(JSON.stringify({
      bytesBase64: base64url(A.save(initial)), heads: A.getHeads(initial), savedAt: "fixture-time",
    }), `tincanban.snapshot.${workspaceId}`)
    localTx.objectStore("kv").put(JSON.stringify({ id: workspaceId, title: "Offline fixture", updatedAt: "fixture-time" }), `tincanban.workspace-meta.${workspaceId}`)
    await new Promise<void>((resolve, reject) => { localTx.oncomplete = () => resolve(); localTx.onabort = () => reject(localTx.error) })
    local.close()

    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tincanban-workspace-journal-v1", 1)
      request.onupgradeneeded = () => {
        const database = request.result
        for (const name of ["changes", "proofs", "receipts"]) {
          const store = database.createObjectStore(name, { keyPath: "id" })
          store.createIndex("workspaceId", "workspaceId", { unique: false })
        }
        database.createObjectStore("metadata", { keyPath: "workspaceId" })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const legacyTx = legacy.transaction(["changes", "proofs", "receipts", "metadata"], "readwrite")
    const recordId = `${workspaceId}:${changeHash}`
    legacyTx.objectStore("changes").put({ id: recordId, workspaceId, changeHash, bytes: changeBytes, addedAt: "fixture-time" })
    legacyTx.objectStore("proofs").put({ id: recordId, workspaceId, changeHash, proof: {} })
    legacyTx.objectStore("receipts").put({ id: `${workspaceId}:fixture-tx`, workspaceId, transactionId: "fixture-tx", receipt: { changeHash, transactionId: "fixture-tx" } })
    legacyTx.objectStore("metadata").put({ workspaceId, version: 1 })
    await new Promise<void>((resolve, reject) => { legacyTx.oncomplete = () => resolve(); legacyTx.onabort = () => reject(legacyTx.error) })
    legacy.close()

    const loaded = await defaultStorage.loadWorkspaceDoc(workspaceId)
    const migrated = await defaultStorage.listChanges(workspaceId)
    return {
      loaded: Boolean(loaded),
      idMatches: loaded?.doc.id === workspaceId,
      title: loaded?.doc.title,
      headsMatch: JSON.stringify(loaded?.heads) === JSON.stringify(A.getHeads(changed)),
      migratedChangeCount: migrated.length,
    }
  })

  expect(result).toMatchObject({
    loaded: true,
    idMatches: true,
    title: "Restored fixture",
    headsMatch: true,
    migratedChangeCount: 1,
  })
})
