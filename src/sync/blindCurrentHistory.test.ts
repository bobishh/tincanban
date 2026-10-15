import { expect, it, vi } from "vitest"
import { mergeCurrentBlindHistory } from "./blindCurrentHistory"
import { encodeBlindBytes } from "./blindEnvelope"

it("Given the exact already verified attestation from Rusty, when polling current v2 again, then admit its tail with the current opaque basis without a self-parent root switch", async () => {
  const signed = new Uint8Array([1, 2, 3]), previous = { originalJson: () => signed.slice() } as never
  const merge = vi.fn(async () => {}), ensureCurrent = vi.fn(async () => {}), document = new Uint8Array([4])
  const authorization = { original: true }
  await expect(mergeCurrentBlindHistory({ previous, signedJson: encodeBlindBytes(signed), document, authorization,
    ensureCurrent, merge })).resolves.toBe(true)
  expect(merge).toHaveBeenCalledWith(document, authorization, previous); expect(ensureCurrent).toHaveBeenCalledTimes(3)
})
it("Given an exact repeat carries a new Rusty route, when accepting the tail, then persist route metadata before merging", async () => {
  const signed = new Uint8Array([1, 2, 3]), previous = { originalJson: () => signed.slice() } as never
  const order: string[] = []
  await mergeCurrentBlindHistory({ previous, signedJson: encodeBlindBytes(signed), document: new Uint8Array([4]), authorization: {},
    ensureCurrent: async () => {}, onSameBaseline: async () => { order.push("route") }, merge: async () => { order.push("merge") } })
  expect(order).toEqual(["route", "merge"])
})
it("Given another descriptor or altered signature, when polling, then preserve full Native baseline verification", async () => {
  const merge = vi.fn(), ensureCurrent = vi.fn(async () => {})
  await expect(mergeCurrentBlindHistory({ previous: { originalJson: () => new Uint8Array([1]) } as never,
    signedJson: encodeBlindBytes(new Uint8Array([2])), document: new Uint8Array([4]), authorization: {}, ensureCurrent, merge })).resolves.toBe(false)
  expect(merge).not.toHaveBeenCalled()
})
it("Given an invalid current tail or changed session, when the same attestation repeats, then propagate failure without acknowledging", async () => {
  const merge = vi.fn(async () => { throw new Error("Native rejected unsigned tail") })
  await expect(mergeCurrentBlindHistory({ previous: { originalJson: () => new Uint8Array([1]) } as never,
    signedJson: encodeBlindBytes(new Uint8Array([1])), document: new Uint8Array([4]), authorization: {}, ensureCurrent: async () => {}, merge }))
    .rejects.toThrow("Native rejected unsigned tail")
})
