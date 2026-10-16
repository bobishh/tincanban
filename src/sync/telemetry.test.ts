import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let storage: Map<string, string>
beforeEach(() => {
  vi.resetModules()
  storage = new Map()
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "https://collector.invalid/events")
  vi.stubEnv("VITE_SYNC_TELEMETRY_PROJECT", "tincanban")
  vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "public-browser-fixture-key-0123456789")
  vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "")
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("browser diagnostics facade", () => {
  it("Given startup diagnostics are disabled by consent, when recorded, then no export starts", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const config = await import("./telemetryConfig")
    const telemetry = await import("./telemetry")
    config.setTelemetryEnabled(false)
    telemetry.record("chat.persisted", { recordId: "private-message-id" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetch).not.toHaveBeenCalled()
    expect(telemetry.telemetryStatus().state).toBe("disabled")
    expect(telemetry.telemetryStatus().queued).toBe(0)
  })

  it("Given an in-flight diagnostic, when the device opts out, then buffered SDK records are dropped and later records stay disabled", async () => {
    const config = await import("./telemetryConfig")
    const telemetry = await import("./telemetry")
    telemetry.record("sync.phase", { phase: "admission" })
    expect(telemetry.telemetryStatus().queued).toBe(1)
    config.setTelemetryEnabled(false)
    expect(telemetry.telemetryStatus().state).toBe("disabled")
    expect(telemetry.telemetryStatus().queued).toBe(0)
    expect(telemetry.telemetryStatus().dropped).toBe(1)
  })
})
