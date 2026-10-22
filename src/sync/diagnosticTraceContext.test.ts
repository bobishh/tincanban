import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { trace } from "@opentelemetry/api"
import { clearDiagnosticContinuation, diagnosticContinuation, diagnosticTraceparent,
  readDiagnosticTraceparent, rememberDiagnosticContinuation } from "./diagnosticTraceContext"

const carrier = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01"
beforeEach(() => {
  clearDiagnosticContinuation()
  const values = new Map<string, string>()
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
})
afterEach(() => { clearDiagnosticContinuation(); vi.unstubAllGlobals(); vi.useRealTimers() })

it("Given a diagnostic carrier, when it crosses devices, then preserve the remote trace and parent without carrying invitation secrets", () => {
  const context = readDiagnosticTraceparent(carrier)!
  expect(trace.getSpanContext(context)).toMatchObject({ traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef", isRemote: true })
  expect(diagnosticTraceparent(context)).toBe(carrier)
})

it.each([undefined, "", "invalid", carrier.replace("1234567890abcdef1234567890abcdef", "0".repeat(32)),
  carrier.replace("-1234567890abcdef-", `-${"0".repeat(16)}-`), `${carrier} private`, carrier.replace("-01", "-ff")])(
  "Given an absent or invalid trace carrier, when decoded, then ignore it", value => {
    expect(readDiagnosticTraceparent(value)).toBeUndefined()
  })

it("Given enrollment state followed by a reload, when diagnostics resume in the same tab, then retain its trace only for the bounded continuation window", async () => {
  vi.useFakeTimers()
  rememberDiagnosticContinuation(readDiagnosticTraceparent(carrier))
  vi.resetModules()
  const reloaded = await import("./diagnosticTraceContext")
  expect(reloaded.diagnosticTraceparent(reloaded.diagnosticContinuation())).toBe(carrier)
  await vi.advanceTimersByTimeAsync(30 * 60_000 + 1)
  expect(reloaded.diagnosticContinuation()).toBeUndefined()
})

it("Given remembered diagnostics, when consent is cleared, then no continuation survives", () => {
  rememberDiagnosticContinuation(readDiagnosticTraceparent(carrier))
  expect(diagnosticContinuation()).toBeDefined()
  clearDiagnosticContinuation()
  expect(diagnosticContinuation()).toBeUndefined()
})
