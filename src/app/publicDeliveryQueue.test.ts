import { afterEach, describe, expect, it, vi } from "vitest"
import { createPublicDeliveryQueue } from "./publicDeliveryQueue"

describe("public delivery workspace queue", () => {
  afterEach(() => vi.useRealTimers())

  it("coalesces repeated changes for one workspace and drains the latest again after an in-flight pass", async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const processWorkspace = vi.fn(async (workspaceId: string) => {
      void workspaceId
      await new Promise<void>(resolve => { finish = resolve })
    })
    const queue = createPublicDeliveryQueue(processWorkspace, 10)

    queue.enqueue("workspace-a")
    queue.enqueue("workspace-a")
    await vi.advanceTimersByTimeAsync(10)
    expect(processWorkspace).toHaveBeenCalledTimes(1)

    queue.enqueue("workspace-a")
    queue.enqueue("workspace-b")
    finish()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(processWorkspace.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(["workspace-a", "workspace-a", "workspace-b"])
    queue.stop()
  })

  it("does not scan or drain unrelated workspaces after a scoped notification", async () => {
    vi.useFakeTimers()
    const processWorkspace = vi.fn(async (workspaceId: string) => { void workspaceId })
    const queue = createPublicDeliveryQueue(processWorkspace, 1)
    queue.enqueue("workspace-a")
    await vi.advanceTimersByTimeAsync(1)
    expect(processWorkspace).toHaveBeenCalledTimes(1)
    expect(processWorkspace).toHaveBeenCalledWith("workspace-a")
    queue.stop()
  })
})
