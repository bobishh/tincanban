import { expect, it } from "vitest"
import { equalIncomingPacket, fullyVerifiedIncomingInput } from "./stateIncomingReuseEquality"
import type { WorkspaceAdmissionResult } from "./sync/workspaceAdmissionCore"

const packet = () => ({ bytes: new Uint8Array([1, 2, 3]), authorization: {
  records: [{ certificates: [{ signature: "a", payload: { device: "a" } }, { signature: "b", payload: { device: "b" } }],
    signed: { signature: "signed", payload: { certificates: ["a", "b"] } } }],
} })

it("Given fresh JSON packet objects, When certificate collection order changes, Then equality ignores only that unsigned collection order", () => {
  const first = packet(), reordered = packet()
  reordered.authorization.records[0]!.certificates.reverse()
  expect(equalIncomingPacket(first, reordered)).toBe(true)
  reordered.authorization.records[0]!.signed.payload.certificates.reverse()
  expect(equalIncomingPacket(first, reordered)).toBe(false)
})

it.each(["bytes", "certificate", "duplicates", "signature"])("Given a changed %s, When comparing a cached input, Then every distinct security value remains consequential", changed => {
  const first = packet(), altered = packet()
  if (changed === "bytes") altered.bytes[0] = 4
  if (changed === "certificate") altered.authorization.records[0]!.certificates[0]!.payload.device = "other"
  if (changed === "duplicates") altered.authorization.records[0]!.certificates[1] = altered.authorization.records[0]!.certificates[0]!
  if (changed === "signature") altered.authorization.records[0]!.signed.signature = "other"
  expect(equalIncomingPacket(first, altered)).toBe(false)
})

it("Given a signed batch claiming an absent hash, When only its known hash was verified, Then the input cannot extend reuse across local writes", () => {
  const record = { signed: { signature: "batch", payload: { hashes: ["known", "missing"] } } }
  const admission = { decisions: [{ hash: "known", status: { type: "admitted", role: "owner" } }],
    admittedHashes: ["known"], verifiedAuthorizations: [{ ...record, grant: null }] } as unknown as WorkspaceAdmissionResult
  expect(fullyVerifiedIncomingInput({ version: 1, records: [record] }, admission)).toBe(false)
})
