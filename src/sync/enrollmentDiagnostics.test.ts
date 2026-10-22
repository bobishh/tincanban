import { afterEach, expect, it, vi } from "vitest"
import type { Context } from "@opentelemetry/api"
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { createDeviceEnrollmentInvite, parseInvitation } from "@meta-uber/mesh-pairing"
import { BrowserOtelSdk } from "./otelBrowserSdk"
import { telemetryConfig } from "./telemetryConfig"
import { clearDiagnosticContinuation } from "./diagnosticTraceContext"
import { reactive } from "vue"

const active = vi.hoisted(() => ({ sdk: undefined as BrowserOtelSdk | undefined }))
vi.mock("./telemetry", () => ({
  beginDiagnosticOperation: async (name: string, attributes: Record<string, string | number>, parent?: Context) => {
    const sdk = active.sdk!
    const operation = sdk.startOperation(name, attributes, performance.now(), parent)!
    return { context: operation.context, traceparent: operation.traceparent,
      end: (error?: unknown) => sdk.finishOperation(operation.span, operation.context, name, attributes, performance.now(), error) }
  },
  traceDiagnosticOperation: async (_name: string, _attributes: unknown, operation: (parent?: Context) => unknown, parent?: Context) => operation(parent),
  record: (event: string, detail: Record<string, unknown>, level: string, context?: Context) => {
    active.sdk!.emit({ event, detail, level, context, timestamp: Date.now() })
  },
}))

import { beginEnrollmentDiagnostic, captureEnrollmentDiagnosticContext, endEnrollmentDiagnostic,
  enrollmentDiagnosticUrl, traceEnrollment, traceEnrollmentOperation } from "./enrollmentDiagnostics"

afterEach(() => { clearDiagnosticContinuation(); vi.unstubAllGlobals(); active.sdk = undefined })

it("Given an owner invitation, when another browser enrolls then sends Rusty HTTP, then preserve one trace without changing enrollment data or exporting secrets", async () => {
  const exporters = { logs: new InMemoryLogRecordExporter(), traces: new InMemorySpanExporter() }
  const config = { ...telemetryConfig(), enabled: true, browserKey: "public-browser-fixture-key-0123456789" }
  const host = new BrowserOtelSdk(config, () => {}, exporters)
  const guestExporters = { logs: new InMemoryLogRecordExporter(), traces: new InMemorySpanExporter() }
  const guest = new BrowserOtelSdk(config, () => {}, guestExporters)
  try {
    active.sdk = host
    const invite = createDeviceEnrollmentInvite("endpoint", "private-pairing-secret", {
      identity: { personId: "owner" }, device: { deviceId: "host", publicKey: "public-key" } })
    await beginEnrollmentDiagnostic(invite, "host")
    const url = enrollmentDiagnosticUrl("https://board.example", invite)
    const received = parseInvitation(url)
    expect(received).toEqual(invite)
    if (received.kind !== "device-enrollment") throw new Error("Wrong invitation kind")
    active.sdk = guest
    captureEnrollmentDiagnosticContext(received, url)
    await beginEnrollmentDiagnostic(reactive(received), "guest")
    traceEnrollment(received, "guest", "approved", 1)
    await traceEnrollmentOperation(received, "guest.status", context => {
      const request = guest.beginHttp("HTTP_POST", {}, context)
      expect(request.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      request.end(undefined, 200)
    })
    endEnrollmentDiagnostic(received)
    endEnrollmentDiagnostic(invite)
    await Promise.all([host.forceFlush(), guest.forceFlush()])
    const ownerSpan = exporters.traces.getFinishedSpans().find(span => span.name === "enrollment.host")!
    const phoneSpan = guestExporters.traces.getFinishedSpans().find(span => span.name === "enrollment.guest")!
    expect(phoneSpan.parentSpanContext?.spanId).toBe(ownerSpan.spanContext().spanId)
    const traceId = ownerSpan.spanContext().traceId
    expect(guestExporters.traces.getFinishedSpans().every(span => span.spanContext().traceId === traceId)).toBe(true)
    expect(guestExporters.logs.getFinishedLogRecords().at(-1)?.spanContext?.traceId).toBe(traceId)
    const exported = { spans: exporters.traces.getFinishedSpans().map(span => ({ attributes: span.attributes, events: span.events })),
      logs: guestExporters.logs.getFinishedLogRecords().map(log => ({ body: log.body, attributes: log.attributes })) }
    expect(JSON.stringify(exported)).not.toContain(invite.secret)
  } finally { await Promise.all([host.shutdown(), guest.shutdown()]) }
})
