import { expect, it, vi } from "vitest"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { HistoryAncestorBudget } from "./historyAncestorBudget"
import { captureVerifiedHistoryAncestors, readVerifiedHistoryAncestors } from "./verifiedHistoryAncestors"

function basis(id: string, parent?: string) {
  const value = Object.create(WasmVerifiedReceivedHistoryBaseline.prototype) as WasmVerifiedReceivedHistoryBaseline
  const verify = vi.fn((other: WasmVerifiedReceivedHistoryBaseline) => {
    if ((other.envelope() as { payload: { baselineId: string } }).payload.baselineId !== parent) throw new Error("Wrong signed parent")
  })
  Object.defineProperties(value, {
    originalJson: { value: () => new TextEncoder().encode(id) }, document: { value: () => new Uint8Array([1, 2]) },
    controlJson: { value: () => new Uint8Array([3]) }, encryptedObjects: { value: () => new Map() },
    plaintextObjects: { value: () => new Map([["P".repeat(43), new Uint8Array([4])]]) },
    storageVerification: { value: () => "public-receipts-only" }, verifyPreviousBaseline: { value: verify },
    envelope: { value: () => ({ payload: { workspaceId: "workspace", baselineId: id, previousBaselineId: parent,
      storage: { keyEpoch: 1, authority: { scopeId: "scope" } } } }) },
  })
  return { value, verify }
}

it("Given verified predecessor bases, when capturing enrollment history, then bind exact chain evidence to its current head without activating ancestors", () => {
  const parent = basis("A".repeat(43)), current = basis("B".repeat(43), "A".repeat(43))
  const evidence = captureVerifiedHistoryAncestors(current.value, [parent.value])
  expect(current.verify).toHaveBeenCalledWith(parent.value)
  expect(readVerifiedHistoryAncestors(evidence, current.value).map(row => row.baselineId)).toEqual(["A".repeat(43)])
  expect(() => readVerifiedHistoryAncestors(evidence, basis("C".repeat(43)).value)).toThrow(/head|candidate/i)
  expect(() => readVerifiedHistoryAncestors({} as never, current.value)).toThrow(/verified/i)
})

it("Given a signed sibling or incomplete chain, when capturing ancestry, then reject before retention", () => {
  const current = basis("B".repeat(43), "A".repeat(43))
  expect(() => captureVerifiedHistoryAncestors(current.value, [basis("C".repeat(43)).value])).toThrow(/parent/i)
  expect(() => captureVerifiedHistoryAncestors(current.value, [])).toThrow(/incomplete/i)
})

it("Given a chain budget, when another parent's document and proof exceed remaining bytes, then reject before another source is fetched", () => {
  const parent = basis("A".repeat(43))
  const budget = new HistoryAncestorBudget(48)
  // Signature43 + document2 + control1 + proof1 =47; each evidence category counts.
  budget.addBasis(parent.value)
  expect(() => budget.add(2)).toThrow(/retention bound/i)
  expect(() => new HistoryAncestorBudget(46).addBasis(parent.value)).toThrow(/retention bound/i)
})
