import { afterEach, expect, it, vi } from "vitest"
import { effectScope, ref, toRaw } from "vue"
import { IDBFactory } from "fake-indexeddb"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const { useMyDeviceRemoval } = await import("./useMyDeviceRemoval")
  const { readLocal } = await import("../localDb")
  let personId = "test-owner"
  const profile = () => ({ identity: { personId }, device: { deviceId: "current" }, certificate: { signature: "original" } })
  const calls: string[] = []
  let offline = true
  const replication = { configs: ref([{ origin: "https://online.example" }, { origin: "https://offline.example" }]), identityConfigs: ref([]), currentDeviceId: ref("current"), registeredDevices: ref([{ deviceId: "current", displayName: "Here" }, { deviceId: "old", displayName: "JoyfulPapaya" }]), revokeIdentityDevice: async (origin: string, id: string) => { calls.push(`${origin}|${id}`); if (origin.includes("offline") && offline) throw new Error("Server offline") } }
  const core = { tincanban: { getCurrentProfile: profile, ready: ref(true) }, blindReplication: replication, sync: {
    removableDeviceWorkspaces: vi.fn(async () => [{ id: "board", title: "Board" }]),
    removeDevice: async (person: string, id: string, ids: string[]) => {
      const persisted = await readLocal(`tincanban.my-device-removals.v1.${person}`)
      expect(persisted).toContain('"deviceId":"old"')
      expect(persisted).toContain("https://offline.example")
      calls.push(`${ids.join(",")}|${id}`)
    },
  } }
  const scope = effectScope()
  const controller = scope.run(() => useMyDeviceRemoval(core as never))!
  return { controller, core, calls, useMyDeviceRemoval, scope, online: () => { offline = false }, changeIdentity: () => { personId = "other-owner" } }
}

it("Given a saved device removal is changed by explicit local reset, when preferences notify, then refresh the displayed job without reloading the board", async () => {
  const f = await fixture()
  await f.controller.remove(await f.controller.prepare("old"))
  expect(f.controller.jobs.value[0]?.origins["https://offline.example"]).toBeDefined()
  const { writeLocal } = await import("../localDb")
  const { identityDevicePreferencesChanged } = await import("../sync/identityDevicePreferenceEvents")
  const job = structuredClone(toRaw(f.controller.jobs.value[0]!))
  delete job.origins["https://offline.example"]
  await writeLocal("tincanban.my-device-removals.v1.test-owner", JSON.stringify([job]))
  identityDevicePreferencesChanged("test-owner")
  await vi.waitFor(() => expect(f.controller.jobs.value[0]?.origins["https://offline.example"]).toBeUndefined())
  expect(f.controller.jobs.value[0]?.origins["https://online.example"].status).toBe("removed")
  f.scope.stop()
})

it("Given owner-shared board storage, when reviewing identity device removal, then do not request management of another owner's Rusty", async () => {
  const f = await fixture()
  f.core.blindReplication.configs.value.push({ origin: "https://shared.example", boardAccess: { mode: "read" } } as never)
  expect(f.controller.origins.value).not.toContain("https://shared.example")
  f.scope.stop()
})

it("Given a persisted exact device removal with one offline origin, when reloaded after configuration changes, then retry only original unfinished scope and retain completed records", async () => {
  const f = await fixture()
  await f.controller.remove(await f.controller.prepare("old"))
  expect(f.controller.jobs.value[0]?.origins["https://offline.example"].error).toBe("Server offline")
  f.scope.stop()
  f.core.blindReplication.configs.value.push({ origin: "https://new.example" })
  f.core.sync.removableDeviceWorkspaces.mockResolvedValue([{ id: "other-board", title: "Other" }])
  f.online()
  const scope = effectScope(), reloaded = scope.run(() => f.useMyDeviceRemoval(f.core as never))!
  await reloaded.refresh()
  await reloaded.remove(await reloaded.prepare("old"))
  expect(f.calls).toEqual(["board|old", "https://online.example|old", "https://offline.example|old", "https://offline.example|old"])
  expect(f.core.sync.removableDeviceWorkspaces).toHaveBeenCalledTimes(1)
  expect(reloaded.jobs.value[0]?.origins["https://new.example"]).toBeUndefined()
  await reloaded.remove(await reloaded.prepare("old", true))
  expect(f.calls.at(-1)).toBe("https://new.example|old")
  expect(reloaded.jobs.value[0]?.workspaces).toEqual({ board: "removed" })
  expect(f.core.blindReplication.registeredDevices.value).toHaveLength(2)
  scope.stop()
})

it("Given the current device or another identity, when requesting removal, then refuse without changing device access", async () => {
  const f = await fixture()
  await expect(f.controller.prepare("current")).rejects.toThrow("another device")
  await expect(f.controller.prepare("stranger")).rejects.toThrow("registered device")
  expect(f.calls).toEqual([])
  f.core.sync.removableDeviceWorkspaces.mockImplementation(async () => { f.changeIdentity(); return [{ id: "board", title: "Board" }] })
  await expect(f.controller.prepare("old")).rejects.toThrow("Identity changed")
  expect(f.calls).toEqual([])
  f.scope.stop()
})

it("Given exact scopes were reviewed, when another server is configured behind the confirmation, then execution keeps the reviewed snapshot", async () => {
  const f = await fixture()
  const prepared = await f.controller.prepare("old")
  expect(f.calls).toEqual([])
  expect(prepared.job.workspaceTitles).toEqual({ board: "Board" })
  f.core.blindReplication.configs.value.push({ origin: "https://late.example" })
  await f.controller.remove(prepared)
  expect(f.calls).not.toContain("https://late.example|old")
  expect(f.controller.jobs.value[0]?.origins["https://late.example"]).toBeUndefined()
  f.scope.stop()
})

it("Given a failed server removal and a fresh working connection, when explicitly stopping that server attempt, then archive its exact evidence without revocation or credential changes", async () => {
  const f = await fixture()
  const local = await import("../localDb")
  await f.controller.remove(await f.controller.prepare("old"))
  const prepared = await f.controller.prepare("old")
  const before = await local.readLocal("tincanban.my-device-removals.v1.test-owner")
  const connections = JSON.stringify(f.core.blindReplication.configs.value)
  const calls = [...f.calls]
  await f.controller.abandonOrigin(prepared, "https://offline.example")
  expect(f.controller.jobs.value[0]?.origins).toEqual({ "https://online.example": { status: "removed" } })
  expect(f.controller.jobs.value[0]?.abandonedOrigins).toEqual(["https://offline.example"])
  expect(f.controller.jobs.value[0]?.workspaces).toEqual({ board: "removed" })
  expect(JSON.stringify(f.core.blindReplication.configs.value)).toBe(connections)
  expect(f.calls).toEqual(calls)
  const archiveKeys = (await local.listLocalKeys()).filter(key => key.startsWith("tincanban.device-removal-abandonment.v1."))
  expect(archiveKeys).toHaveLength(1)
  expect(JSON.parse((await local.readLocal(archiveKeys[0]!))!)).toMatchObject({ personId: "test-owner", deviceId: "old", origin: "https://offline.example", previous: before })
  await expect(f.controller.remove(prepared)).rejects.toThrow(/changed|review/i)
  await f.controller.remove(await f.controller.prepare("old"))
  expect(f.calls).toEqual(calls)
  f.online()
  await f.controller.remove(await f.controller.prepare("old", true))
  expect(f.calls).toEqual([...calls, "https://offline.example|old"])
  expect(f.controller.jobs.value[0]?.abandonedOrigins).toEqual([])
  f.scope.stop()
})

it("Given a reviewed failed removal, when its saved job or signing identity changes, then reject abandonment without erasing the new attempt or writing an archive", async () => {
  const f = await fixture()
  const local = await import("../localDb")
  await f.controller.remove(await f.controller.prepare("old"))
  const prepared = await f.controller.prepare("old")
  const job = structuredClone(prepared.job)
  job.origins["https://offline.example"] = { status: "pending", error: "A newer attempt" }
  const changed = JSON.stringify([job])
  await local.writeLocal("tincanban.my-device-removals.v1.test-owner", changed)
  await expect(f.controller.abandonOrigin(prepared, "https://offline.example")).rejects.toThrow(/changed|review/i)
  expect(await local.readLocal("tincanban.my-device-removals.v1.test-owner")).toBe(changed)
  f.changeIdentity()
  await expect(f.controller.abandonOrigin(prepared, "https://offline.example")).rejects.toThrow(/identity changed/i)
  expect((await local.listLocalKeys()).filter(key => key.startsWith("tincanban.device-removal-abandonment.v1."))).toEqual([])
  f.scope.stop()
})
