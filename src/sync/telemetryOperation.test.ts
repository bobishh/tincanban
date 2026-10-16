import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ brokenStart: false, brokenEnd: false, starts: 0, queued: 0 }))
vi.mock("./otelBrowserSdk", () => ({ BrowserOtelSdk: class {
  exportState = { sending: 0, queued: 0, lastSentAt: null, error: "" }
  emit() {}
  operation() { state.queued++ }
  startOperation() { state.starts++; if (state.brokenStart) throw new Error("SDK failed"); return { span: {}, context: {} } }
  finishOperation() { if (state.brokenEnd) throw new Error("SDK failed") }
  shutdown() { return Promise.resolve() }
  beginHttp() { return { headers: {}, end() {} } }
} }))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("optional operation diagnostics", () => {
  it("Given no telemetry endpoint or key, When traced application work runs, Then diagnostics disable without affecting the result", async () => {
    vi.resetModules()
    vi.stubGlobal("localStorage", { getItem: () => null })
    vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "")
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "")
    vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const config = await import("./telemetryConfig")
    const { traceDiagnosticOperation, telemetryStatus } = await import("./telemetry")
    expect(config.telemetryConfig().enabled).toBe(false)
    await expect(traceDiagnosticOperation("workspace.save", {}, () => "saved")).resolves.toBe("saved")
    expect(telemetryStatus().state).toBe("disabled")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("Given a broken diagnostic SDK, When application work succeeds or fails, Then preserve its result and original error", async () => {
    vi.resetModules()
    vi.stubGlobal("localStorage", { getItem: () => null })
    vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "https://collector.invalid/events")
    vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "public-browser-fixture-key-0123456789")
    const { traceDiagnosticOperation } = await import("./telemetry")
    await vi.waitFor(() => expect(traceDiagnosticOperation).toBeTypeOf("function"))
    await new Promise(resolve => setTimeout(resolve, 0))
    state.brokenStart = true
    await expect(traceDiagnosticOperation("save", {}, async () => "saved")).resolves.toBe("saved")
    state.brokenStart = false
    state.brokenEnd = true
    await expect(traceDiagnosticOperation("save", {}, async () => "saved")).resolves.toBe("saved")
    const original = new TypeError("storage failed")
    await expect(traceDiagnosticOperation("save", {}, async () => { throw original })).rejects.toBe(original)
  })
})
