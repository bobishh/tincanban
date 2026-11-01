import { beforeEach, expect, it, vi } from "vitest"
import { readPendingWorkspaceDeparture, savePendingWorkspaceDeparture, listPendingWorkspaceDepartures, updatePendingWorkspaceDeparture, assertWorkspaceNotDeparting, completeWorkspaceDeparture } from "./storageWorkspaceDeparture"
import { deleteLocal, listLocalKeys } from "./localDb"
import * as localDb from "./localDb"

beforeEach(async () => {
  vi.restoreAllMocks()
  for (const key of await listLocalKeys()) if (key.startsWith("tincanban.workspace-departure.v1.")) await deleteLocal(key)
  await deleteLocal("tincanban.workspace-departure-index.v1")
})

it("Given an offline leave intent, when delivery resumes after reload, then retain the same signed departure and removal request until delivery completes", async () => {
  const departure = { record: { payload: { personId: "person", workspaceId: "board", accessEpoch: 1 }, signature: "signature" } } as never
  await savePendingWorkspaceDeparture({ workspaceId: "board", personId: "person", departure, snapshot: "frozen-snapshot", delivered: false, removeCopy: false })
  expect(await readPendingWorkspaceDeparture("board", "person")).toMatchObject({ departure, delivered: false })
  await expect(completeWorkspaceDeparture("board", "person")).rejects.toThrow("not confirmed")
  await expect(assertWorkspaceNotDeparting("board", "person")).rejects.toThrow("queued for delivery")
  await expect(assertWorkspaceNotDeparting("board", "other-person")).resolves.toBeUndefined()
  await updatePendingWorkspaceDeparture("board", "person", { delivered: true, removeCopy: true })
  expect(await readPendingWorkspaceDeparture("board", "person")).toMatchObject({ departure, delivered: true, removeCopy: true })
  await completeWorkspaceDeparture("board", "person")
  expect(await readPendingWorkspaceDeparture("board", "person")).toBeNull()
})


it("Given two identities leave the same board, when one delivery completes, then retain the other identity's exact pending work without enumerating unrelated data", async () => {
  vi.spyOn(localDb, "listLocalKeys").mockRejectedValue(new Error("Unexpected full-store enumeration"))
  const first = { workspaceId: "board", personId: "first", departure: {} as never, snapshot: "first-snapshot", delivered: false, removeCopy: true }
  const second = { ...first, personId: "second", snapshot: "second-snapshot" }
  await Promise.all([savePendingWorkspaceDeparture(first), savePendingWorkspaceDeparture(second)])
  expect(await readPendingWorkspaceDeparture("board", "first")).toEqual(first)
  expect(await readPendingWorkspaceDeparture("board", "second")).toEqual(second)
  expect(await listPendingWorkspaceDepartures()).toHaveLength(2)
  await updatePendingWorkspaceDeparture("board", "first", { delivered: true })
  await completeWorkspaceDeparture("board", "first")
  expect(await listPendingWorkspaceDepartures()).toEqual([{ workspaceId: "board", personId: "second", delivered: false }])
  expect(await readPendingWorkspaceDeparture("board", "second")).toEqual(second)
})

it("Given storage fails at the atomic departure commit, when retrying after reload, then never lose the discovery index or leave an orphaned hidden snapshot", async () => {
  const entry = { workspaceId: "board", personId: "person", departure: {} as never, snapshot: "frozen", delivered: false, removeCopy: true }
  const commit = vi.spyOn(localDb, "compareAndSwapLocal").mockRejectedValueOnce(new Error("Storage unavailable"))
  await expect(savePendingWorkspaceDeparture(entry)).rejects.toThrow("Storage unavailable")
  expect(await readPendingWorkspaceDeparture("board", "person")).toBeNull()
  expect(await listPendingWorkspaceDepartures()).toEqual([])
  await savePendingWorkspaceDeparture(entry)
  await updatePendingWorkspaceDeparture("board", "person", { delivered: true })
  commit.mockRejectedValueOnce(new Error("Storage unavailable"))
  await expect(completeWorkspaceDeparture("board", "person")).rejects.toThrow("Storage unavailable")
  expect(await listPendingWorkspaceDepartures()).toEqual([{ workspaceId: "board", personId: "person", delivered: true }])
  expect((await readPendingWorkspaceDeparture("board", "person"))?.snapshot).toBe("frozen")
  await completeWorkspaceDeparture("board", "person")
  expect(await listPendingWorkspaceDepartures()).toEqual([])
})
