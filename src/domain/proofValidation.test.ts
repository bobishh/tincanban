import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../localDb", () => {
  throw new Error("Portable proof validation must not load browser storage")
})

afterEach(() => vi.unstubAllGlobals())

describe("portable proof validation", () => {
  it("loads and hashes certificate evidence without constructing the browser proof store", async () => {
    vi.stubGlobal("indexedDB", undefined)
    const validation = await import("./proofValidation")
    const { profileFromIdentitySeedForDevice } = await import("@meta-uber/mesh-identity")
    const profile = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(41), "Portable", new Uint8Array(32).fill(42))
    await expect(validation.certHashDefault(profile.certificate)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
