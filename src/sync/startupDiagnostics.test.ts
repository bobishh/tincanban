import { afterEach, beforeEach, expect, it, vi } from "vitest"

const record = vi.fn()
const traceDiagnosticOperation = vi.fn(async (_name: string, _attributes: unknown, operation: (context?: unknown) => unknown) => await operation({ traceId: "diagnostic-context" }))
beforeEach(() => {
  vi.resetModules()
  record.mockClear()
  traceDiagnosticOperation.mockClear()
  vi.stubEnv("VITE_STARTUP_DIAGNOSTICS", "1")
  vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "https://collector.invalid/events")
  vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "public-browser-fixture-key-0123456789")
  vi.stubEnv("VITE_SYNC_TELEMETRY_LEVEL", "all")
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal("navigator", { onLine: true, userAgent: "iPhone Version/18.0 Mobile Safari/604.1" })
  vi.doMock("./telemetry", () => ({ record, traceDiagnosticOperation }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.doUnmock("./telemetry") })

it("Given an unavailable diagnostic chunk, when startup runs, then local work continues", async () => {
  vi.doMock("./startupDiagnosticsTransport", () => { throw new Error("Diagnostic chunk unavailable") })
  try {
    const { beginStartupDiagnostics, diagnoseStartupStep } = await import("./startupDiagnostics")
    await expect(beginStartupDiagnostics()).resolves.toBeUndefined()
    await expect(diagnoseStartupStep("history-load", () => "usable")).resolves.toBe("usable")
  } finally { vi.doUnmock("./startupDiagnosticsTransport") }
})

it("Given startup diagnostics, when a heavy stage runs, then it is traced and checkpointed without sending a private body", async () => {
  const order: string[] = []
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  expect(await diagnoseStartupStep("history-load", async () => { order.push("compute"); return 42 }, { operationCount: 312613, bytes: 135109, body: "private-body" })).toBe(42)
  expect(order).toEqual(["compute"])
  expect(traceDiagnosticOperation).toHaveBeenCalledWith("startup.history-load", expect.objectContaining({ "startup.stage": "history-load" }), expect.any(Function))
  expect(record.mock.calls.map(call => call[0])).toEqual(["startup.phase.started", "startup.phase.completed"])
})

it("Given a startup failure, when the stage throws, then original error and operation details reach the OTel facade", async () => {
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  const error = new TypeError("private-token-in-message")
  await expect(diagnoseStartupStep("policy-wasm", () => { throw error })).rejects.toBe(error)
  expect(traceDiagnosticOperation).toHaveBeenCalledWith("startup.policy-wasm", expect.any(Object), expect.any(Function))
  expect(record.mock.calls.at(-1)).toMatchObject(["startup.phase.failed", expect.objectContaining({ stage: "policy-wasm", error }), "error"])
})

it("Given OTel supplies an active context, when startup runs a zero-argument stage, then the context is not passed as its optional input", async () => {
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  const step = vi.fn((optionalInput?: unknown) => optionalInput === undefined ? "no-input" : "unexpected-input")
  await expect(diagnoseStartupStep("identity-load", step)).resolves.toBe("no-input")
  expect(step).toHaveBeenCalledWith()
})

it.each(["disabled", "opted-out"]) ("Given %s diagnostics, when startup runs, then local work continues without recording", async mode => {
  if (mode === "disabled") vi.stubEnv("VITE_STARTUP_DIAGNOSTICS", "0")
  if (mode === "opted-out") localStorage.setItem("tincanban.telemetry.enabled.v1", "false")
  const { diagnoseStartupStep } = await import("./startupDiagnostics")
  await expect(diagnoseStartupStep("history-load", async () => "usable")).resolves.toBe("usable")
  expect(record).not.toHaveBeenCalled()
  expect(traceDiagnosticOperation).not.toHaveBeenCalled()
})
