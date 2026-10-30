import { describe, expect, it, vi } from "vitest"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { createPeerHistoryAuthorizationGuard } from "./peerHistoryAuthorization"

describe("direct-peer history authorization", () => {
  it("revalidates the signed device bundle and current workspace revocation state for every read", async () => {
    const checkGuestDevices = vi.fn().mockResolvedValue("device-a")
    const guard = createPeerHistoryAuthorizationGuard({
      workspaceIds: ["board-a", "board-b"], personId: "person-a", deviceId: "device-a", advertisements: [{ signed: true }],
      isSessionCurrent: () => true, checkGuestDevices,
    })

    await guard()
    await guard()
    expect(checkGuestDevices).toHaveBeenNthCalledWith(1, ["board-a", "board-b"], "person-a", [{ signed: true }])
    expect(checkGuestDevices).toHaveBeenCalledTimes(2)
    checkGuestDevices.mockRejectedValueOnce(new Error("Device access revoked"))
    await expect(guard()).rejects.toThrow("Device access revoked")
  })

  it("rejects a changed verified device or cancelled session before granting access", async () => {
    const checkGuestDevices = vi.fn().mockResolvedValue("device-b")
    const guard = createPeerHistoryAuthorizationGuard({ workspaceIds: ["board"], personId: "person", deviceId: "device-a",
      advertisements: [], isSessionCurrent: () => true, checkGuestDevices })
    const changedDevice = guard()
    await expect(changedDevice).rejects.toThrow(/device authorization changed/i)
    await expect(changedDevice).rejects.not.toBeInstanceOf(MeshNetworkError)

    const cancelled = createPeerHistoryAuthorizationGuard({ workspaceIds: ["board"], personId: "person", deviceId: "device-a",
      advertisements: [], isSessionCurrent: () => false, checkGuestDevices })
    await expect(cancelled()).rejects.toBeInstanceOf(MeshNetworkError)
    expect(checkGuestDevices).toHaveBeenCalledTimes(1)
  })

  it("Given current signed access, when its session closes during device verification, then classify the closed channel as unavailable", async () => {
    let current = true
    const checkGuestDevices = vi.fn(async () => { current = false; return "device-a" })
    const guard = createPeerHistoryAuthorizationGuard({ workspaceIds: ["board"], personId: "person", deviceId: "device-a",
      advertisements: [], isSessionCurrent: () => current, checkGuestDevices })
    await expect(guard()).rejects.toBeInstanceOf(MeshNetworkError)
    expect(checkGuestDevices).toHaveBeenCalledOnce()
  })
})
