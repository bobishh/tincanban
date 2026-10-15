import { afterEach, expect, it, vi } from "vitest"
import * as localDb from "./localDb"
import { PersonalRootMapStore, planPersonalRootUpdate } from "./storagePersonalRoot"
import type { PersonalRootDocumentV1 } from "./domain/model"

const mapKey = "tincanban.v1.personal_roots"

function root(rootId: string, personId: string, displayNamePreset?: string): PersonalRootDocumentV1 {
  return {
    kind: "personal-root", formatVersion: 1, rootId,
    identity: { personId, publicKey: `key-${personId}`, displayName: personId },
    devices: {}, workspaces: {},
    ...(displayNamePreset ? { displayNamePreset } : {}),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await localDb.deleteLocal(mapKey)
})

it("Given a personal-root update, when a plan is requested, then return exact CAS evidence without writing or publishing cache", async () => {
  const original = root("root-a", "person-a")
  const raw = JSON.stringify({ "root-a": original })
  await localDb.writeLocal(mapKey, raw)
  const cache = new Map<string, PersonalRootDocumentV1>()
  const store = new PersonalRootMapStore(cache, () => {})

  const plan = await store.planUpdate("person-a", current => ({ ...current!, displayNamePreset: "New label" }))

  expect(plan.conditions).toEqual([{ key: mapKey, value: raw }])
  expect(JSON.parse(plan.writes[0]!.value!)["root-a"].displayNamePreset).toBe("New label")
  expect(await localDb.readLocal(mapKey)).toBe(raw)
  expect(cache.size).toBe(0)
})

it("Given an async personal-root updater, when planning then committing its CAS plan, then publish its result only if captured bytes still match", async () => {
  const original = root("root-a", "person-a")
  const raw = JSON.stringify({ "root-a": original })
  await localDb.writeLocal(mapKey, raw)
  const cache = new Map<string, PersonalRootDocumentV1>()
  const store = new PersonalRootMapStore(cache, () => {})

  const plan = await store.planUpdate("person-a", async current => {
    await Promise.resolve()
    return { ...current!, displayNamePreset: "Async label" }
  })

  expect(plan.conditions).toEqual([{ key: mapKey, value: raw }])
  expect(JSON.parse(plan.writes[0]!.value!)["root-a"].displayNamePreset).toBe("Async label")
  expect(await localDb.readLocal(mapKey)).toBe(raw)
  expect(cache.size).toBe(0)
  expect(await localDb.compareAndSwapLocal(plan)).toBe(true)
  expect(JSON.parse((await localDb.readLocal(mapKey))!)["root-a"].displayNamePreset).toBe("Async label")
})

it("Given an async root updater yields while another tab edits the map, when its plan is committed, then CAS rejects it and preserves the other edit", async () => {
  const original = { "root-a": root("root-a", "person-a") }
  const raw = JSON.stringify(original)
  await localDb.writeLocal(mapKey, raw)
  let entered!: () => void
  let release!: () => void
  const updaterEntered = new Promise<void>(resolve => { entered = resolve })
  const updaterPaused = new Promise<void>(resolve => { release = resolve })
  const store = new PersonalRootMapStore(new Map(), () => {})

  const planning = store.planUpdate("person-a", async current => {
    entered()
    await updaterPaused
    return { ...current!, displayNamePreset: "Stale planned edit" }
  })
  await updaterEntered
  await localDb.writeLocal(mapKey, JSON.stringify({ "root-a": { ...original["root-a"], displayNamePreset: "Other tab edit" } }))
  release()
  const plan = await planning

  expect(plan.conditions).toEqual([{ key: mapKey, value: raw }])
  expect(await localDb.compareAndSwapLocal(plan)).toBe(false)
  expect(JSON.parse((await localDb.readLocal(mapKey))!)["root-a"].displayNamePreset).toBe("Other tab edit")
})

it("Given an async root updater rejects, when planning fails, then preserve durable bytes and cached state", async () => {
  const persisted = root("root-a", "person-a", "Persisted")
  const cached = root("root-a", "person-a", "Cached")
  const raw = JSON.stringify({ "root-a": persisted })
  await localDb.writeLocal(mapKey, raw)
  const cache = new Map([["root-a", cached]])
  const store = new PersonalRootMapStore(cache, () => {})

  await expect(store.planUpdate("person-a", async () => {
    await Promise.resolve()
    throw new Error("updater failed")
  })).rejects.toThrow("updater failed")

  expect(await localDb.readLocal(mapKey)).toBe(raw)
  expect(cache.get("root-a")).toEqual(cached)
})

it("Given a concurrent map write, when an identity root update retries its CAS, then preserve the concurrent identity", async () => {
  const originalMap = { "root-a": root("root-a", "person-a"), "root-b": root("root-b", "person-b") }
  await localDb.writeLocal(mapKey, JSON.stringify(originalMap))
  const compareAndSwap = localDb.compareAndSwapLocal.bind(localDb)
  let injectConflict = true
  vi.spyOn(localDb, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
    if (injectConflict) {
      injectConflict = false
      await localDb.writeLocal(mapKey, JSON.stringify({ ...originalMap, "root-c": root("root-c", "person-c") }))
      return false
    }
    return compareAndSwap(plan, ensureCurrent)
  })
  const store = new PersonalRootMapStore(new Map(), () => {})

  await store.update("person-a", current => ({ ...current!, displayNamePreset: "Edited" }))

  const final = JSON.parse((await localDb.readLocal(mapKey))!) as Record<string, PersonalRootDocumentV1>
  expect(final["root-a"]?.displayNamePreset).toBe("Edited")
  expect(final["root-b"]?.identity.personId).toBe("person-b")
  expect(final["root-c"]?.identity.personId).toBe("person-c")
})

it("Given a submitted root and a competing save, when CAS retries, then retain both roots without aliasing caller input", async () => {
  const existing = root("root-a", "person-a")
  await localDb.writeLocal(mapKey, JSON.stringify({ "root-a": existing }))
  const submitted = root("root-b", "person-b")
  const compareAndSwap = localDb.compareAndSwapLocal.bind(localDb)
  let injectConflict = true
  vi.spyOn(localDb, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
    if (injectConflict) {
      injectConflict = false
      await localDb.writeLocal(mapKey, JSON.stringify({ "root-a": existing, "root-c": root("root-c", "person-c") }))
      return false
    }
    return compareAndSwap(plan, ensureCurrent)
  })
  const store = new PersonalRootMapStore(new Map(), () => {})

  await store.save(submitted)
  submitted.displayNamePreset = "Changed after save"

  const final = JSON.parse((await localDb.readLocal(mapKey))!) as Record<string, PersonalRootDocumentV1>
  expect(Object.keys(final).sort()).toEqual(["root-a", "root-b", "root-c"])
  expect(final["root-b"]?.displayNamePreset).toBeUndefined()
})

it("Given an updater that changes root identity, when planned or applied, then reject without partial writes", async () => {
  const original = root("root-a", "person-a")
  const raw = JSON.stringify({ "root-a": original })
  await localDb.writeLocal(mapKey, raw)
  const invalidUpdate = (current: PersonalRootDocumentV1 | null) => ({
    ...current!, identity: { ...current!.identity, personId: "person-b" },
  })

  await expect(planPersonalRootUpdate("person-a", invalidUpdate)).rejects.toThrow(/identity changed/i)
  await expect(new PersonalRootMapStore(new Map(), () => {}).update("person-a", invalidUpdate)).rejects.toThrow(/identity changed/i)
  expect(await localDb.readLocal(mapKey)).toBe(raw)
})
