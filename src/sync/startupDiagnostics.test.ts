import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { TelemetryEvent } from "./telemetryEvent"

type Batch = { events: TelemetryEvent[] }

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("VITE_STARTUP_DIAGNOSTICS", "1")
  vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "https://collector.invalid/events")
  vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "public-browser-fixture-key-0123456789")
  vi.stubEnv("VITE_SYNC_TELEMETRY_LEVEL", "errors")
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal("navigator", { onLine: true, userAgent: "iPhone Version/18.0 Mobile Safari/604.1" })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it("Given an unavailable diagnostic chunk, When startup runs, Then local work continues", async () => {
  vi.doMock("./startupDiagnosticsTransport", () => { throw new Error("Diagnostic chunk unavailable") })
  try {
    const { beginStartupDiagnostics, diagnoseStartupStep } = await import("./startupDiagnostics")
    await expect(beginStartupDiagnostics()).resolves.toBeUndefined()
    await expect(diagnoseStartupStep("history-load", () => "usable")).resolves.toBe("usable")
  } finally { vi.doUnmock("./startupDiagnosticsTransport") }
})

it("Given errors-only telemetry and a heavy startup step, When debug is enabled, Then the start checkpoint is dispatched before computation and typed counts survive", async () => {
  const order: string[] = []
  const bodies: Batch[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body)
    bodies.push(body)
    order.push(body.events[0].event)
    return Response.json({ accepted: 1 })
  }))
  const { diagnoseStartupStep, setStartupDiagnosticDevice } = await import("./startupDiagnostics")
  setStartupDiagnosticDevice("device-a")
  expect(await diagnoseStartupStep("history-load", async () => { order.push("compute"); return 42 }, { operationCount: 312613, bytes: 135109, body: "private-body" })).toBe(42)
  expect(order).toEqual(["startup.phase.started", "compute", "startup.phase.completed"])
  expect(bodies[0].events[0]).toMatchObject({ device_id: "device-a", component: "startup", attrs: { stage: "history-load", operation_count: 312613, bytes: 135109, browser: "safari", platform: "ios" } })
  expect(JSON.stringify(bodies)).not.toContain("private-body")
})

it("Given an intake awaiting acknowledgement, When startup runs, Then local work completes while both checkpoints remain in flight", async () => {
  let acknowledge!: (response: Response) => void
  const response = new Promise<Response>(resolve => { acknowledge = resolve })
  const bodies: Batch[] = []
  vi.stubGlobal("fetch", vi.fn((_url, options) => { bodies.push(JSON.parse(options.body)); return response }))
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  let result: string | undefined
  const startup = diagnoseStartupStep("history-load", () => "usable").then(value => { result = value })
  try {
    await vi.waitFor(() => expect(result).toBe("usable"), { timeout: 200 })
    expect(bodies.map(body => body.events[0].event)).toEqual(["startup.phase.started", "startup.phase.completed"])
  } finally {
    acknowledge(Response.json({ accepted: 1 }))
    await startup
  }
})

it("Given a startup failure, When the stage throws, Then diagnostics identify the stage and error type without transmitting raw error content", async () => {
  const bodies: Batch[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json({ accepted: 1 }) }))
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  await expect(diagnoseStartupStep("policy-wasm", () => { throw new TypeError("private-token-in-message") })).rejects.toThrow("private-token-in-message")
  expect(bodies.at(-1)!.events[0]).toMatchObject({ event: "startup.phase.failed", status: "error", attrs: { stage: "policy-wasm", error_code: "type_error" } })
  expect(JSON.stringify(bodies)).not.toContain("private-token")
})

it.each(["disabled", "opted-out", "collector-down"])("Given %s diagnostics, When startup runs, Then diagnostics cannot prevent local work", async mode => {
  if (mode === "disabled") vi.stubEnv("VITE_STARTUP_DIAGNOSTICS", "0")
  if (mode === "opted-out") localStorage.setItem("tincanban.telemetry.enabled.v1", "false")
  const fetch = vi.fn().mockRejectedValue(new Error("offline"))
  vi.stubGlobal("fetch", fetch)
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  await expect(diagnoseStartupStep("history-load", async () => "usable")).resolves.toBe("usable")
  if (mode !== "collector-down") expect(fetch).not.toHaveBeenCalled()
})
