import { describe, expect, it } from "vitest"
import { controlFrames, ControlFrameReceiver } from "./controlFrames"

const snapshot = () => new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "w", chat: "x".repeat(300_000) }))
const rewrite = (bytes: Uint8Array, changes: object) => new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), ...changes }))

describe("bounded control snapshots", () => {
  it("withholds incomplete snapshots and reassembles out-of-order parts exactly", () => {
    const bytes = snapshot()
    const parts = [...controlFrames("w", bytes)].reverse()
    const receiver = new ControlFrameReceiver("w")
    for (const part of parts.slice(0, -1)) expect(receiver.receive(part)).toBeUndefined()
    expect(receiver.receive(parts.at(-1)!)).toEqual(bytes)
  })

  it.each([{ workspaceId: "other" }, { totalBytes: 25 * 1024 * 1024 }, { index: -1 }, { data: "AA" }])(
    "rejects invalid chunk metadata or length: %j", changes => {
      const part = [...controlFrames("w", snapshot())][0]!
      expect(() => new ControlFrameReceiver("w").receive(rewrite(part, changes))).toThrow(/Invalid/)
    })

  it("rejects duplicates and overlapping transfers instead of growing the receive buffer", () => {
    const part = [...controlFrames("w", snapshot())][0]!
    const receiver = new ControlFrameReceiver("w")
    receiver.receive(part)
    expect(() => receiver.receive(part)).toThrow(/Conflicting/)
    const overlapping = new ControlFrameReceiver("w")
    overlapping.receive(part)
    expect(() => overlapping.receive(rewrite(part, { transferId: crypto.randomUUID() }))).toThrow(/Conflicting/)
  })

  it("rejects oversized physical frames and logical snapshots", () => {
    expect(() => new ControlFrameReceiver("w").receive(new Uint8Array(256 * 1024 + 1))).toThrow(/size limit/)
    expect(() => [...controlFrames("w", new Uint8Array(24 * 1024 * 1024 + 1))]).toThrow(/size limit/)
  })
})
