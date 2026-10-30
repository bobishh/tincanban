import { expect, it } from "vitest"
import { sha256Base64Url } from "../domain/identity"
import { keeperCommitReceiptVerifier } from "./keeperCommitReceipt"

it("accepts a bounded commit receipt for the exact offered boards and frozen snapshot", async () => {
  const snapshot = new Uint8Array(20 * 1024 * 1024)
  const verify = await keeperCommitReceiptVerifier(["one", "two"], snapshot)
  const receipt = new TextEncoder().encode(JSON.stringify({ kind: "keeper-provision-commit", version: 1,
    workspaceIds: ["one", "two"], snapshotHash: await sha256Base64Url(snapshot) }))
  expect(receipt.byteLength).toBeLessThan(512)
  expect(() => verify(receipt)).not.toThrow()
  snapshot[0] = 1
  expect(() => verify(receipt)).not.toThrow()
})

it("rejects another snapshot, substituted boards, unsupported version and unbounded payload", async () => {
  const snapshot = new Uint8Array([1, 2, 3])
  const verify = await keeperCommitReceiptVerifier(["one", "two"], snapshot)
  const valid = { kind: "keeper-provision-commit", version: 1, workspaceIds: ["one", "two"], snapshotHash: await sha256Base64Url(snapshot) }
  for (const receipt of [{ ...valid, snapshotHash: "wrong" }, { ...valid, workspaceIds: ["one", "other"] },
    { ...valid, workspaceIds: ["two", "one"] }, { ...valid, version: 2 }, { ...valid, history: "unrequested" }]) {
    expect(() => verify(new TextEncoder().encode(JSON.stringify(receipt)))).toThrow(/Invalid keeper commit receipt/)
  }
  expect(() => verify(new Uint8Array(4097))).toThrow(/Invalid keeper commit receipt/)
  expect(() => verify(new TextEncoder().encode("null"))).toThrow(/Invalid keeper commit receipt/)
})
