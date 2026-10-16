import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearMeshTrace, meshTrace, meshTraceSnapshot, setMeshTraceVerboseLogging } from "./meshTrace"

const { record } = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock("./telemetry", () => ({ record }))

describe("mesh trace", () => {
  beforeEach(() => {
    clearMeshTrace()
    setMeshTraceVerboseLogging(false)
    record.mockReset()
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it("keeps routine gossip out of the console by default while retaining it for diagnostic snapshots", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    meshTrace("gossip.packet", { workspaceId: "workspace-a", neighbors: 1 })
    meshTrace("session.receive.failed", { connectionId: "in-7", reason: "connection lost" }, "warn")

    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(meshTraceSnapshot()).toEqual([
      expect.objectContaining({ event: "gossip.packet", level: "info", workspaceId: "workspace-a" }),
      expect.objectContaining({ event: "session.receive.failed", level: "warn", connectionId: "in-7" }),
    ])
  })

  it("writes routine mesh detail to the console only when verbose logging is enabled", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})

    setMeshTraceVerboseLogging(true)
    meshTrace("gossip.broadcast", { workspaceId: "workspace-a", neighbors: 1 })

    expect(info).toHaveBeenCalledOnce()
  })

  it("Given a connection lifecycle, when events are traced, then ordered correlation data remains inspectable", () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})

    meshTrace("node.start", { tabId: "tab-1", runId: 3, endpoint: "endpoint-a" })
    meshTrace("dial.start", { tabId: "tab-1", runId: 3, connectionId: "c-1", peerId: "peer-b", mode: "relay" })
    meshTrace("session.closed", { tabId: "tab-1", runId: 3, connectionId: "c-1", peerId: "peer-b", reason: "connection lost" }, "warn")

    expect(meshTraceSnapshot()).toEqual([
      expect.objectContaining({ sequence: 1, event: "node.start", tabId: "tab-1", runId: 3 }),
      expect.objectContaining({ sequence: 2, event: "dial.start", connectionId: "c-1", mode: "relay" }),
      expect.objectContaining({ sequence: 3, event: "session.closed", reason: "connection lost", level: "warn" }),
    ])
  })

  it("Given more than the trace limit, when inspected, then only the newest bounded events remain", () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    for (let index = 0; index < 520; index += 1) meshTrace("heartbeat", { index })

    const events = meshTraceSnapshot()
    expect(events).toHaveLength(500)
    expect(events[0]?.index).toBe(20)
    expect(events.at(-1)?.index).toBe(519)
  })

  it("Given an error supplied in detail, When meshTrace forwards telemetry, Then retain it unless explicit error overrides it", async () => {
    vi.stubGlobal("window", {})
    const detailError = new TypeError("detail failure")
    const explicitError = new RangeError("explicit failure")

    meshTrace("workspace.replica.failed", { error: detailError }, "warn")
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    expect(record.mock.calls[0]?.[1]).toMatchObject({ error: detailError })

    meshTrace("workspace.replica.failed", { error: detailError }, "warn", explicitError)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(record.mock.calls[1]?.[1]).toMatchObject({ error: explicitError })
  })
})
