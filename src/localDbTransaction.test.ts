import { IDBDatabase, IDBFactory } from "fake-indexeddb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BrowserMeshStore, MemoryMeshStore } from "@meta-uber/mesh-browser-store"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe.each(["memory", "indexeddb"] as const)("atomic device activation in %s", mode => {
  function createStore() {
    if (mode === "memory") return new MemoryMeshStore()
    vi.stubGlobal("indexedDB", new IDBFactory())
    return new BrowserMeshStore(`activation-${crypto.randomUUID()}`, ["kv"])
  }

  it("Given validated state becomes stale during signature verification, when committing all components, then publish none", async () => {
    const store = createStore()
    await store.put("kv", "connections", "old")
    await store.put("kv", "connections", "concurrent")
    expect(await store.compareAndSwap([{ store: "kv", key: "connections", expected: "old" }], [
      { type: "put", store: "kv", key: "connections", value: "incoming" },
      { type: "put", store: "kv", key: "capabilities", value: "incoming" },
    ])).toBe(false)
    expect(await store.get("kv", "connections")).toBe("concurrent")
    expect(await store.get("kv", "capabilities")).toBeUndefined()
  })

  it("Given two tabs activate the same absent generation, when racing, then exactly one publishes its complete bundle", async () => {
    const store = createStore()
    const results = await Promise.all(["left", "right"].map(value => store.compareAndSwap([
      { store: "kv", key: "generation", expected: undefined },
    ], ["generation", "catalog", "connections", "capabilities"].map(key => ({ type: "put" as const, store: "kv", key, value })))))
    expect(results.filter(Boolean)).toHaveLength(1)
    const records = await store.list<string>("kv")
    expect(records).toHaveLength(4)
    expect(new Set(records.map(record => record.value)).size).toBe(1)
  })

  it("Given identity changed before publication, when the live guard rejects, then abort every write", async () => {
    const store = createStore()
    await store.put("kv", "catalog", "before")
    await expect(store.compareAndSwap([{ store: "kv", key: "catalog", expected: "before" }], [
      { type: "put", store: "kv", key: "catalog", value: "after" },
      { type: "put", store: "kv", key: "connections", value: "after" },
    ], () => { throw new Error("identity changed") })).rejects.toThrow("identity changed")
    expect(await store.list("kv")).toEqual([{ key: "catalog", value: "before" }])
  })

  it("Given one write cannot be cloned, when committing, then retain every old component", async () => {
    const store = createStore()
    await store.put("kv", "catalog", "before")
    await expect(store.compareAndSwap([{ store: "kv", key: "catalog", expected: "before" }], [
      { type: "put", store: "kv", key: "catalog", value: "after" },
      { type: "put", store: "kv", key: "connections", value: () => undefined },
    ])).rejects.toThrow()
    expect(await store.list("kv")).toEqual([{ key: "catalog", value: "before" }])
  })
})

it("Given independent IndexedDB connections capture the same generation, when committing, then only one complete bundle survives reopen", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  const name = `two-tabs-${crypto.randomUUID()}`
  const left = new BrowserMeshStore(name, ["kv"])
  const right = new BrowserMeshStore(name, ["kv"])
  await Promise.all([left.get("kv", "generation"), right.get("kv", "generation")])
  const results = await Promise.all([left, right].map((store, index) => store.compareAndSwap([
    { store: "kv", key: "generation", expected: undefined },
  ], ["generation", "catalog", "connections"].map(key => ({ type: "put" as const, store: "kv", key, value: String(index) })))))
  expect(results.filter(Boolean)).toHaveLength(1)
  const reopened = new BrowserMeshStore(name, ["kv"])
  expect(new Set((await reopened.list<string>("kv")).map(record => record.value)).size).toBe(1)
})

it("Given a storage write fails after the first request is queued, when transaction aborts, then reopen every previous component", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  const name = `abort-${crypto.randomUUID()}`
  const store = new BrowserMeshStore(name, ["kv"])
  await store.put("kv", "catalog", "before")
  const transaction = IDBDatabase.prototype.transaction
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(function (this: IDBDatabase, ...args) {
    const pending = transaction.apply(this, args)
    const values = pending.objectStore("kv")
    const put = values.put.bind(values)
    vi.spyOn(values, "put").mockImplementation((value, key) => {
      if (key === "connections") throw new DOMException("quota reached", "QuotaExceededError")
      return put(value, key)
    })
    return pending
  })
  await expect(store.compareAndSwap([{ store: "kv", key: "catalog", expected: "before" }], [
    { type: "put", store: "kv", key: "catalog", value: "after" },
    { type: "put", store: "kv", key: "connections", value: "after" },
  ])).rejects.toThrow("quota reached")
  expect(await new BrowserMeshStore(name, ["kv"]).list("kv")).toEqual([{ key: "catalog", value: "before" }])
})
