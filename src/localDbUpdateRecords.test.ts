import { IDBFactory, IDBObjectStore } from "fake-indexeddb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BrowserMeshStore, MemoryMeshStore, type MeshStore } from "@meta-uber/mesh-browser-store"

afterEach(() => vi.unstubAllGlobals())

async function createStore(mode: "memory" | "indexeddb", name = `update-records-${crypto.randomUUID()}`): Promise<MeshStore> {
  if (mode === "memory") return new MemoryMeshStore()
  vi.stubGlobal("indexedDB", new IDBFactory())
  return new BrowserMeshStore(name, ["kv"])
}

for (const mode of ["memory", "indexeddb"] as const) {
  describe(`MeshStore.updateRecords (${mode})`, () => {
    it("reads a detached snapshot and invokes a synchronous planner exactly once", async () => {
      const store = await createStore(mode)
      await store.put("kv", "one", { count: 2 })
      await store.put("kv", "two", "remove-me")
      let calls = 0
      const result = await store.updateRecords("kv", ["one", "two"], values => {
        calls += 1
        expect(values).toEqual([{ count: 2 }, "remove-me"])
        ;(values[0] as { count: number }).count = 90
        return { writes: [{ key: "one", value: { count: 3 } }, { key: "two", value: undefined }], result: "committed" }
      })

      expect(result).toBe("committed")
      expect(calls).toBe(1)
      expect(await store.get("kv", "one")).toEqual({ count: 3 })
      expect(await store.get("kv", "two")).toBeUndefined()
    })

    it("serializes concurrent increments across two connections without losing either", async () => {
      const name = `update-records-concurrent-${crypto.randomUUID()}`
      if (mode === "indexeddb") vi.stubGlobal("indexedDB", new IDBFactory())
      const left = mode === "indexeddb" ? new BrowserMeshStore(name, ["kv"]) : await createStore(mode, name)
      const right = mode === "indexeddb"
        ? new BrowserMeshStore(name, ["kv"])
        : left
      await left.put("kv", "counter", 0)
      const increment = (store: MeshStore) => store.updateRecords("kv", ["counter"], values => ({
        writes: [{ key: "counter", value: (values[0] as number) + 1 }],
        result: undefined,
      }))

      await Promise.all([increment(left), increment(right)])
      expect(await left.get("kv", "counter")).toBe(2)
    })

    it("rejects invalid plans without publishing any part of the bundle", async () => {
      const store = await createStore(mode)
      await store.put("kv", "one", "before-one")
      await store.put("kv", "two", "before-two")

      await expect(store.updateRecords("kv", ["one", "two"], () => ({
        writes: [{ key: "one", value: "after-one" }, { key: "outside", value: "forbidden" }],
        result: null,
      }))).rejects.toThrow()
      await expect(store.updateRecords("kv", ["one", "two"], () => ({
        writes: [{ key: "one", value: "after-one" }, { key: "one", value: "after-two" }],
        result: null,
      }))).rejects.toThrow()
      await expect(store.updateRecords("kv", ["one", "one"], () => ({ writes: [], result: null }))).rejects.toThrow()
      await expect(store.updateRecords("kv", ["one", "two"], () => ({
        writes: [{ key: "one", value: "after-one" }, { key: "two", value: () => "not cloneable" }],
        result: null,
      }))).rejects.toThrow()
      await expect(store.updateRecords("kv", ["one"], () => ({
        writes: [],
        result: () => "not cloneable",
      }))).rejects.toThrow()
      await expect(store.updateRecords("kv", ["one"], (async () => ({ writes: [], result: null })) as unknown as
        (values: readonly unknown[]) => { writes: readonly { key: string; value: unknown | undefined }[]; result: null }))
        .rejects.toThrow(/synchronous|update/i)
      await expect(store.updateRecords("kv", ["one", "two"], () => {
        throw new Error("guard rejected")
      })).rejects.toThrow("guard rejected")

      expect(await store.get("kv", "one")).toBe("before-one")
      expect(await store.get("kv", "two")).toBe("before-two")
    })
  })
}

it("snapshots caller-owned read keys before the IndexedDB open await", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  const store = new BrowserMeshStore(`update-records-keys-${crypto.randomUUID()}`, ["kv"])
  await store.put("kv", "one", "original")
  await store.put("kv", "two", "other")
  const keys = ["one"]
  const pending = store.updateRecords("kv", keys, values => {
    expect(values).toEqual(["original"])
    return { writes: [{ key: "one", value: "updated" }], result: null }
  })
  keys[0] = "two"
  await pending
  expect(await store.get("kv", "one")).toBe("updated")
  expect(await store.get("kv", "two")).toBe("other")
})

it("aborts the IndexedDB bundle when a later write throws after an earlier write was queued", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  const store = new BrowserMeshStore(`update-records-abort-${crypto.randomUUID()}`, ["kv"])
  await store.put("kv", "one", "before-one")
  await store.put("kv", "two", "before-two")
  const original = IDBObjectStore.prototype.put
  let calls = 0
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    calls += 1
    if (calls === 2) throw new DOMException("Injected write failure", "DataError")
    return original.call(this, value, key)
  })
  try {
    await expect(store.updateRecords("kv", ["one", "two"], () => ({
      writes: [{ key: "one", value: "after-one" }, { key: "two", value: "after-two" }],
      result: null,
    }))).rejects.toThrow()
  } finally { put.mockRestore() }
  expect(await store.get("kv", "one")).toBe("before-one")
  expect(await store.get("kv", "two")).toBe("before-two")
})
