import { afterEach, expect, it, vi } from "vitest"
import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb"
import { BrowserIdentityStore, createIdentityAuthorityView, emptyIdentityProfileState } from "@meta-uber/mesh-identity"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("Given unchanged learned authority in IndexedDB, when the captured access guard is checked repeatedly, then preserve every authority record and the local identity revision without writes", async () => {
  const values = new Map<string, string>()
  const owner = await new BrowserIdentityStore({ storageKey: "authority-storage-owner", storage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } }).bootstrap("Owner")
  const view = await createIdentityAuthorityView(owner.identity, { certificates: [owner.certificate], revocations: [] },
    emptyIdentityProfileState(owner.identity.personId))
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const storage = await import("../localDb")
  const authority = await import("../domain/identityAuthority")
  const key = authority.identityAuthorityViewKey(owner.identity.personId)
  const revisionKey = "tincanban.identity-state-revision.v1", revision = JSON.stringify({ version: 1, generation: crypto.randomUUID(), revision: 7 })
  await storage.writeLocal(key, JSON.stringify(view))
  await storage.writeLocal(revisionKey, revision)
  const beforeKeys = await storage.listLocalKeys()
  const put = vi.spyOn(IDBObjectStore.prototype, "put"), remove = vi.spyOn(IDBObjectStore.prototype, "delete"), clear = vi.spyOn(IDBObjectStore.prototype, "clear")
  const transaction = vi.spyOn(IDBDatabase.prototype, "transaction")
  const assertCurrentAuthority = await authority.resolveLearnedIdentityAccess([{ personId: owner.identity.personId, deviceId: owner.device.deviceId }])
  await assertCurrentAuthority()
  await assertCurrentAuthority()
  expect(put).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
  // Existing empty-write CAS uses a readwrite transaction, but executes no mutations.
  expect(transaction.mock.calls.some(call => call[1] === "readwrite")).toBe(true)
  expect(await storage.readLocal(key)).toBe(JSON.stringify(view))
  expect(await storage.readLocal(revisionKey)).toBe(revision)
  expect(await storage.listLocalKeys()).toEqual(beforeKeys)
})
