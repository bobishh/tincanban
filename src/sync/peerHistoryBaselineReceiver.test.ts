import { expect, it, vi } from "vitest"
import { verifyPeerReceivedHistoryBaseline, reverifyStoredPeerHistoryBaseline } from "./peerHistoryBaselineReceiver"

it("Given a peer offering unbounded source frontiers, when bootstrapping history, then refuse before any archive read", async () => {
  const read = vi.fn()
  await expect(verifyPeerReceivedHistoryBaseline({
    signedJson: new TextEncoder().encode(JSON.stringify({ payload: { workspaceId: "w", historyEpoch: 1,
      sourceHeads: Array(257).fill("a".repeat(64)), archive: { context: { workspaceId: "w", historyEpoch: 1, indexId: "catalogue" } } } })),
    baselineDocument: new Uint8Array([1]), trustedScopeAuthority: {}, fetch: { read, ensureCurrent: () => {} }, ensureCurrent: () => {},
  })).rejects.toThrow(/routing|frontier|bound/i)
  expect(read).not.toHaveBeenCalled()
})

it("Given a stored host verified flag without original peer proof bytes, when reopening its basis, then refuse the flag", async () => {
  await expect(reverifyStoredPeerHistoryBaseline({ stored: { verified: true } as never,
    trustedScopeAuthority: {}, ensureCurrent: () => {} })).rejects.toThrow(/proof|missing/i)
})

it("Given peer access revoked before bootstrap, when receiving a compact basis, then refuse before decoding or fetching", async () => {
  const read = vi.fn()
  await expect(verifyPeerReceivedHistoryBaseline({ signedJson: new Uint8Array(), baselineDocument: new Uint8Array(),
    trustedScopeAuthority: {}, fetch: { read, ensureCurrent: () => {} }, ensureCurrent: () => { throw new Error("Access revoked") } }))
    .rejects.toThrow("Access revoked")
  expect(read).not.toHaveBeenCalled()
})
