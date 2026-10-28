import { describe, expect, it, vi } from "vitest"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { sha256Base64Url } from "../domain/identity"
import { parsePeerHistoryBaselineRead, parsePeerHistoryDocumentRead, parsePeerHistoryObjectRead, readPeerHistoryBaseline,
  readPeerHistoryDocument, readPeerHistoryObject, respondToPeerHistoryBaselineRead, respondToPeerHistoryDocumentRead,
  respondToPeerHistoryObjectRead, readPeerHistoryAwareAcceptStream, type PeerHistoryObjectBinding } from "./peerHistoryTransport"

import { createPeerHistoryHandlers, createPeerHistoryObjectReader } from "./workspaceSetHistory"
import type { SyncConnection } from "./transport"

const objectId = "A".repeat(43)
const baselineId = "B".repeat(43)
const binding: PeerHistoryObjectBinding = { workspaceId: "board", historyEpoch: 4, indexId: "catalogue",
  objectKind: "part", partIndex: 0, partCount: 1 }

function streamPair() {
  let receiveRequest!: (value: Uint8Array) => void
  let receiveResponse!: (value: Uint8Array) => void
  const request = new Promise<Uint8Array>(resolve => { receiveRequest = resolve })
  const response = new Promise<Uint8Array>(resolve => { receiveResponse = resolve })
  return {
    client: { send: async (value: Uint8Array) => { receiveRequest(value) }, closeSend: async () => {}, read: async (maximum?: number) => {
      const value = await response
      if (maximum !== undefined && value.length > maximum) throw new Error("stream response too large")
      return value
    }, readRaw: async (maximum?: number) => {
      const value = await response
      if (maximum !== undefined && value.length > maximum) throw new Error("stream response too large")
      return value
    } },
    server: { read: async (maximum?: number) => {
      const value = await request
      if (maximum !== undefined && value.length > maximum) throw new Error("stream request too large")
      return value
    }, readRaw: async (maximum?: number) => {
      const value = await request
      if (maximum !== undefined && value.length > maximum) throw new Error("stream request too large")
      return value
    }, send: async (value: Uint8Array) => { receiveResponse(value) }, closeSend: async () => {} },
  }
}

describe("direct peer history object transport", () => {
  it("Given an authenticated history read, when one stream times out, then retry the captured object once on a fresh stream of the same connection", async () => {
    vi.useFakeTimers()
    try {
      const sent: Uint8Array[] = []
      const send = vi.fn(async (frame: Uint8Array) => { sent.push(frame) }), reset = vi.fn(async () => {})
      const stalled = { send, closeSend: async () => {}, readRaw: () => new Promise<Uint8Array>(() => {}), reset }
      const payload = new Uint8Array([7, 8, 9])
      const magic = new TextEncoder().encode("tincanban-peer-history-v1\n")
      const recovered = { send, closeSend: async () => {}, readRaw: async () => new Uint8Array([...magic, 0, ...payload]), reset: async () => {} }
      const openStream = vi.fn().mockResolvedValueOnce(stalled).mockResolvedValueOnce(recovered)
      const close = vi.fn()
      const guard = vi.fn(async () => {})
      const reader = createPeerHistoryObjectReader({ openStream, close } as unknown as SyncConnection, guard)
      const input = { ...binding }
      const result = reader.read(objectId, input, baselineId).catch(error => ({ error }))
      await vi.advanceTimersByTimeAsync(0)
      input.workspaceId = "changed-after-request"
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toEqual(payload)
      expect(openStream).toHaveBeenCalledTimes(2)
      expect(reset).toHaveBeenCalledOnce()
      expect(sent[0]).toEqual(sent[1])
      expect(close).not.toHaveBeenCalled()
      expect(guard).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it("Given a multipart document, when one later stream resets, then retry that exact part without restarting verified earlier parts", async () => {
    const bytes = new Uint8Array(300_000).fill(7)
    const digest = await sha256Base64Url(bytes)
    const requests: Array<{ offset: number; length: number }> = []
    const magic = new TextEncoder().encode("tincanban-peer-history-v1\n")
    const openStream = vi.fn(async () => {
      const attempt = openStream.mock.calls.length
      let request!: { offset: number; length: number }
      return { send: async (frame: Uint8Array) => {
        request = parsePeerHistoryDocumentRead(frame)!
        requests.push(request)
      }, closeSend: async () => {}, reset: async () => {}, readRaw: async () => {
        if (attempt === 2) throw new MeshNetworkError("History part stream reset")
        return new Uint8Array([...magic, 0, ...bytes.slice(request.offset, request.offset + request.length)])
      } }
    })
    const reader = createPeerHistoryObjectReader({ openStream } as unknown as SyncConnection, () => {})
    await expect(reader.readDocument({ version: 1, sourceKind: "authenticated-peer-plaintext", signedJson: "e30",
      baselineId, documentDigest: digest, documentLength: bytes.length }, "board")).resolves.toEqual(bytes)
    expect(requests.map(request => request.offset)).toEqual([0, 256 * 1024, 256 * 1024])
  })

  it("Given a stalled compact document, when its original deadline expires, then fail without granting a second document deadline", async () => {
    vi.useFakeTimers()
    try {
      const openStream = vi.fn(async () => ({ send: async () => {}, closeSend: async () => {}, reset: async () => {},
        readRaw: () => new Promise<Uint8Array>(() => {}) }))
      const reader = createPeerHistoryObjectReader({ openStream } as unknown as SyncConnection, () => {})
      let failure: unknown
      void reader.readDocument({ version: 1, sourceKind: "authenticated-peer-plaintext", signedJson: "e30",
        baselineId, documentDigest: objectId, documentLength: 1 }, "board").catch(error => { failure = error })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(failure).toBeInstanceOf(MeshNetworkError)
      expect(openStream).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it("Given both history streams fail, when retrying an authenticated read, then stop after the second attempt", async () => {
    const openStream = vi.fn(async () => { throw new MeshNetworkError("Connection lost") })
    const reader = createPeerHistoryObjectReader({ openStream } as unknown as SyncConnection, () => {})
    await expect(reader.read(objectId, binding, baselineId)).rejects.toThrow("Connection lost")
    expect(openStream).toHaveBeenCalledTimes(2)
  })

  it.each(["unavailable", "malformed"])("Given an explicit %s history reply, when reading, then fail without retrying that terminal response", async kind => {
    const magic = new TextEncoder().encode("tincanban-peer-history-v1\n")
    const bytes = kind === "unavailable" ? new Uint8Array([...magic, 1]) : new TextEncoder().encode("malformed response")
    const openStream = vi.fn(async () => ({ send: async () => {}, closeSend: async () => {}, readRaw: async () => bytes, reset: async () => {} }))
    const reader = createPeerHistoryObjectReader({ openStream } as unknown as SyncConnection, () => {})
    await expect(reader.read(objectId, binding, baselineId)).rejects.toThrow(kind === "unavailable" ? /unavailable/ : /Invalid peer history/)
    expect(openStream).toHaveBeenCalledOnce()
  })

  it("Given authority is revoked after a stream fails, when retry is considered, then stop before opening another stream", async () => {
    let revoked = false
    const guard = async () => { if (revoked) throw new Error("Device access revoked") }
    const openStream = vi.fn(async () => ({ send: async () => {}, closeSend: async () => {}, reset: async () => {}, readRaw: async () => {
      revoked = true
      throw new MeshNetworkError("Stream reset")
    } }))
    const reader = createPeerHistoryObjectReader({ openStream } as unknown as SyncConnection, guard)
    await expect(reader.read(objectId, binding, baselineId)).rejects.toThrow("Device access revoked")
    expect(openStream).toHaveBeenCalledOnce()
  })

  it("Given compact document bytes fail their signed digest, when reading history, then reject without another transfer", async () => {
    const magic = new TextEncoder().encode("tincanban-peer-history-v1\n")
    const openStream = vi.fn(async () => ({ send: async () => {}, closeSend: async () => {}, reset: async () => {},
      readRaw: async () => new Uint8Array([...magic, 0, 1]) }))
    const reader = createPeerHistoryObjectReader({ openStream } as unknown as SyncConnection, () => {})
    await expect(reader.readDocument({ version: 1, sourceKind: "authenticated-peer-plaintext", signedJson: "e30",
      baselineId, documentDigest: objectId, documentLength: 1 }, "board")).rejects.toThrow("digest changed")
    expect(openStream).toHaveBeenCalledOnce()
  })

  it.each(["object", "baseline"])("Given an archive %s request, when the peer closes without any response bytes, then reports a transport failure", async kind => {
    const reset = vi.fn(async () => {})
    const stream = { send: async () => {}, closeSend: async () => {}, read: vi.fn(),
      readRaw: async () => new Uint8Array(), reset }
    const read = kind === "object"
      ? readPeerHistoryObject(async () => stream, { baselineId, objectId, binding }, () => {})
      : readPeerHistoryBaseline(async () => stream, "board", () => {}, baselineId)
    await expect(read).rejects.toBeInstanceOf(MeshNetworkError)
    expect(reset).toHaveBeenCalledOnce()
    expect(stream.read).not.toHaveBeenCalled()
  })

  it.each(["object", "baseline"])("Given an archive %s request, when the response contains an invalid protocol prefix, then preserves the protocol error", async kind => {
    const stream = { send: async () => {}, closeSend: async () => {}, read: vi.fn(),
      readRaw: async () => new TextEncoder().encode("invalid history message"), reset: async () => {} }
    const read = kind === "object"
      ? readPeerHistoryObject(async () => stream, { baselineId, objectId, binding }, () => {})
      : readPeerHistoryBaseline(async () => stream, "board", () => {}, baselineId)
    const error = await read.catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MeshNetworkError)
    expect(error).toMatchObject({ message: expect.stringMatching(/Invalid peer history/) })
  })

  it("reads bounded history requests on workspace-join acknowledgement streams", async () => {
    const request = new TextEncoder().encode("tincanban-peer-history-v1\n{}")
    const rawStream = {
      read: async () => { throw new Error("Pairing header missing or too large") },
      readPairingOrRawPrefix: vi.fn(async (prefix: Uint8Array, maximum?: number) => {
        expect(new TextDecoder().decode(prefix)).toBe("tincanban-peer-history-v1\n")
        expect(maximum).toBe(4 * 1024)
        return request
      }),
      send: async () => {}, closeSend: async () => {},
    }
    const connection = {
      acceptStream: async () => rawStream,
      openStream: async () => rawStream,
      close: async () => {},
    }

    const stream = await readPeerHistoryAwareAcceptStream(connection).acceptStream()
    await expect(stream.read()).resolves.toEqual(request)
    expect(rawStream.readPairingOrRawPrefix).toHaveBeenCalledOnce()
  })

  it("exchanges only the bounded public baseline descriptor before a direct-peer bootstrap", async () => {
    const streams = streamPair(), descriptor = { version: 1, sourceKind: "authenticated-peer-plaintext",
      signedJson: "e30", baselineId, documentDigest: objectId, documentLength: 4 }
    const pending = readPeerHistoryBaseline(async () => streams.client as never, "board", () => {})
    const request = parsePeerHistoryBaselineRead(await streams.server.read())
    expect(request).toEqual({ workspaceId: "board" })
    await respondToPeerHistoryBaselineRead(streams.server as never, request!, async workspaceId => {
      expect(workspaceId).toBe("board")
      return descriptor
    }, () => {})
    await expect(pending).resolves.toEqual(descriptor)
  })

  it("requests an exact retained baseline by ID without falling back to the current head", async () => {
    const streams = streamPair()
    const pending = readPeerHistoryBaseline(async () => streams.client as never, "board", () => {}, baselineId)
    const request = parsePeerHistoryBaselineRead(await streams.server.read())
    expect(request).toEqual({ workspaceId: "board", baselineId })
    await respondToPeerHistoryBaselineRead(streams.server as never, request!, async (workspaceId, requestedId) => {
      expect(workspaceId).toBe("board")
      expect(requestedId).toBe(baselineId)
      return { version: 1, sourceKind: "authenticated-peer-plaintext", signedJson: "e30", baselineId,
        documentDigest: objectId, documentLength: 4 }
    }, () => {})
    await expect(pending).resolves.toMatchObject({ baselineId })
  })

  it("rejects malformed exact-baseline selectors", async () => {
    const frame = new TextEncoder().encode(`tincanban-peer-history-v1\n${JSON.stringify({ version: 1,
      kind: "workspace-history-baseline-read", workspaceId: "board", baselineId: "wrong" })}`)
    expect(() => parsePeerHistoryBaselineRead(frame)).toThrow("Invalid peer history baseline request")
  })

  it("Given a signed baseline descriptor, when compact bytes are requested in bounded chunks, then verifies the final document digest", async () => {
    const streams = streamPair(), document = new TextEncoder().encode("compact baseline")
    const digest = await sha256Base64Url(document), baselineId = "B".repeat(43)
    const pending = readPeerHistoryDocument(async () => streams.client as never, {
      workspaceId: "board", baselineId, documentDigest: digest, length: document.length,
    }, () => {})
    const request = parsePeerHistoryDocumentRead(await streams.server.read())
    expect(request).toMatchObject({ workspaceId: "board", baselineId, documentDigest: digest, offset: 0, length: document.length })
    await respondToPeerHistoryDocumentRead(streams.server as never, request!, async value => {
      expect(value).toEqual(request)
      return document.slice(value.offset, value.offset + value.length)
    }, () => {})
    await expect(pending).resolves.toEqual(document)
  })

  it("Given a compact document larger than one part, when the source returns bounded slices, then preserves every byte across the second request", async () => {
    const document = new Uint8Array(300_000).map((_, index) => index % 251)
    const digest = await sha256Base64Url(document)
    const handlers = createPeerHistoryHandlers({ readHistoryBaselineDocument: async request =>
      document.slice(request.offset, request.offset + request.length) }, ["board"])
    const serving: Promise<unknown>[] = []
    const open = async () => {
      const streams = streamPair()
      serving.push((async () => {
        await handlers.serveDocument(await streams.server.read(), streams.server as never, "approved-device", () => {})
      })())
      return streams.client as never
    }
    await expect(readPeerHistoryDocument(open, { workspaceId: "board", baselineId,
      documentDigest: digest, length: document.length }, () => {})).resolves.toEqual(document)
    await Promise.all(serving)
  })

  it("Given an authenticated peer requests one archive part, when source permission remains current, then returns only the exact bounded bytes", async () => {
    const streams = streamPair(), bytes = new Uint8Array(200_000).fill(7)
    const guard = vi.fn()
    const request = readPeerHistoryObject(async () => streams.client as never, { baselineId, objectId, binding }, guard)
    const frame = await streams.server.read()
    const parsed = parsePeerHistoryObjectRead(frame)
    expect(parsed).toEqual({ version: 1, kind: "workspace-history-object-read", baselineId, objectId, binding })
    const read = vi.fn(async (actualId: string, actual: PeerHistoryObjectBinding) => actualId === objectId && actual.workspaceId === binding.workspaceId ? bytes : undefined)
    await respondToPeerHistoryObjectRead(streams.server as never, parsed!, (actualBaseline, actualId, actual) => {
      expect(actualBaseline).toBe(baselineId)
      return read(actualId, actual)
    }, guard)
    expect(await request).toEqual(bytes)
    expect(read).toHaveBeenCalledWith(objectId, binding)
    expect(guard).toHaveBeenCalledTimes(8)
  })

  it("rechecks permission after opening a stream and before sending a history request", async () => {
    const send = vi.fn(), stream = { send, closeSend: vi.fn(), read: vi.fn(), reset: vi.fn() }
    const guard = vi.fn().mockImplementationOnce(() => {}).mockRejectedValueOnce(new Error("Device access revoked"))
    await expect(readPeerHistoryObject(async () => stream as never, { baselineId, objectId, binding }, guard))
      .rejects.toThrow("Device access revoked")
    expect(send).not.toHaveBeenCalled()
  })

  it("accepts exact nested archive index paths used by archive pages and change parts", () => {
    const nested = { ...binding, indexId: `change/${"a".repeat(64)}/bytes` }
    const frame = new TextEncoder().encode(`tincanban-peer-history-v1\n${JSON.stringify({ version: 1,
      kind: "workspace-history-object-read", baselineId, objectId, binding: nested })}`)
    expect(parsePeerHistoryObjectRead(frame)?.binding.indexId).toBe(nested.indexId)
  })

  it("resets a stalled history stream when its bounded read deadline expires", async () => {
    const reset = vi.fn(async () => {}), stream = { send: vi.fn(async () => {}), closeSend: vi.fn(async () => {}),
      read: vi.fn(), readRaw: vi.fn(() => new Promise<Uint8Array>(() => {})), reset }
    vi.useFakeTimers()
    try {
      const pending = readPeerHistoryObject(async () => stream as never, { baselineId, objectId, binding }, () => {})
      const rejected = expect(pending).rejects.toThrow(/deadline/i)
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(stream.readRaw).toHaveBeenCalledWith(new TextEncoder().encode("tincanban-peer-history-v1\n").length + 1 + 256 * 1024)
      expect(stream.read).not.toHaveBeenCalled()
      expect(reset).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it("Given an archive-page request, when the source exceeds 64 KiB, then sends unavailable rather than a partial record", async () => {
    const streams = streamPair(), page = { ...binding, objectKind: "page" as const }
    const request = readPeerHistoryObject(async () => streams.client as never, { baselineId, objectId, binding: page }, () => {})
    const parsed = parsePeerHistoryObjectRead(await streams.server.read())
    await respondToPeerHistoryObjectRead(streams.server as never, parsed!, async () => new Uint8Array(64 * 1024 + 1), () => {})
    await expect(request).rejects.toThrow("unavailable")
  })

  it("Given forged scope fields or an unbounded binding, when parsed, then rejects before source access", () => {
    expect(parsePeerHistoryObjectRead(new TextEncoder().encode("ordinary live frame"))).toBeUndefined()
    const request = new TextEncoder().encode(`tincanban-peer-history-v1\n${JSON.stringify({ version: 1,
      kind: "workspace-history-object-read", baselineId, objectId, binding: { ...binding, workspaceId: "other", privateKey: "secret" } })}`)
    expect(() => parsePeerHistoryObjectRead(request)).toThrow("Invalid peer history request")
  })
})
