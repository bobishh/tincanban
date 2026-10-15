import { describe, expect, it, vi } from "vitest"
import { encodePairingFrame } from "@meta-uber/mesh-pairing"
import type { SyncConnection } from "./transport"
import { awaitEnrollmentAcknowledgement } from "./enrollmentAcknowledgement"

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function stream(read: () => Promise<Uint8Array>) {
  return { read: vi.fn(read), send: vi.fn(async () => undefined), closeSend: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) }
}

describe("enrollment acknowledgement proof service", () => {
  const secret = "enrollment-secret"

  it("serves a proof request before accepting completion", async () => {
    const accepted = deferred<ReturnType<typeof stream>>()
    const ackFrame = deferred<Uint8Array>()
    const served = deferred<void>()
    const ack = stream(() => ackFrame.promise)
    const proof = stream(async () => new Uint8Array([1]))
    const connection = { acceptStream: vi.fn(() => accepted.promise) } as unknown as SyncConnection
    const serveProofPage = vi.fn(async () => { served.resolve(); return true })
    const pending = awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => undefined)

    accepted.resolve(proof)
    await served.promise
    ackFrame.resolve(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
    await expect(pending).resolves.toBeUndefined()
    expect(serveProofPage).toHaveBeenCalledOnce()
    expect(serveProofPage).toHaveBeenCalledWith(new Uint8Array([1]), proof, secret, expect.any(Function))
  })

  it("returns on completion without waiting for an idle acceptStream", async () => {
    const ack = stream(async () => encodePairingFrame("enroll-complete", secret, new Uint8Array()))
    const connection = { acceptStream: vi.fn(() => new Promise(() => {})) } as unknown as SyncConnection
    const serveProofPage = vi.fn()

    await expect(awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => undefined))
      .resolves.toBeUndefined()
    expect(serveProofPage).not.toHaveBeenCalled()
  })

  it("does not serve a proof frame that arrives after completion", async () => {
    const accepted = deferred<ReturnType<typeof stream>>()
    const lateFrame = deferred<Uint8Array>()
    const ack = stream(async () => encodePairingFrame("enroll-complete", secret, new Uint8Array()))
    const proof = stream(() => lateFrame.promise)
    const connection = { acceptStream: vi.fn(() => accepted.promise) } as unknown as SyncConnection
    const serveProofPage = vi.fn(async () => true)
    const pending = awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => undefined)

    accepted.resolve(proof)
    await Promise.resolve()
    await expect(pending).resolves.toBeUndefined()
    lateFrame.resolve(new Uint8Array([1]))
    await vi.waitFor(() => expect(proof.reset).toHaveBeenCalledOnce())

    expect(serveProofPage).not.toHaveBeenCalled()
  })

  it("Given a proof read already in progress, when ACK completes first, then cancel before its late send", async () => {
    const accepted = deferred<ReturnType<typeof stream>>()
    const ackFrame = deferred<Uint8Array>()
    const sourceRead = deferred<void>()
    const releaseSourceRead = deferred<void>()
    const ack = stream(() => ackFrame.promise)
    const proof = stream(async () => new Uint8Array([1]))
    const connection = { acceptStream: vi.fn(() => accepted.promise) } as unknown as SyncConnection
    let sent = false
    const serveProofPage = vi.fn(async (_frame: Uint8Array, _stream: unknown, _secret: string,
      ensureCurrent: () => void | Promise<void>) => {
      sourceRead.resolve()
      await releaseSourceRead.promise
      await ensureCurrent()
      sent = true
      return true
    })
    const pending = awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => undefined)

    accepted.resolve(proof)
    await sourceRead.promise
    ackFrame.resolve(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
    await expect(pending).resolves.toBeUndefined()
    releaseSourceRead.resolve()
    await vi.waitFor(() => expect(sent).toBe(false))
    expect(serveProofPage).toHaveBeenCalledOnce()
    expect(serveProofPage.mock.calls[0]?.[3]).toEqual(expect.any(Function))
  })

  it("resets a proof stream whose send is still pending when completion wins", async () => {
    const accepted = deferred<ReturnType<typeof stream>>()
    const ackFrame = deferred<Uint8Array>()
    const sendStarted = deferred<void>()
    const releaseSend = deferred<void>()
    const ack = stream(() => ackFrame.promise)
    let reset = false
    let sent = false
    const proof = { read: vi.fn(async () => new Uint8Array([1])),
      send: vi.fn(async () => { sendStarted.resolve(); await releaseSend.promise; if (reset) throw new Error("Stream reset") }),
      closeSend: vi.fn(async () => undefined), reset: vi.fn(async () => { reset = true }) }
    const connection = { acceptStream: vi.fn(() => accepted.promise) } as unknown as SyncConnection
    const serveProofPage = vi.fn(async (_frame: Uint8Array, incoming: { send(bytes: Uint8Array): Promise<void> }, _secret: string,
      ensureCurrent: () => void | Promise<void>) => {
      await ensureCurrent()
      await incoming.send(new Uint8Array([2]))
      sent = true
      return true
    })
    const pending = awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => undefined)

    accepted.resolve(proof as unknown as ReturnType<typeof stream>)
    await sendStarted.promise
    ackFrame.resolve(encodePairingFrame("enroll-complete", secret, new Uint8Array()))
    await expect(pending).resolves.toBeUndefined()
    releaseSend.resolve()
    await vi.waitFor(() => expect(proof.reset).toHaveBeenCalledOnce())
    expect(sent).toBe(false)
  })

  it("rejects cancellation before serving an incoming request", async () => {
    const accepted = deferred<ReturnType<typeof stream>>()
    const ack = stream(async () => new Promise(() => {}))
    const proof = stream(async () => new Uint8Array([1]))
    const connection = { acceptStream: vi.fn(() => accepted.promise) } as unknown as SyncConnection
    const serveProofPage = vi.fn(async () => true)
    let active = true
    const pending = awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => {
      if (!active) throw new Error("Enrollment session changed")
    })

    active = false
    accepted.resolve(proof)
    await expect(pending).rejects.toThrow("Enrollment session changed")
    expect(serveProofPage).not.toHaveBeenCalled()
  })

  it("rejects an accepted stream that is not a proof-page request", async () => {
    const accepted = deferred<ReturnType<typeof stream>>()
    const ack = stream(async () => new Promise(() => {}))
    const unknown = stream(async () => encodePairingFrame("enroll-request", secret, new Uint8Array()))
    const connection = { acceptStream: vi.fn(() => accepted.promise) } as unknown as SyncConnection
    const serveProofPage = vi.fn(async () => false)
    const pending = awaitEnrollmentAcknowledgement(connection, ack, { serveProofPage } as never, secret, () => undefined)

    accepted.resolve(unknown)
    await expect(pending).rejects.toThrow()
    expect(serveProofPage).toHaveBeenCalledOnce()
  })
})
