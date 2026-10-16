import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let storage: Map<string, string>
beforeEach(() => {
  vi.resetModules()
  storage = new Map()
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "https://collector.invalid/events")
  vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "")
  vi.stubEnv("VITE_SYNC_TELEMETRY_PROJECT", "tincanban")
  vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "public-browser-build-fixture")
  vi.stubEnv("VITE_SYNC_TELEMETRY_LEVEL", "all")
  vi.stubEnv("VITE_SYNC_TELEMETRY_SAMPLE_RATE", "0.25")
  vi.stubEnv("VITE_SYNC_TELEMETRY_BATCH_SIZE", "12")
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("deployment telemetry configuration and device consent", () => {
  it("Given application deployment configuration, when loaded, then sampling and batching come from the build", async () => {
    const config = await import("./telemetryConfig")
    expect(config.telemetryConfig()).toMatchObject({ enabled: true, endpoint: "https://collector.invalid/events", logsEndpoint: "https://collector.invalid/v1/logs", tracesEndpoint: "https://collector.invalid/v1/traces", project: "tincanban", sampleRate: 0.25, batchSize: 12 })
  })
  it("Given a dedicated OTLP endpoint, when loaded, then it takes precedence and derives standard signal routes", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.invalid/custom/base")
    const config = await import("./telemetryConfig")
    expect(config.telemetryConfig()).toMatchObject({ logsEndpoint: "https://otel.invalid/custom/base/v1/logs", tracesEndpoint: "https://otel.invalid/custom/base/v1/traces" })
  })
  it("Given only a dedicated OTLP endpoint, when loaded, then it enables the configured exporter without the legacy URL", async () => {
    vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "")
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.invalid/custom/base")
    const config = await import("./telemetryConfig")
    expect(config.telemetryConfig()).toMatchObject({ enabled: true, endpoint: "https://otel.invalid/custom/base",
      logsEndpoint: "https://otel.invalid/custom/base/v1/logs", tracesEndpoint: "https://otel.invalid/custom/base/v1/traces" })
  })
  it("Given legacy device configuration pointing elsewhere, when upgraded, then only explicit disablement survives", async () => {
    storage.set("tincanban.telemetry.v2", JSON.stringify({ enabled: false, endpoint: "https://previous.invalid/events", project: "custom-project", browserKey: "old-browser-fixture-key", level: "errors", sampleRate: 1, batchSize: 50 }))
    const config = await import("./telemetryConfig")
    expect(config.telemetryConfig()).toMatchObject({ enabled: false, endpoint: "https://collector.invalid/events", project: "tincanban", browserKey: "public-browser-build-fixture", level: "all", sampleRate: 0.25, batchSize: 12 })
  })
  it("Given no deployed collector key, when device opts in, then sending cannot be enabled locally", async () => {
    vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "")
    const config = await import("./telemetryConfig")
    expect(config.telemetryConfigured()).toBe(false)
    expect(() => config.setTelemetryEnabled(true)).toThrow("not configured")
    expect(config.telemetryConfig().enabled).toBe(false)
    expect(storage.has("tincanban.telemetry.enabled.v1")).toBe(false)
  })
  it("Given a configured application, when this device opts out and reloads, then only the consent flag is stored", async () => {
    const config = await import("./telemetryConfig")
    config.setTelemetryEnabled(false)
    expect(JSON.parse(storage.get("tincanban.telemetry.enabled.v1")!)).toBe(false)
    vi.resetModules()
    const reloaded = await import("./telemetryConfig")
    expect(reloaded.telemetryConfig()).toMatchObject({ enabled: false, sampleRate: 0.25, batchSize: 12 })
    reloaded.setTelemetryEnabled(true)
    expect(reloaded.telemetryConfig().enabled).toBe(true)
  })
  it.each([
    ["VITE_SYNC_TELEMETRY_SAMPLE_RATE", "NaN"], ["VITE_SYNC_TELEMETRY_SAMPLE_RATE", "1.5"],
    ["VITE_SYNC_TELEMETRY_BATCH_SIZE", "0"], ["VITE_SYNC_TELEMETRY_BATCH_SIZE", "51"],
    ["VITE_SYNC_TELEMETRY_LEVEL", "debug"], ["VITE_SYNC_TELEMETRY_URL", "http://external.invalid/events"],
    ["VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://external.invalid"],
  ])("Given invalid deployment value %s=%s, when loaded, then collection fails closed", async (key, value) => {
    vi.stubEnv(key, value)
    const config = await import("./telemetryConfig")
    expect(config.telemetryConfigured()).toBe(false)
    expect(config.telemetryConfig().enabled).toBe(false)
  })
  it("Given unavailable local storage, when opting out, then the failure is reported without claiming consent was saved", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("full") } })
    const config = await import("./telemetryConfig")
    expect(() => config.setTelemetryEnabled(false)).toThrow("could not be saved")
    expect(config.telemetryConfig().enabled).toBe(true)
  })
})

it("Given distinct analytics and OTLP routes, when configuration loads, then analytics retains its events route", async () => {
  vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.invalid")
  const { telemetryConfig } = await import("./telemetryConfig")
  expect(telemetryConfig()).toMatchObject({ analyticsEndpoint: "https://collector.invalid/events", logsEndpoint: "https://collector.invalid/v1/logs" })
})
