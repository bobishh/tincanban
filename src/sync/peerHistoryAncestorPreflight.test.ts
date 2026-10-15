import { expect, it, vi } from "vitest"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { PeerHistoryObjectReader } from "./workspaceSetHistory"
const mocks = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock("./peerHistoryBaselineReceiver", () => ({ verifyPeerReceivedHistoryBaseline: mocks.verify }))
import { preflightPeerHistoryAncestors } from "./peerHistoryAncestorPreflight"
import { readVerifiedHistoryAncestors } from "./verifiedHistoryAncestors"

function basis(id: string, previous?: string) {
  const value = Object.create(WasmVerifiedReceivedHistoryBaseline.prototype) as WasmVerifiedReceivedHistoryBaseline
  const free = vi.fn(), edge = vi.fn((parent: WasmVerifiedReceivedHistoryBaseline) => {
    if ((parent.envelope() as { payload: { baselineId: string } }).payload.baselineId !== previous) throw new Error("Wrong signed predecessor")
  })
  Object.defineProperties(value, {
    envelope: { value: () => ({ payload: { workspaceId: "board", baselineId: id, previousBaselineId: previous,
      storage: { keyEpoch: 1, authority: { scopeId: "scope" } } } }) },
    originalJson: { value: () => new TextEncoder().encode(id) }, document: { value: () => new Uint8Array([1]) },
    controlJson: { value: () => new Uint8Array([2]) }, encryptedObjects: { value: () => new Map() },
    storageVerification: { value: () => "public-receipts-only" },
    plaintextObjects: { value: () => new Map([["P".repeat(43), new Uint8Array([3])]]) },
    verifyPreviousBaseline: { value: edge }, free: { value: free },
  })
  return { value, free, edge }
}
function fixture() {
  const parent = basis("A".repeat(43)), current = basis("B".repeat(43), "A".repeat(43))
  const readBaseline = vi.fn().mockResolvedValue({ baselineId: "A".repeat(43), signedJson: "e30" })
  const readDocument = vi.fn().mockResolvedValue(new Uint8Array([1])), authorizeHistoryAncestor = vi.fn()
  const reader = { readBaseline, readDocument, authorizeHistoryAncestor, ensureCurrent: vi.fn(), read: vi.fn() } as unknown as PeerHistoryObjectReader
  mocks.verify.mockReset().mockResolvedValue(parent.value)
  return { parent, current, readBaseline, readDocument, authorizeHistoryAncestor, reader,
    run: () => preflightPeerHistoryAncestors({ workspaceId: "board", candidate: current.value, reader,
      trustedScopeAuthority: { genesis: { signed: true }, revocations: ["newer"] }, ensureCurrent: () => {} }) }
}
it("Given a verified current peer basis, when bootstrapping enrollment, then fetch exact ancestors and retain only detached Native-linked evidence", async () => {
  const f = fixture(), token = await f.run()
  expect(f.authorizeHistoryAncestor).toHaveBeenCalledWith(f.current.value)
  expect(f.readBaseline).toHaveBeenCalledWith("board", "A".repeat(43))
  expect(f.current.edge).toHaveBeenCalledWith(f.parent.value)
  expect(readVerifiedHistoryAncestors(token, f.current.value)).toHaveLength(1)
  expect(f.parent.free).toHaveBeenCalledOnce()
  expect(f.current.free).not.toHaveBeenCalled()
  expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ trustedScopeAuthority: {
    genesis: { signed: true }, grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [],
  } }))
})
it("Given a missing signed parent, when enrollment preflight runs, then report incomplete history before any adoption", async () => {
  const f = fixture(); f.readBaseline.mockResolvedValue(undefined)
  await expect(f.run()).rejects.toThrow(/incomplete/i)
  expect(f.readDocument).not.toHaveBeenCalled()
  expect(mocks.verify).not.toHaveBeenCalled()
})
it("Given a forged sibling instead of the signed parent, when preflight verifies the edge, then reject and free the candidate", async () => {
  const f = fixture(), sibling = basis("C".repeat(43)); mocks.verify.mockResolvedValue(sibling.value)
  await expect(f.run()).rejects.toThrow(/predecessor/i)
  expect(sibling.free).toHaveBeenCalledOnce()
})
