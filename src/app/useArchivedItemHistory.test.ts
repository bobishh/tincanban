import { effectScope, reactive, ref } from "vue"
import { beforeEach, expect, it, vi } from "vitest"
import { useArchivedItemHistory } from "./useArchivedItemHistory"

const ports = vi.hoisted(() => ({ create: vi.fn(), load: vi.fn(), read: vi.fn(), dispose: vi.fn() }))
vi.mock("./workspaceArchivedHistory", () => ({ createWorkspaceArchivedHistorySession: ports.create }))

beforeEach(() => {
  vi.resetAllMocks()
  ports.create.mockResolvedValue({ loadNext: ports.load, readVersion: ports.read, dispose: ports.dispose })
})
function fixture() {
  const selectedItemId = ref<string | null>("item"), activeWorkspace = reactive({ id: "board" }), scope = effectScope()
  const history = scope.run(() => useArchivedItemHistory({ tincanban: { activeWorkspace } as never, selectedItemId }))!
  return { history, selectedItemId, scope }
}

it("Given a selected item, when rendering it, then no archive is opened until explicitly requested", async () => {
  const f = fixture()
  expect(ports.create).not.toHaveBeenCalled()
  ports.load.mockResolvedValue({ entries: [], hasMore: false })
  await f.history.loadEarlierItemHistory()
  expect(ports.create).toHaveBeenCalledOnce()
  expect(f.history.archivedHistoryNotice.value).toBe("No earlier archived versions")
  f.scope.stop()
})

it("Given a missing archive part, when a read fails then retries, then keep current selection and expose the retry result", async () => {
  const f = fixture()
  ports.load.mockRejectedValueOnce(new Error("Archive part unavailable"))
  await f.history.loadEarlierItemHistory()
  expect(f.history.archivedHistoryError.value).toBe("Archive part unavailable")
  expect(f.selectedItemId.value).toBe("item")
  ports.load.mockResolvedValueOnce({ entries: [{ hash: "original" }], hasMore: false })
  await f.history.loadEarlierItemHistory()
  expect(f.history.archivedHistoryError.value).toBe("")
  expect(f.history.archivedItemHistory.value).toEqual([{ hash: "original" }])
  f.scope.stop()
})

it("Given a pending history read, when selection changes, then discard its late page and release the old session", async () => {
  const f = fixture()
  let complete!: (page: unknown) => void
  ports.load.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const pending = f.history.loadEarlierItemHistory()
  await vi.waitUntil(() => ports.load.mock.calls.length === 1)
  f.selectedItemId.value = "other-item"
  complete({ entries: [{ hash: "old-selection" }], hasMore: false })
  await pending
  expect(f.history.archivedItemHistory.value).toEqual([])
  expect(f.history.archivedHistoryLoading.value).toBe(false)
  expect(ports.dispose).toHaveBeenCalledOnce()
  f.scope.stop()
})

it("Given a job-search lead, when earlier history is requested then selection changes, then read that lead and discard its stale page", async () => {
  const selectedItemId = ref<string | null>(null), selectedLeadId = ref<string | null>("lead")
  const scope = effectScope()
  const history = scope.run(() => useArchivedItemHistory({ tincanban: { activeWorkspace: reactive({ id: "board" }) } as never, selectedItemId, selectedLeadId }))!
  let complete!: (page: unknown) => void
  ports.load.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const pending = history.loadEarlierItemHistory()
  await vi.waitUntil(() => ports.create.mock.calls.length === 1)
  expect(ports.create.mock.calls[0]?.[2]).toBe("lead")
  selectedLeadId.value = "other-lead"
  complete({ entries: [{ hash: "stale-lead" }], hasMore: false })
  await pending
  expect(history.archivedItemHistory.value).toEqual([])
  expect(ports.dispose).toHaveBeenCalledOnce()
  scope.stop()
})
