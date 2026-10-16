import { afterEach, describe, expect, it, vi } from "vitest"
import { publicSnapshotDecision, readWithTimeout, PublicBoardRequestTimeoutError } from "./publicBoardReader"

afterEach(() => vi.useRealTimers())

describe("public board reader recovery", () => {
  it("Given a reader request that never settles, When its deadline passes, Then abort it so later refreshes can proceed", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const hanging = vi.fn(() => new Promise<never>(() => {}))
    const request = readWithTimeout(hanging, controller, 50)
    const rejection = expect(request).rejects.toBeInstanceOf(PublicBoardRequestTimeoutError)
    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(controller.signal.aborted).toBe(true)
    await expect(readWithTimeout(async () => "next", new AbortController(), 50)).resolves.toBe("next")
  })

  it("Given a successful reader response, When it settles, Then keep its request controller live until the component accepts it", async () => {
    const controller = new AbortController()
    await expect(readWithTimeout(async () => "confirmed", controller, 50)).resolves.toBe("confirmed")
    expect(controller.signal.aborted).toBe(false)
  })

  it("Given a confirmed board revision, When a response rolls back or changes board identity, Then preserve the confirmed projection", () => {
    expect(publicSnapshotDecision({ boardId: "board-a", revision: 8 }, { boardId: "board-a", revision: 7 })).toBe("rollback")
    expect(publicSnapshotDecision({ boardId: "board-a", revision: 8 }, { boardId: "board-b", revision: 9 })).toBe("different-board")
    expect(publicSnapshotDecision({ boardId: "board-a", revision: 8 }, { boardId: "board-a", revision: 8 })).toBe("unchanged")
    expect(publicSnapshotDecision({ boardId: "board-a", revision: 8 }, { boardId: "board-a", revision: 9 })).toBe("replace")
  })
})
