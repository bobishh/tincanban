import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { beginIdentityBrowserSignInDiagnostic } from "./identityBrowserSignIn"

const diagnostics = vi.hoisted(() => ({ begin: vi.fn(), flush: vi.fn(), record: vi.fn(), end: vi.fn() }))
vi.mock("../sync/telemetry", () => ({ record: diagnostics.record, beginDiagnosticOperation: diagnostics.begin,
  flushTelemetryBeforeNavigation: diagnostics.flush }))
const traceId = "1234567890abcdef1234567890abcdef"
let saved: Map<string, string>

beforeEach(() => {
  saved = new Map()
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) })
  diagnostics.begin.mockReset()
  diagnostics.flush.mockReset()
  diagnostics.record.mockReset()
  diagnostics.end.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it("Given an Identity redirect, when the app reloads for its callback, then both phases share one trace without persisting authorization data", async () => {
  diagnostics.begin.mockImplementation(async (name: string) => {
    const contexts = await import("../sync/diagnosticTraceContext")
    if (name.endsWith("callback")) expect(contexts.diagnosticTraceparent(contexts.diagnosticContinuation())?.split("-")[1]).toBe(traceId)
    const spanContext = { traceId, spanId: name.endsWith("request") ? "1234567890abcdef" : "abcdef1234567890", traceFlags: 1 }
    return { context: trace.setSpanContext(ROOT_CONTEXT, spanContext), end: diagnostics.end }
  })
  const request = await beginIdentityBrowserSignInDiagnostic("request")
  request.end()
  vi.resetModules()
  const reloaded = await import("./identityBrowserSignIn")
  const callback = await reloaded.beginIdentityBrowserSignInDiagnostic("callback")
  callback.end()
  const contexts = await import("../sync/diagnosticTraceContext")
  expect(contexts.diagnosticTraceparent(contexts.diagnosticContinuation())?.split("-")[1]).toBe(traceId)
  const carrier = JSON.parse([...saved.values()][0]!)
  expect(Object.keys(carrier).sort()).toEqual(["expiresAt", "traceparent"])
  expect(diagnostics.end).toHaveBeenCalledTimes(2)
})

it("Given diagnostics cannot start, when sign-in starts, then diagnostics do not prevent authorization", async () => {
  diagnostics.begin.mockRejectedValue(new Error("collector unavailable"))
  const operation = await beginIdentityBrowserSignInDiagnostic("request")
  expect(() => operation.end()).not.toThrow()
  await expect(operation.beforeRedirect()).resolves.toBeUndefined()
  expect(diagnostics.flush).not.toHaveBeenCalled()
})

it("Given an active request diagnostic, when redirect is requested, then end its span before the bounded exporter flush", async () => {
  const order: string[] = []
  diagnostics.begin.mockResolvedValue({ end: () => { order.push("end") } })
  diagnostics.flush.mockImplementation(async () => { order.push("flush") })
  const operation = await beginIdentityBrowserSignInDiagnostic("request")

  await operation.beforeRedirect()

  expect(order).toEqual(["end", "flush"])
})
