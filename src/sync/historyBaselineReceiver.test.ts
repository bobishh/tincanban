import { afterEach, describe, expect, it, vi } from "vitest"

const verifyBaseline = vi.hoisted(() => vi.fn())
vi.mock("@meta-uber/mesh-transport/wasm", () => ({
  WasmStateCore: { verifyOwnerAttestedHistoryBaseline: verifyBaseline },
  WasmVerifiedReceivedHistoryBaseline: class WasmVerifiedReceivedHistoryBaseline {},
}))

import { reverifyStoredHistoryBaseline } from "../product-replica/historyBaselineReceiver"

afterEach(() => vi.restoreAllMocks())

function stored(encryptedObjects: unknown[] = []) {
  return { state: "active", workspaceId: "workspace-a", scopeId: "scope-a", keyEpoch: 1,
    pinnedStorage: {}, signedJson: new Uint8Array([1]), document: new Uint8Array([2]), encryptedObjects } as never
}

describe("retained history baseline verification", () => {
  it("Given oversized persisted ciphertext rows, when reopening a basis, then reject before cloning the stored payload", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone")
    const rows = Array.from({ length: 8193 }, (_, index) => ({ ciphertextId: `${index.toString(36).padStart(3, "0")}${"A".repeat(40)}`,
      object: { version: 1 } }))
    await expect(reverifyStoredHistoryBaseline({ stored: stored(rows), scope: { scopeId: "scope-a", keyEpoch: 1,
      key: new Uint8Array(32) }, ensureCurrent: () => {}, trustedScopeAuthority: {} })).rejects.toThrow(/bound|limit/i)
    expect(clone).not.toHaveBeenCalled()
  })

  it("Given Native candidate accessors fail, when checking the durable candidate, then free its opaque handle", async () => {
    const free = vi.fn(), candidate = { document: () => { throw new Error("candidate read failed") }, free }
    verifyBaseline.mockReturnValue(candidate)
    await expect(reverifyStoredHistoryBaseline({ stored: stored([{ ciphertextId: "A".repeat(43), object: {
      version: 1, scopeId: "scope-a", keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(22),
    } }]),
      scope: { scopeId: "scope-a", keyEpoch: 1, key: new Uint8Array(32) },
      ensureCurrent: () => {}, trustedScopeAuthority: {} })).rejects.toThrow("candidate read failed")
    expect(free).toHaveBeenCalledOnce()
  })
})
