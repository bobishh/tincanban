import { expect, it } from "vitest"
import { PeerHistoryReadAhead, type PeerHistoryReadRequest } from "./peerHistoryReadAhead"

function request(index: number): PeerHistoryReadRequest {
  return { objectId: String(index), maximumBytes: 256 * 1024, binding: {
    workspaceId: "workspace", historyEpoch: 1, indexId: "parts", objectKind: "part", partIndex: index, partCount: 20,
  } }
}

it("Given unconsumed prefetched leaves, when another batch arrives, then reserve at most two MiB and four requests per batch", async () => {
  const batches: number[] = []
  const reader = new PeerHistoryReadAhead(async requests => {
    batches.push(requests.length)
    return requests.map(() => ({ failed: false, bytes: new Uint8Array([1]) }))
  })
  const requests = Array.from({ length: 12 }, (_, index) => request(index))
  await reader.batch(requests)
  await reader.batch(requests.slice(4))
  await reader.batch(requests.slice(8))
  expect(batches).toEqual([4, 4])
  expect(reader.take(requests[0]!)).toMatchObject({ found: true })
  await reader.batch(requests.slice(8))
  expect(batches).toEqual([4, 4, 1])
  await expect(reader.batch([{ ...request(19), maximumBytes: -1 }])).rejects.toThrow(/bound/)
})

it("Given cached plaintext or a failed request, when context differs, then never reuse the other binding or swallow its original error", async () => {
  const failure = new Error("Access revoked"), original = request(0)
  const reader = new PeerHistoryReadAhead(async () => [{ failed: true, error: failure }])
  await reader.batch([original])
  expect(reader.take({ ...original, binding: { ...original.binding, historyEpoch: 2 } })).toEqual({ found: false })
  expect(() => reader.take(original)).toThrow(failure)
  expect(reader.take(original)).toEqual({ found: false })
})
