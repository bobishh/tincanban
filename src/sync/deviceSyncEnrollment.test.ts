import { afterEach, describe, expect, it, vi } from "vitest"
import type { DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { decodePairingFrame, encodePairingFrame } from "@meta-uber/mesh-pairing"
import { dialEnrollmentPeer, sendEnrollmentRejection } from "./deviceSyncEnrollment"
import type { SyncConnection, SyncNode } from "./transport"
import { meshTraceSnapshot } from "./meshTrace"
import * as telemetry from "./telemetry"

const connection = (): SyncConnection => ({
  openStream: vi.fn(),
  acceptStream: vi.fn(),
  close: vi.fn(async () => undefined),
})

const invitation = {
  issuerEndpoint: "owner-endpoint",
} as DeviceEnrollmentInvitation

describe("device enrollment dialing", () => {
  afterEach(() => vi.useRealTimers())

  it("Given normal diagnostics without a URL flag, when enrollment dials, then export the exact phase without invitation secrets", async () => {
    const record = vi.spyOn(telemetry, "record").mockImplementation(() => {})
    const node = { dial: vi.fn(async () => connection()), dialRelay: vi.fn() } as unknown as SyncNode
    try {
      await dialEnrollmentPeer({ currentRun: () => 21 } as never, 21, node,
        { ...invitation, secret: "private-invitation-value" })
      expect(record).toHaveBeenCalledWith("enrollment.guest.dial.started", expect.objectContaining({ phase: "guest.dial.started" }), "info")
      expect(JSON.stringify(record.mock.calls)).not.toContain("private-invitation-value")
    } finally { record.mockRestore() }
  })

  it("closes a late losing direct connection without closing the relay winner", async () => {
    vi.useFakeTimers()
    const directConnection = connection()
    const relayConnection = connection()
    let finishDirect!: (value: SyncConnection) => void
    const node = {
      dial: vi.fn(() => new Promise<SyncConnection>(resolve => { finishDirect = resolve })),
      dialRelay: vi.fn(async () => relayConnection),
    } as unknown as SyncNode
    const pending = dialEnrollmentPeer({ currentRun: () => 1 } as never, 1, node, invitation)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).toBe(relayConnection)
    finishDirect(directConnection)
    await vi.advanceTimersByTimeAsync(0)

    expect(directConnection.close).toHaveBeenCalledOnce()
    expect(relayConnection.close).not.toHaveBeenCalled()
  })

  it("retries direct after discovery recovers even when relay stays unavailable", async () => {
    const winner = connection()
    const node = {
      dial: vi.fn().mockRejectedValueOnce(new Error("No addressing information available"))
        .mockResolvedValue(winner),
      dialRelay: vi.fn(async () => { throw new Error("relay unavailable") }),
    } as unknown as SyncNode
    const context = { currentRun: () => 8, waitToReconnect: vi.fn(async () => undefined) }

    expect(await dialEnrollmentPeer(context as never, 8, node, invitation)).toBe(winner)
    expect(node.dial).toHaveBeenCalledTimes(2)
    expect(context.waitToReconnect).toHaveBeenCalledTimes(1)
    const failure = meshTraceSnapshot().findLast(event => event.event === "enrollment.guest.dial.failed")
    expect(failure?.reason).toContain("No addressing information available")
    expect(failure?.reason).toContain("relay unavailable")
  })

  it("tries the direct route before falling back to relay", async () => {
    const directConnection = connection()
    const relayConnection = connection()
    const node = {
      dial: vi.fn(async () => directConnection),
      dialRelay: vi.fn(async () => relayConnection),
    } as unknown as SyncNode
    const context = {
      currentRun: () => 7,
      waitToReconnect: vi.fn(async () => undefined),
    }

    const result = await dialEnrollmentPeer(context as never, 7, node, invitation)

    expect(result).toBe(directConnection)
    expect(node.dial).toHaveBeenCalledWith("owner-endpoint")
    expect(node.dialRelay).not.toHaveBeenCalled()
  })

  it("falls back to relay when the direct route cannot connect", async () => {
    const relayConnection = connection()
    const node = {
      dial: vi.fn(async () => { throw new Error("direct route unavailable") }),
      dialRelay: vi.fn(async () => relayConnection),
    } as unknown as SyncNode
    const context = {
      currentRun: () => 3,
      waitToReconnect: vi.fn(async () => undefined),
    }

    const result = await dialEnrollmentPeer(context as never, 3, node, invitation)

    expect(result).toBe(relayConnection)
    expect(node.dial).toHaveBeenCalledWith("owner-endpoint")
    expect(node.dialRelay).toHaveBeenCalledWith("owner-endpoint")
  })
})

describe("enrollment rejection acknowledgement", () => {
  afterEach(() => vi.useRealTimers())

  it("reads the acknowledgement from the same rejection stream", async () => {
    const secret = "rejection-secret"
    const sent: Uint8Array[] = []
    const stream = {
      send: vi.fn(async (frame: Uint8Array) => { sent.push(frame) }),
      closeSend: vi.fn(async () => undefined),
      read: vi.fn(async () => encodePairingFrame("enroll-rejected-ack", secret, new Uint8Array())),
    }
    const peer = { ...connection(), openStream: vi.fn(async () => stream) }

    await expect(sendEnrollmentRejection(peer, secret, new Error("workspace validation failed"))).resolves.toBeUndefined()

    expect(peer.acceptStream).not.toHaveBeenCalled()
    expect(stream.read).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(decodePairingFrame(sent[0]!, "enroll-rejected", secret))).toContain("workspace validation failed")
  })

  it("times out when the same stream does not acknowledge rejection", async () => {
    vi.useFakeTimers()
    const stream = {
      send: vi.fn(async () => undefined), closeSend: vi.fn(async () => undefined),
      read: vi.fn(() => new Promise<Uint8Array>(() => {})),
    }
    const peer = { ...connection(), openStream: vi.fn(async () => stream) }
    const pending = sendEnrollmentRejection(peer, "rejection-secret", new Error("invalid proof"))

    const rejected = expect(pending).rejects.toThrow("Enrollment rejection was not acknowledged")
    await vi.advanceTimersByTimeAsync(12_000)
    await rejected
    expect(peer.acceptStream).not.toHaveBeenCalled()
  })
})
