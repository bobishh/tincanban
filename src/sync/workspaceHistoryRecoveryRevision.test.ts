import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type * as StorageJournal from "../storageJournal"
import { createWorkspaceHistoryRecoveryEvidence } from "./workspaceHistoryRecoveryEvidence"

const openJournal = vi.hoisted(() => vi.fn())
vi.mock("../storageJournal", async original => ({ ...await original<typeof StorageJournal>(), openWorkspaceJournal: openJournal }))

type Outcome = "success" | "request-stall" | "completion-stall" | "request-error" | "abort"
class RevisionTransaction {
  oncomplete: (() => void) | null = null
  onabort: (() => void) | null = null
  onerror: (() => void) | null = null
  error: DOMException | null = null
  readonly request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
    result: undefined as unknown, error: null as DOMException | null }
  readonly abort = vi.fn(() => { this.onabort?.() })
  constructor(readonly outcome: Outcome, readonly revision: string | null = "original") {}
  objectStore(name: string) {
    expect(name).toBe("revisions")
    return { get: (workspaceId: string) => {
      expect(workspaceId).toBe("workspace")
      void Promise.resolve().then(() => {
        if (this.outcome === "request-stall") return
        if (this.outcome === "request-error") {
          this.request.error = new DOMException("Storage read failed", "UnknownError")
          this.request.onerror?.()
        } else if (this.outcome === "abort") {
          this.error = new DOMException("Storage transaction aborted", "AbortError")
          this.onabort?.()
        } else {
          this.request.result = this.revision === null ? undefined : { revision: this.revision }
          this.request.onsuccess?.()
          if (this.outcome === "success") this.oncomplete?.()
        }
      })
      return this.request
    } }
  }
}
function fixture(...outcomes: Array<[Outcome, (string | null)?]>) {
  const transactions: RevisionTransaction[] = []
  const database = { transaction: vi.fn((store: string, mode: string) => {
    expect(store).toBe("revisions"); expect(mode).toBe("readonly")
    const next = outcomes[transactions.length]
    if (!next) throw new Error("Unexpected revision read")
    const transaction = new RevisionTransaction(...next)
    transactions.push(transaction)
    return transaction
  }) }
  openJournal.mockResolvedValue(database)
  return { database, transactions }
}
beforeEach(() => { vi.useFakeTimers(); openJournal.mockReset() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each(["request-stall", "completion-stall"] as const)("Given its own readonly %s, when the backup guard waits five seconds, then abort only that attempt and verify a fresh exact revision", async outcome => {
  const f = fixture(["success"], [outcome], ["success"])
  const capture = await createWorkspaceHistoryRecoveryEvidence("workspace", () => {})
  const guard = capture.assertUnchanged()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.database.transaction).toHaveBeenCalledTimes(3)
  await guard
  expect(f.transactions[1]!.abort).toHaveBeenCalledTimes(1)
  expect(f.transactions[0]!.abort).not.toHaveBeenCalled()
  expect(f.transactions[2]!.abort).not.toHaveBeenCalled()
  for (const transaction of f.transactions) {
    expect(transaction.oncomplete).toBeNull()
    expect(transaction.onabort).toBeNull()
    expect(transaction.onerror).toBeNull()
    expect(transaction.request.onsuccess).toBeNull()
    expect(transaction.request.onerror).toBeNull()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["changed", null])("Given a stalled read followed by revision %s, when fresh storage responds, then reject changed or missing source evidence", async revision => {
  fixture(["success"], ["request-stall"], ["success", revision])
  const capture = await createWorkspaceHistoryRecoveryEvidence("workspace", () => {})
  const rejected = expect(capture.assertUnchanged()).rejects.toThrow("Workspace changed during private recovery export")
  await vi.advanceTimersByTimeAsync(5_000)
  await rejected
})

it.each(["request-error", "abort"] as const)("Given a readonly %s, when storage reports failure, then preserve the error and refuse export without retrying", async outcome => {
  const f = fixture(["success"], [outcome])
  const capture = await createWorkspaceHistoryRecoveryEvidence("workspace", () => {})
  await expect(capture.assertUnchanged()).rejects.toThrow(/Storage/)
  expect(f.transactions).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(0)
})

it("Given every readonly attempt stalls, when the finite recovery budget expires, then stop with a storage error and no completion claim", async () => {
  const f = fixture(["success"], ["request-stall"], ["completion-stall"], ["request-stall"])
  const capture = await createWorkspaceHistoryRecoveryEvidence("workspace", () => {})
  const rejected = expect(capture.assertUnchanged()).rejects.toThrow("Workspace storage did not respond. Retry the private backup.")
  await vi.advanceTimersByTimeAsync(15_000)
  await rejected
  expect(f.transactions).toHaveLength(4)
  expect(f.transactions.slice(1).every(transaction => transaction.abort.mock.calls.length === 1)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("Given identity changes during a stalled read, when its attempt is aborted, then reject before opening another transaction", async () => {
  const f = fixture(["success"], ["request-stall"])
  let current = true
  const capture = await createWorkspaceHistoryRecoveryEvidence("workspace", () => { if (!current) throw new Error("Identity changed") })
  const rejected = expect(capture.assertUnchanged()).rejects.toThrow("Identity changed")
  await vi.advanceTimersByTimeAsync(1_000)
  current = false
  await vi.advanceTimersByTimeAsync(4_000)
  await rejected
  expect(f.transactions).toHaveLength(2)
})

it("Given an aborted attempt has queued late callbacks, when a fresh revision succeeds, then those old callbacks cannot replace or reject the result", async () => {
  const f = fixture(["success"], ["request-stall"], ["success"])
  const capture = await createWorkspaceHistoryRecoveryEvidence("workspace", () => {})
  const guard = capture.assertUnchanged()
  await vi.advanceTimersByTimeAsync(0)
  const abandoned = f.transactions[1]!, success = abandoned.request.onsuccess!, complete = abandoned.oncomplete!
  await vi.advanceTimersByTimeAsync(5_000)
  await guard
  abandoned.request.result = { revision: "late untrusted revision" }
  success(); complete()
  await guard
  expect(f.transactions).toHaveLength(3)
  expect(vi.getTimerCount()).toBe(0)
})
