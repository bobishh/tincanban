import { expect, it } from "vitest"
import { MeshNetworkError, meshNetworkConnection, type IrohConnection, type IrohStream, type MeshIngressBudgetProfile } from "@meta-uber/mesh-transport"
import { PeerHistoryReadAhead, type PeerHistoryReadRequest } from "./peerHistoryReadAhead"

function request(index: number): PeerHistoryReadRequest {
  return { objectId: String(index), maximumBytes: 256 * 1024, binding: {
    workspaceId: "workspace", historyEpoch: 1, indexId: "parts", objectKind: "part", partIndex: index, partCount: 20,
  } }
}

it("Given unconsumed prefetched leaves, when another batch arrives, then reserve at most two MiB and two requests per batch", async () => {
  const batches: number[] = []
  const reader = new PeerHistoryReadAhead(async requests => {
    batches.push(requests.length)
    return requests.map(() => ({ failed: false, bytes: new Uint8Array([1]) }))
  })
  const requests = Array.from({ length: 12 }, (_, index) => request(index))
  await reader.batch(requests)
  await reader.batch(requests.slice(2))
  await reader.batch(requests.slice(4))
  await reader.batch(requests.slice(6))
  await reader.batch(requests.slice(8))
  expect(batches).toEqual([2, 2, 2, 2])
  expect(reader.take(requests[0]!)).toMatchObject({ found: true })
  await reader.batch(requests.slice(8))
  expect(batches).toEqual([2, 2, 2, 2, 1])
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

it("Given one shared peer slot held by a heartbeat, when four history objects are read, then preserve every object in order without exceeding the peer read cap", async () => {
  const profile: MeshIngressBudgetProfile = {
    maxHeaderBytes: () => 4096,
    maxFrameBytes: () => 1024,
    maxPayloadBytes: () => 1024,
    maxLogicalTransferBytes: () => 1024,
    maxTransferPages: () => 4,
    maxTransferDeadlineMs: () => 60_000,
    maxInFlightBytesPerConnection: () => 2048,
    maxConcurrentFramesPerConnection: () => 2,
  }
  let nextStream = 0, activeReads = 0, peakActiveReads = 0, releaseHeartbeat: (() => void) | undefined
  let markHeartbeatStarted: (() => void) | undefined
  const heartbeatStarted = new Promise<void>(resolve => { markHeartbeatStarted = resolve })
  const rawConnection: IrohConnection = {
    remoteEndpointId: "history-readahead-peer",
    async openStream() {
      const streamId = ++nextStream
      const read = async () => {
        activeReads++
        peakActiveReads = Math.max(peakActiveReads, activeReads)
        try { return new Uint8Array([streamId]) }
        finally { activeReads-- }
      }
      const stream: IrohStream = {
        send: async () => {},
        read,
        readPairingFrame: () => streamId === 1 ? new Promise<Uint8Array>(resolve => {
          activeReads++
          peakActiveReads = Math.max(peakActiveReads, activeReads)
          markHeartbeatStarted?.()
          releaseHeartbeat = () => { activeReads--; resolve(new Uint8Array([streamId])) }
        }) : read(),
        closeSend: async () => {},
      }
      return stream
    },
    acceptStream: async () => { throw new Error("Unused") },
    close: async () => {},
  }
  const connection = meshNetworkConnection(rawConnection, profile)
  const heartbeat = await connection.openStream()
  const heartbeatRead = heartbeat.read()
  await heartbeatStarted
  const requests = Array.from({ length: 4 }, (_, index) => request(index))
  const sourceAttempts: string[] = []
  const reader = new PeerHistoryReadAhead(async batch => {
    const reads = await Promise.all(batch.map(async item => {
      sourceAttempts.push(item.objectId)
      try {
        const stream = await connection.openStream()
        return { failed: false, bytes: await stream.readRaw!() }
      } catch (error) {
        // The history source API represents an unavailable remote object as undefined.
        if (error instanceof MeshNetworkError) return { failed: false, bytes: undefined }
        throw error
      }
    }))
    return reads
  })

  const results = []
  try {
    await reader.batch(requests)
    for (const item of requests) {
      let result = reader.take(item)
      if (!result.found) {
        await reader.batch([item])
        result = reader.take(item)
      }
      results.push(result.bytes?.[0])
    }
  } finally {
    releaseHeartbeat?.()
    await heartbeatRead
  }

  expect(sourceAttempts).toEqual(["0", "1", "2", "3"])
  expect(results).toEqual([2, 3, 4, 5])
  expect(peakActiveReads).toBe(2)
})
