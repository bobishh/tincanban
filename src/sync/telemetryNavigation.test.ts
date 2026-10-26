import { afterEach, beforeEach, expect, it, vi } from "vitest"

const diagnostics = vi.hoisted(() => ({ flush: vi.fn(), emit: vi.fn() }))
vi.mock("./otelBrowserSdk", () => ({ BrowserOtelSdk: class {
  exportState = { sending: 0, queued: 0, dropped: 0, lastSentAt: null, error: "" }
  forceFlush = diagnostics.flush
  emit = diagnostics.emit
} }))

beforeEach(() => {
  vi.resetModules()
  diagnostics.flush.mockReset()
  diagnostics.emit.mockReset()
  vi.stubGlobal("localStorage", { getItem: () => null })
  vi.stubEnv("VITE_SYNC_TELEMETRY_URL", "https://collector.invalid/events")
  vi.stubEnv("VITE_SYNC_TELEMETRY_BROWSER_KEY", "public-browser-fixture-key-0123456789")
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it("Given a same-tab redirect, when diagnostics are queued, then flush them before leaving", async () => {
  let finish!: () => void
  diagnostics.flush.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const { flushTelemetryBeforeNavigation } = await import("./telemetry")
  let ready = false
  const flushing = flushTelemetryBeforeNavigation().then(() => { ready = true })
  await vi.waitFor(() => expect(diagnostics.flush).toHaveBeenCalledOnce())
  expect(ready).toBe(false)
  finish()
  await flushing
  expect(ready).toBe(true)
})

it("Given an unavailable collector, when sign-in redirects, then diagnostics delay it by at most 200 ms", async () => {
  diagnostics.flush.mockReturnValue(new Promise<void>(() => {}))
  const { flushTelemetryBeforeNavigation } = await import("./telemetry")
  vi.useFakeTimers()
  let ready = false
  const flushing = flushTelemetryBeforeNavigation().then(() => { ready = true })
  await vi.advanceTimersByTimeAsync(199)
  expect(ready).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await flushing
  expect(ready).toBe(true)
})

it("Given a failed diagnostic export, when sign-in redirects, then keep sign-in available", async () => {
  diagnostics.flush.mockRejectedValue(new Error("collector unavailable"))
  const { flushTelemetryBeforeNavigation } = await import("./telemetry")
  await expect(flushTelemetryBeforeNavigation()).resolves.toBeUndefined()
})
