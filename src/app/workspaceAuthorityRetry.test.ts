import { describe, expect, it, vi } from "vitest"
import { withWorkspaceAuthorityRaceRetry } from "./workspaceAuthorityRetry"

const raceError = () => new Error("Workspace authority changed during access validation. Retry.")

describe("workspace access authority race retry", () => {
  it("retries only the recognized authority snapshot race", async () => {
    const read = vi.fn().mockRejectedValueOnce(raceError()).mockResolvedValue("owner")
    const ensureCurrent = vi.fn()

    await expect(withWorkspaceAuthorityRaceRetry(read, ensureCurrent)).resolves.toBe("owner")
    expect(read).toHaveBeenCalledTimes(2)
    expect(ensureCurrent).toHaveBeenCalledTimes(1)
  })

  it("does not retry unrelated authorization failures", async () => {
    const read = vi.fn(async () => { throw new Error("Workspace proof is invalid") })

    await expect(withWorkspaceAuthorityRaceRetry(read, vi.fn())).rejects.toThrow("Workspace proof is invalid")
    expect(read).toHaveBeenCalledOnce()
  })

  it("does not retry when caller context changed", async () => {
    const read = vi.fn().mockRejectedValue(raceError())
    const ensureCurrent = vi.fn(() => { throw new Error("Workspace access request was replaced") })

    await expect(withWorkspaceAuthorityRaceRetry(read, ensureCurrent)).rejects.toThrow("Workspace access request was replaced")
    expect(read).toHaveBeenCalledOnce()
  })
})
