import { describe, expect, it } from "vitest"
import { createDeviceSyncState } from "./deviceSyncState"
import { createDeviceSyncJoinApproval } from "./deviceSyncJoinApproval"

describe("owner-connection join decisions", () => {
  it("binds opt-in to one pending request even when same identity has concurrent requests", async () => {
    const state = createDeviceSyncState()
    const approvals = createDeviceSyncJoinApproval(state)
    const first = approvals.waitForJoinDecision("keeper", "Keeper", true)
    const second = approvals.waitForJoinDecision("keeper", "Keeper", true)
    const [firstRequest, secondRequest] = state.pendingJoins.value
    firstRequest!.role = "visitor"
    firstRequest!.followOwner = true
    secondRequest!.role = "editor"
    approvals.decideJoin(firstRequest!.id, true)

    await expect(first).resolves.toEqual({ role: "visitor", followOwner: true })
    expect(state.pendingJoins.value).toHaveLength(1)
    approvals.decideJoin(secondRequest!.id, true)
    await expect(second).resolves.toEqual({ role: "editor", followOwner: false })
    expect(state.pendingJoins.value).toHaveLength(0)
  })

  it("cancels pending requests without granting owner-connection permission", async () => {
    const state = createDeviceSyncState()
    const approvals = createDeviceSyncJoinApproval(state)
    const pending = approvals.waitForJoinDecision("keeper", "Keeper", true)
    approvals.cancelPending()

    await expect(pending).resolves.toBeNull()
    expect(state.pendingJoins.value).toHaveLength(0)
  })
})
