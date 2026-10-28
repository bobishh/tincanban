import { IDBFactory, forceCloseDatabase } from "fake-indexeddb"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it("Given a committed workspace snapshot, when the browser unexpectedly closes its journal connection, then reopen the existing journal and preserve subsequent writes", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  const { openWorkspaceJournal, readWorkspaceBasisSnapshot, requestResult, transactionDone } = await import("./storageJournal")
  const database = await openWorkspaceJournal()
  const row = { id: "retained-board", workspaceId: "retained-board", bytes: Uint8Array.of(1, 2, 3),
    title: "Retained", savedAt: "2026-10-28T20:00:00.000Z" }
  const write = database.transaction("snapshots", "readwrite"), committed = transactionDone(write)
  write.objectStore("snapshots").put(row)
  await committed
  const closed = new Promise<void>(resolve => database.addEventListener("close", () => resolve(), { once: true }))
  // @ts-expect-error fake-indexeddb 6.2.5 declares a constructor; its helper closes an instance.
  forceCloseDatabase(database)
  await closed
  expect(await readWorkspaceBasisSnapshot(row.id)).toEqual(row)
  const reopened = await openWorkspaceJournal()
  expect(reopened).not.toBe(database)
  const update = reopened.transaction("snapshots", "readwrite"), updated = transactionDone(update)
  await requestResult(update.objectStore("snapshots").put({ ...row, title: "Still writable" }))
  await updated
  expect(await readWorkspaceBasisSnapshot(row.id)).toEqual({ ...row, title: "Still writable" })
  reopened.close()
})

it("Given another tab blocks a journal upgrade, when the user retries before that tab closes, then keep reporting the refusal and reopen saved data once the blocker closes", async () => {
  const factory = new IDBFactory()
  vi.stubGlobal("indexedDB", factory)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("tincanban-workspace-state", 6)
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const row = { id: "retained-before-upgrade", workspaceId: "retained-before-upgrade", bytes: Uint8Array.of(4, 5), title: "Retained" }
  const write = database.transaction("snapshots", "readwrite")
  const committed = new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve()
    write.onabort = () => reject(write.error)
  })
  write.objectStore("snapshots").put(row)
  await committed
  const { openWorkspaceJournal, readWorkspaceBasisSnapshot } = await import("./storageJournal")
  await expect(openWorkspaceJournal()).rejects.toMatchObject({ name: "WorkspaceJournalUpgradeBlockedError" })
  let repeatedFailure: unknown
  const retry = openWorkspaceJournal().catch(error => { repeatedFailure = error })
  try {
    await vi.waitFor(() => expect(repeatedFailure).toMatchObject({ name: "WorkspaceJournalUpgradeBlockedError" }), { timeout: 500 })
  } finally {
    database.close()
    await retry
  }
  await vi.waitFor(async () => expect(await readWorkspaceBasisSnapshot(row.id)).toEqual(row))
  ;(await openWorkspaceJournal()).close()
})
