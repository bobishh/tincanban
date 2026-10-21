import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { ExportResultCode } from "@opentelemetry/core"
import { telemetryConfig } from "./telemetryConfig"
import { BrowserOtelSdk } from "./otelBrowserSdk"

const pendingServers: Server[] = []
afterEach(async () => {
  await Promise.all(pendingServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

function config() {
  return { ...telemetryConfig(), enabled: true, endpoint: "https://collector.invalid/events", logsEndpoint: "https://collector.invalid/v1/logs", tracesEndpoint: "https://collector.invalid/v1/traces", project: "tincanban", browserKey: "public-browser-fixture-key-0123456789" }
}

describe("browser OTel SDK", () => {
  it("Given split exports in flight, when the device opts out, then no remaining split body starts and only unsent records count as dropped", async () => {
    const deliveries: Array<{ count: number; complete: (result: { code: ExportResultCode }) => void }> = []
    const logs = {
      export: (records: unknown[], complete: (result: { code: ExportResultCode }) => void) => { deliveries.push({ count: records.length, complete }) },
      forceFlush: async () => {}, shutdown: async () => {},
    }
    const sdk = new BrowserOtelSdk(config(), () => {}, { logs, traces: new InMemorySpanExporter() })
    for (let index = 0; index < 8; index++) {
      const error = new Error(`Failure ${index}`)
      error.stack = `Error: Failure ${index}\n${"x".repeat(16300)}`
      sdk.emit({ event: "sync.failed", detail: {}, level: "error", timestamp: Date.now(), exception: error })
    }
    const flushing = sdk.forceFlush()
    await vi.waitFor(() => expect(deliveries).toHaveLength(2))
    const sent = deliveries.reduce((count, delivery) => count + delivery.count, 0)
    const closing = sdk.shutdown()
    // Complete the already-started requests; opting out cannot retract them.
    for (const delivery of deliveries.slice()) delivery.complete({ code: ExportResultCode.SUCCESS })
    // Settle any mistakenly started bodies so a regression cannot strand the test.
    for (const delivery of deliveries.slice(2)) delivery.complete({ code: ExportResultCode.SUCCESS })
    await Promise.all([flushing, closing])
    expect(deliveries).toHaveLength(2)
    expect(sdk.exportState.dropped).toBe(8 - sent)
    expect(sdk.exportState.queued).toBe(0)
    expect(sdk.exportState.sending).toBe(0)
  })

  it("Given long multibyte errors, when logs and spans flush, then each OTLP body fits intake and all correlated failures arrive", async () => {
    const requests: Array<{ bytes: number; path: string; payload: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        const data = Buffer.concat(chunks)
        requests.push({ bytes: data.byteLength, path: request.url ?? "", payload: JSON.parse(data.toString("utf8")) as Record<string, unknown> })
        response.writeHead(data.byteLength > 65_536 ? 413 : 200, { "Content-Type": "application/json" })
        response.end("{}")
      })
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    pendingServers.push(server)
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const sdk = new BrowserOtelSdk({ ...config(), logsEndpoint: `${endpoint}/v1/logs`, tracesEndpoint: `${endpoint}/v1/traces` }, () => {})
    try {
      for (let index = 0; index < 50; index++) {
        const error = new Error(`Connection failed ${index}`)
        error.stack = `Error: Connection failed ${index}\n${"🔥 at syntheticFrame (transport.ts:1:1)\n".repeat(470)}`
        const startedAt = performance.now()
        sdk.operation({ name: "sync.burst", attributes: { workspaceId: "board-test", entityId: `failure-${index}` }, startedAt, endedAt: startedAt + 1, exception: error })
      }
      await sdk.forceFlush()
      expect(Math.max(...requests.map(request => request.bytes))).toBeLessThanOrEqual(65_536)
      const logs = requests.filter(request => request.path.endsWith("logs")).flatMap(request => (request.payload.resourceLogs as Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>).flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords)))
      const spans = requests.filter(request => request.path.endsWith("traces")).flatMap(request => (request.payload.resourceSpans as Array<{ scopeSpans: Array<{ spans: unknown[] }> }>).flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)))
      expect(logs).toHaveLength(50)
      expect(spans).toHaveLength(50)
      expect(sdk.exportState.dropped).toBe(0)
      expect(sdk.exportState.queued).toBe(0)
      expect(sdk.exportState.sending).toBe(0)
    } finally { await sdk.shutdown() }
  })

  it("Given a real exception and operation, when SDK records flush, then OTel resources, exception causes and generated trace IDs survive", async () => {
    const logs = new InMemoryLogRecordExporter()
    const traces = new InMemorySpanExporter()
    const sdk = new BrowserOtelSdk(config(), () => {}, { logs, traces })
    const root = new Error("Failed with Bearer sensitive-token-value", { cause: new TypeError("inner cause") })
    sdk.emit({ event: "workspace.replica.failed", detail: { workspaceId: "workspace-safe-id", error: root,
      tabId: "tab-safe-id", runId: 3, runtimeId: "runtime-safe-id", instanceId: "slot-0", cause: "heartbeat failed", direction: "incoming", suppressedCount: 40,
      "startup.source.version": "previous-build", "recovery.transition_id": "recovery-safe-id" }, level: "error", timestamp: Date.now(), exception: root })
    const startedAt = performance.now()
    const active = sdk.startOperation("replica.admission", { "workspace.id": "workspace-safe-id" }, startedAt)
    if (!active) throw new Error("Diagnostic operation was unexpectedly dropped")
    const child = sdk.beginHttp("rusty.request", { "http.request.method": "POST", "server.address": "rusty.test" }, active.context)
    expect(child.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    child.end(new Error("failed token=http-secret"), 503)
    sdk.finishOperation(active.span, active.context, "replica.admission", { "workspace.id": "workspace-safe-id" }, startedAt + 4, root)
    await sdk.forceFlush()

    const record = logs.getFinishedLogRecords()[0]!
    expect(record.body).toBe("workspace.replica.failed")
    expect(record.resource.attributes).toMatchObject({ "service.name": "tincanban.browser", "session.id": expect.any(String), "service.version": expect.any(String) })
    expect(record.attributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": "Failed with Bearer [REDACTED]",
      "exception.stacktrace": expect.stringContaining("Caused by TypeError: inner cause"),
      "workspace.id": "workspace-safe-id",
      "browser.tab.id": "tab-safe-id", "sync.run.id": 3, "sync.runtime.id": "runtime-safe-id", "network.peer.instance.id": "slot-0",
      "sync.cause": "heartbeat_failed", "network.connection.direction": "incoming", "sync.suppressed.count": 40,
      "startup.source.version": "previous-build",
      "recovery.transition.id": "recovery-safe-id",
    })
    expect(JSON.stringify(record.attributes)).not.toContain("sensitive-token-value")

    const spans = traces.getFinishedSpans()
    const span = spans.find(item => item.name === "replica.admission")!
    const http = spans.find(item => item.name === "rusty.request")!
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(span.spanContext().traceId).not.toBe("00000000000000000000000000000000")
    expect(span.status.code).toBe(2)
    expect(span.attributes["workspace.id"]).toBe("workspace-safe-id")
    expect(http.parentSpanContext?.spanId).toBe(span.spanContext().spanId)
    expect(http.spanContext().traceId).toBe(span.spanContext().traceId)
    expect(http.attributes).toMatchObject({ "http.request.method": "POST", "server.address": "rusty.test" })
    expect(JSON.stringify(spans.map(item => item.events))).not.toContain("sensitive-token-value")
    expect(JSON.stringify(spans.map(item => item.events))).not.toContain("http-secret")
    expect(logs.getFinishedLogRecords().at(-1)?.spanContext?.traceId).toBe(span.spanContext().traceId)
    await sdk.shutdown()
  })

  it("Given the standard OTLP exporters, when they send to a mock intake, then logs and traces use signal routes and auth headers", async () => {
    const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        requests.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") })
        if (request.url === "/v1/traces") {
          // A permanent rejection tests exporter errors without randomized SDK retry delays.
          response.writeHead(400)
          response.end("Collector rejected the batch")
        } else {
          response.writeHead(200, { "Content-Type": "application/json" })
          response.end(JSON.stringify({ partialSuccess: { rejectedLogRecords: 1, errorMessage: "sampled out by test" } }))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    pendingServers.push(server)
    const address = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}`
    const sdk = new BrowserOtelSdk({ ...config(), logsEndpoint: `${endpoint}/v1/logs`, tracesEndpoint: `${endpoint}/v1/traces` }, () => {})
    sdk.emit({ event: "startup.phase.failed", detail: { errorCode: "TypeError" }, level: "error", timestamp: Date.now() })
    const startedAt = performance.now()
    sdk.operation({ name: "startup.history", attributes: { "startup.stage": "history-load" }, startedAt, endedAt: startedAt + 1 })
    await sdk.forceFlush()
    expect(requests.filter(request => request.path === "/v1/logs")).toHaveLength(1)
    expect(requests.filter(request => request.path === "/v1/traces")).toHaveLength(1)
    for (const request of requests) {
      expect(request.headers.authorization).toBe("Bearer public-browser-fixture-key-0123456789")
      expect(request.headers["x-tinsink-project"]).toBe("tincanban")
      expect(request.headers["x-tinsink-source"]).toBe("browser")
      expect(request.body).not.toContain("schema_version")
      expect(JSON.parse(request.body)).toHaveProperty(request.path.endsWith("logs") ? "resourceLogs" : "resourceSpans")
    }
    expect(sdk.exportState.error).toContain("OTLP trace export failed")
    expect(sdk.exportState.error).toContain("HTTP 400")
    await sdk.shutdown()
  })

  it("Given buffered SDK records, when consent shuts providers down, then queued records are discarded without exporter writes", async () => {
    const logs = new InMemoryLogRecordExporter()
    const traces = new InMemorySpanExporter()
    const sdk = new BrowserOtelSdk(config(), () => {}, { logs, traces })
    sdk.emit({ event: "consent.pending", detail: {}, level: "info", timestamp: Date.now() })
    const startedAt = performance.now()
    sdk.operation({ name: "consent.operation", attributes: {}, startedAt, endedAt: startedAt + 2 })
    await sdk.shutdown()
    expect(logs.getFinishedLogRecords()).toHaveLength(0)
    expect(traces.getFinishedSpans()).toHaveLength(0)
    expect(sdk.exportState.queued).toBe(0)
  })

  it("Given a full diagnostic reservation budget, when another operation or HTTP request starts, then overflow is dropped without emitting a trace header", async () => {
    const traces = new InMemorySpanExporter()
    const sdk = new BrowserOtelSdk(config(), () => {}, { logs: new InMemoryLogRecordExporter(), traces })
    const active = Array.from({ length: 512 }, () => sdk.startOperation("reserved.operation", {}))
    expect(active.every(Boolean)).toBe(true)
    expect(sdk.exportState.queued).toBe(512)
    expect(sdk.startOperation("overflow.operation", {})).toBeUndefined()
    expect(sdk.beginHttp("overflow.http", {}).headers).toEqual({})
    expect(sdk.exportState.queued).toBe(512)
    expect(sdk.exportState.dropped).toBe(2)
    for (const operation of active) {
      if (operation) sdk.finishOperation(operation.span, operation.context, "reserved.operation", {}, performance.now())
    }
    await sdk.forceFlush()
    expect(traces.getFinishedSpans()).toHaveLength(512)
    expect(sdk.exportState.queued).toBe(0)
    await sdk.shutdown()
  })

  it("Given an OTLP batch failure, when the exporter rejects records, then pending falls to zero and rejected records count as dropped", async () => {
    const logs = {
      export: (_records: unknown[], callback: (result: { code: ExportResultCode; error?: Error }) => void) =>
        callback({ code: ExportResultCode.FAILED, error: new Error("collector unavailable") }),
      forceFlush: async () => {}, shutdown: async () => {},
    }
    const sdk = new BrowserOtelSdk(config(), () => {}, { logs, traces: new InMemorySpanExporter() })
    sdk.emit({ event: "failed.batch", detail: {}, level: "error", timestamp: Date.now() })
    expect(sdk.exportState.queued).toBe(1)
    await sdk.forceFlush()
    expect(sdk.exportState.queued).toBe(0)
    expect(sdk.exportState.sending).toBe(0)
    expect(sdk.exportState.dropped).toBe(1)
    expect(sdk.exportState.error).toContain("OTLP log export failed")
    await sdk.shutdown()
  })

  it("Given a rejected export, when the next batch is pending, then the failure remains available without exposing transport details", async () => {
    const deliveries: Array<(result: { code: ExportResultCode; error?: Error }) => void> = []
    const logs = {
      export: (_records: unknown[], complete: (result: { code: ExportResultCode; error?: Error }) => void) => deliveries.push(complete),
      forceFlush: async () => {}, shutdown: async () => {},
    }
    const sdk = new BrowserOtelSdk(config(), () => {}, { logs, traces: new InMemorySpanExporter() })
    sdk.emit({ event: "sync.failed", detail: {}, level: "error", timestamp: Date.now() })
    const first = sdk.forceFlush()
    await vi.waitFor(() => expect(deliveries).toHaveLength(1))
    deliveries[0]!({ code: ExportResultCode.FAILED, error: new Error("Fetch request failed with non-retryable status 413; Bearer collector-private-token") })
    await first
    expect(sdk.exportState.error).toContain("HTTP 413")
    sdk.emit({ event: "sync.failed", detail: {}, level: "error", timestamp: Date.now() })
    const next = sdk.forceFlush()
    await vi.waitFor(() => expect(deliveries).toHaveLength(2))
    expect(sdk.exportState.error).toContain("HTTP 413")
    expect(sdk.exportState.error).not.toContain("collector-private-token")
    deliveries[1]!({ code: ExportResultCode.SUCCESS })
    await next
    expect(sdk.exportState.error).toBe("")
    await sdk.shutdown()
  })
})
