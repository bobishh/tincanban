import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ChatStore, type StoredChatMessage, type StoredChatProfile } from "./store"

const workspaceId = "workspace-profile-observation"

function message(id: string): StoredChatMessage {
  return { id, workspaceId, personId: "person-message", createdAt: "2026-10-01T00:00:00.000Z", body: "historical message", record: { id } }
}

function profile(personId: string, revision: number, name: string): StoredChatProfile {
  return { workspaceId, personId, revision, name, record: { signed: { payload: { personId, revision, name } } } }
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})
afterEach(() => vi.unstubAllGlobals())

it("Given historical messages and multiple signed profile observations, when profiles load alone, then it reads only the profile index and returns detached latest records", async () => {
  const store = new ChatStore("profiles-only")
  await store.append(message("old-1"))
  await store.append(message("old-2"))
  await store.putProfile(profile("person-own", 1, "Old name"))
  await store.putProfile(profile("person-own", 2, "Latest name"))
  await store.putProfile(profile("person-other", 1, "Other person"))
  const txSpy = vi.spyOn(store as unknown as { runTx: (...args: unknown[]) => Promise<unknown> }, "runTx")

  const profiles = await store.loadProfiles(workspaceId)

  expect(txSpy).toHaveBeenCalledTimes(1)
  expect(txSpy.mock.calls[0]?.[0]).toEqual(["profiles"])
  expect(txSpy.mock.calls[0]?.[1]).toBe("readonly")
  expect(profiles).toEqual(expect.arrayContaining([
    profile("person-own", 2, "Latest name"),
    profile("person-other", 1, "Other person"),
  ]))
  expect(profiles).toHaveLength(2)
  ;(profiles[0]!.record as { signed: { payload: { name: string } } }).signed.payload.name = "mutated result"
  expect(await store.loadProfiles(workspaceId)).toEqual(expect.arrayContaining([
    profile("person-own", 2, "Latest name"),
    profile("person-other", 1, "Other person"),
  ]))
})
