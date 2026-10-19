import { EventEmitter } from "node:events"
import type { Download, Locator, Page } from "@playwright/test"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { downloadPrivateWorkspaceRecovery } from "../../e2e/support/workspaceRecoveryDownload"

const sourceChanged = "Workspace changed during private recovery export; retry when changes settle"
const file = { suggestedFilename: () => "private-recovery.jsonl" } as Download
type Result = string
function fixture(results: Result[]) {
  const events = new EventEmitter(), clicks: string[] = []
  let error: string | undefined
  const page = Object.assign(events, { evaluate: vi.fn().mockResolvedValue({ personId: "person", workspaceId: "workspace" }),
    waitForEvent: vi.fn(() => new Promise<Download>(() => {})) })
  const panel = { getByRole: (role: string, options?: { name?: string }) => role === "alert"
    ? { allTextContents: async () => error ? [error] : [] }
    : { click: async () => {
      clicks.push(options?.name ?? "")
      error = undefined
      const result = results[clicks.length - 1]
      if (result === "download") setTimeout(() => events.emit("download", file), 1)
      else if (result !== "pending") error = result
    } } }
  return { page: page as unknown as Page, panel: panel as unknown as Locator, events, clicks, evaluate: page.evaluate,
    setError: (message: string) => { error = message } }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })
function clean(f: ReturnType<typeof fixture>) {
  expect(f.events.listenerCount("download")).toBe(0)
  expect(f.events.listenerCount("close")).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}
it("Given enrollment sync invalidates one full backup, when its exact error appears, then wait for queued writes and explicitly retry the complete backup", async () => {
  const f = fixture([sourceChanged, "download"])
  const result = downloadPrivateWorkspaceRecovery(f.page, f.panel)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.clicks).toEqual(["Create private recovery backup", "Retry private backup"])
  expect(await result).toBe(file)
  expect(f.evaluate).toHaveBeenCalledTimes(3)
  clean(f)
})
it("Given another backup error, when visible, then fail immediately without a retry", async () => {
  const f = fixture(["Workspace signing permission is unavailable"])
  const result = expect(downloadPrivateWorkspaceRecovery(f.page, f.panel)).rejects.toThrow("Workspace signing permission is unavailable")
  await vi.advanceTimersByTimeAsync(100)
  await result
  expect(f.clicks).toHaveLength(1)
  clean(f)
})
it("Given three consecutive source changes, when retries are exhausted, then fail explicitly instead of waiting for a nonexistent download", async () => {
  const f = fixture([sourceChanged, sourceChanged, sourceChanged])
  const result = expect(downloadPrivateWorkspaceRecovery(f.page, f.panel)).rejects.toThrow(sourceChanged)
  await vi.advanceTimersByTimeAsync(100)
  await result
  expect(f.clicks).toHaveLength(3)
  clean(f)
})
it("Given a source page closes during backup, when its listener fires, then fail and clean all observation state", async () => {
  const f = fixture(["pending"])
  const result = expect(downloadPrivateWorkspaceRecovery(f.page, f.panel)).rejects.toThrow("Backup source page closed")
  await vi.advanceTimersByTimeAsync(1)
  f.events.emit("close")
  await result
  clean(f)
})
it("Given no outcome, when the original sixty-second budget expires, then fail without extending the deadline", async () => {
  const f = fixture(["pending"])
  const result = expect(downloadPrivateWorkspaceRecovery(f.page, f.panel)).rejects.toThrow("Private workspace backup exceeded its 60-second deadline")
  await vi.advanceTimersByTimeAsync(60_000)
  await result
  expect(f.clicks).toHaveLength(1)
  clean(f)
})
it("Given the workspace binding changes before retry, when queued writes are awaited, then refuse the next capture", async () => {
  const f = fixture([sourceChanged, "download"])
  f.evaluate.mockResolvedValueOnce({ personId: "person", deviceId: "device", workspaceId: "workspace" })
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Backup identity or workspace changed"))
  await expect(downloadPrivateWorkspaceRecovery(f.page, f.panel)).rejects.toThrow("Backup identity or workspace changed")
  expect(f.clicks).toHaveLength(1)
  expect(f.evaluate).toHaveBeenCalledTimes(3)
  clean(f)
})

it("Given a late source-change rejection followed by another pending capture, when the shared deadline expires, then retries receive only the original remaining budget", async () => {
  const f = fixture(["pending", "pending"])
  setTimeout(() => f.setError(sourceChanged), 50_000)
  const result = expect(downloadPrivateWorkspaceRecovery(f.page, f.panel)).rejects.toThrow("Private workspace backup exceeded its 60-second deadline")
  await vi.advanceTimersByTimeAsync(60_000)
  await result
  expect(f.clicks).toHaveLength(2)
  clean(f)
})
