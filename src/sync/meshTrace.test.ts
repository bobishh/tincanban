import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearMeshTrace, meshTrace, meshTraceSnapshot, setMeshTraceVerboseLogging } from "./meshTrace"

const { record, consent } = vi.hoisted(() => ({ record: vi.fn(), consent: { enabled: true } }))
vi.mock("./telemetry", () => ({ record }))
vi.mock("./telemetryConfig", () => ({ telemetryConfig: () => consent }))

describe("mesh trace", () => {
  beforeEach(() => {
    clearMeshTrace()
    setMeshTraceVerboseLogging(false)
    record.mockReset()
    consent.enabled = true
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it("Given normal diagnostic consent, when a board connection is prepared, then export its correlation once without enabling packet logging", async () => {
    vi.stubGlobal("window", {})
    meshTrace("credential.prepared", { workspaceId: "board-a", localDeviceId: "phone-a", credentialId: "fingerprint-a" })
    meshTrace("gossip.packet", { workspaceId: "board-a" })
    await vi.dynamicImportSettled()
    expect(record).toHaveBeenCalledOnce()
    expect(record.mock.calls[0]?.[0]).toBe("credential.prepared")
  })

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
    setMeshTraceVerboseLogging(true)
    const detailError = new TypeError("detail failure")
    const explicitError = new RangeError("explicit failure")

    meshTrace("workspace.replica.failed", { error: detailError }, "warn")
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    expect(record.mock.calls[0]?.[1]).toMatchObject({ error: detailError })

    meshTrace("workspace.replica.failed", { error: detailError }, "warn", explicitError)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(record.mock.calls[1]?.[1]).toMatchObject({ error: explicitError })
  })

  it("Given ordinary consenting browsing, when a session fails and reconnects, then export correlated incidents without packet detail", async () => {
    vi.stubGlobal("window", {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const correlation = { workspaceId: "workspace-a", peerId: "peer-b", tabId: "tab-a", runId: 3, instanceId: "slot-0" }
    meshTrace("gossip.packet", correlation)
    meshTrace("session.heartbeat.failed", { ...correlation, connectionId: "out-7", reason: "connection lost" }, "warn")
    meshTrace("session.closed", { ...correlation, connectionId: "out-7", cause: "heartbeat failed" })
    meshTrace("session.started", { ...correlation, connectionId: "in-8", direction: "incoming" })
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3))
    expect(record.mock.calls.map(call => call[0])).toEqual(["session.heartbeat.failed", "session.closed", "session.started"])
    expect(record.mock.calls[0]?.[1]).toMatchObject({ ...correlation, connectionId: "out-7", error: expect.objectContaining({ message: "connection lost" }) })
  })

  it("Given a repeated failure storm, when the minute budget fills, then preserve local events and export suppression evidence in the next window", async () => {
    vi.stubGlobal("window", {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    for (let index = 0; index < 160; index++) meshTrace("dial.failed", { connectionId: `out-${index}` }, "warn")
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(120))
    expect(record).toHaveBeenCalledTimes(120)
    expect(meshTraceSnapshot()).toHaveLength(160)
    expect(warn).toHaveBeenCalledTimes(120)
    now.mockReturnValue(61_001)
    meshTrace("session.started", { connectionId: "in-recovered" })
    meshTrace("dial.failed", { connectionId: "out-next-window" }, "warn")
    expect(warn).toHaveBeenCalledTimes(122)
    expect(warn.mock.calls.at(-2)?.[0]).toContain('"suppressedCount":40')
    await vi.dynamicImportSettled()
    expect(record.mock.calls.slice(-3).map(call => call[0])).toEqual(["mesh.diagnostics.suppressed", "session.started", "dial.failed"])
    expect(record.mock.calls.at(-3)?.[1]).toMatchObject({ suppressedCount: 40 })
  })

  it("Given explicit sync debugging, when a warning storm occurs, then retain every console warning and snapshot", () => {
    vi.stubGlobal("window", {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    setMeshTraceVerboseLogging(true)
    for (let index = 0; index < 160; index++) meshTrace("dial.failed", { connectionId: `out-${index}` }, "warn")
    expect(warn).toHaveBeenCalledTimes(160)
    expect(meshTraceSnapshot()).toHaveLength(160)
  })

  it("Given device opt-out, when incidents occur, then do not load/export diagnostics or consume the next consenting budget", async () => {
    vi.stubGlobal("window", {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    consent.enabled = false
    for (let index = 0; index < 160; index++) meshTrace("dial.failed", {}, "warn")
    await vi.dynamicImportSettled()
    expect(record).not.toHaveBeenCalled()
    consent.enabled = true
    meshTrace("session.started")
    await vi.dynamicImportSettled()
    expect(record).toHaveBeenCalledTimes(1)
  })
})

it("Given ordinary browsing, when repeated Iroh activity is traced, then snapshots remain local and no telemetry is exported", async () => {
  vi.stubGlobal("window", {})
  setMeshTraceVerboseLogging(false)
  record.mockReset()
  for (let i = 0; i < 100; i++) meshTrace("gossip.packet", { neighbors: 1 })
  await vi.dynamicImportSettled()
  expect(record).not.toHaveBeenCalled()
  expect(meshTraceSnapshot().at(-1)?.event).toBe("gossip.packet")
  vi.unstubAllGlobals()
})

it("Given explicit sync debugging, when tracing is disabled again, then export stops immediately", async () => {
  vi.stubGlobal("window", {})
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  record.mockReset()
  setMeshTraceVerboseLogging(true)
  meshTrace("debug.enabled")
  await vi.dynamicImportSettled()
  expect(record).toHaveBeenCalledTimes(1)
  setMeshTraceVerboseLogging(false)
  meshTrace("debug.disabled")
  await vi.dynamicImportSettled()
  expect(record).toHaveBeenCalledTimes(1)
  info.mockRestore()
  vi.unstubAllGlobals()
})
