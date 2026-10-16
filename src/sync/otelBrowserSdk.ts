/* global __TINCANBAN_BUILD_COMMIT__ */
import { context, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { ExportResultCode } from "@opentelemetry/core"
import type { SpanExporter } from "@opentelemetry/sdk-trace-base"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter } from "@opentelemetry/sdk-logs"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import type { TelemetryConfig } from "./telemetryConfig"
import { capturedException } from "./exceptionCapture"
import { diagnosticErrorCode } from "./failureDiagnostic"
import type { HttpDiagnosticSpan } from "./httpDiagnostics"

export type DiagnosticInput = {
  event: string
  detail: Record<string, unknown>
  level: string
  timestamp: number
  exception?: unknown
}
export type OperationInput = {
  name: string
  attributes: Record<string, string | number>
  startedAt: number
  endedAt: number
  exception?: unknown
}
export type ExportState = { sending: number; queued: number; dropped: number; lastSentAt: number | null; error: string }
export type BrowserSdkExporters = { logs: LogRecordExporter; traces: SpanExporter }

const buildVersion = typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "dev" : __TINCANBAN_BUILD_COMMIT__
const sessionId = crypto.randomUUID()
const maxOutstandingRecords = 512
const severity = (level: string) => level === "fatal" ? SeverityNumber.FATAL : level === "error" ? SeverityNumber.ERROR : level === "warn" ? SeverityNumber.WARN : level === "debug" ? SeverityNumber.DEBUG : SeverityNumber.INFO
const severityName = (level: string) => level === "fatal" ? "FATAL" : level === "error" ? "ERROR" : level === "warn" ? "WARN" : level === "debug" ? "DEBUG" : "INFO"

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined
}
function safeText(value: unknown, limit = 96): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, limit)
  return normalized || undefined
}
type SafeAttributes = Record<string, string | number | boolean | string[]>
function mappedAttributes(detail: Record<string, unknown>, mapping: Array<[string, string]>, validate: (value: unknown) => string | undefined): SafeAttributes {
  const result: SafeAttributes = {}
  for (const [source, target] of mapping) {
    const value = validate(detail[source])
    if (value !== undefined) result[target] = value
  }
  return result
}
function identifierAttributes(detail: Record<string, unknown>): SafeAttributes {
  return mappedAttributes(detail, [["workspaceId", "workspace.id"], ["entityId", "entity.id"], ["recordId", "entity.id"], ["connectionId", "network.connection.id"], ["peerId", "network.peer.id"], ["changeId", "document.change.id"]], safeIdentifier)
}
function labelAttributes(detail: Record<string, unknown>): SafeAttributes {
  const labels: Array<[string, string]> = [["phase", "sync.phase"], ["component", "code.component"], ["operation", "code.operation"], ["transport", "network.transport"], ["kind", "sync.frame.kind"], ["mode", "sync.mode"], ["stage", "startup.stage"], ["browser", "browser.name"], ["platform", "os.name"], ["errorCode", "error.code"]]
  return mappedAttributes(detail, labels, safeText)
}
function semanticAttributes(detail: Record<string, unknown>): SafeAttributes {
  const semanticFields: Array<[string, string, "id" | "label"]> = [
    ["workspace.id", "workspace.id", "id"], ["entity.id", "entity.id", "id"], ["sync.phase", "sync.phase", "label"],
    ["sync.operation", "sync.operation", "label"], ["network.connection.id", "network.connection.id", "id"],
    ["network.peer.id", "network.peer.id", "id"], ["document.change.id", "document.change.id", "id"],
    ["startup.stage", "startup.stage", "label"], ["code.component", "code.component", "label"],
    ["code.operation", "code.operation", "label"], ["error.code", "error.code", "label"],
    ["sync.scope.id", "sync.scope.id", "id"], ["sync.scope.kind", "sync.scope.kind", "label"],
    ["http.request.method", "http.request.method", "label"], ["server.address", "server.address", "label"],
  ]
  const attributes: SafeAttributes = {}
  for (const [source, target, kind] of semanticFields) {
    const value = kind === "id" ? safeIdentifier(detail[source]) : safeText(detail[source])
    if (value !== undefined) attributes[target] = value
  }
  if (typeof detail["http.response.status_code"] === "number" && Number.isInteger(detail["http.response.status_code"]) && detail["http.response.status_code"] >= 100 && detail["http.response.status_code"] <= 599) {
    attributes["http.response.status_code"] = detail["http.response.status_code"]
  }
  return attributes
}
function numericAttributes(detail: Record<string, unknown>): SafeAttributes {
  const attributes: SafeAttributes = {}
  for (const key of ["attempt", "bytes", "peerCount", "changeCount", "previousEpoch", "currentEpoch", "admitted", "pending", "quarantined", "operationCount", "elapsedMs"] as const) {
    const value = detail[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) attributes[`sync.${key.replace(/[A-Z]/g, letter => `.${letter.toLowerCase()}`)}`] = Math.min(value, 86_400_000)
  }
  return attributes
}
function safeAttributes(detail: Record<string, unknown>): SafeAttributes {
  const attributes = { ...identifierAttributes(detail), ...labelAttributes(detail), ...semanticAttributes(detail), ...numericAttributes(detail) }
  if (Array.isArray(detail.heads)) {
    const heads = detail.heads.slice(0, 32).map(safeIdentifier).filter((value): value is string => value !== undefined)
    if (heads.length) attributes["document.heads"] = heads
  }
  return attributes
}
function exporterConfig(config: TelemetryConfig, endpoint: string) {
  return {
    url: endpoint,
    timeoutMillis: 5000,
    headers: {
      Authorization: `Bearer ${config.browserKey ?? ""}`,
      "X-TinSink-Project": config.project,
      "X-TinSink-Source": "browser",
    },
  }
}
function monotonicTime(milliseconds: number): [number, number] {
  const seconds = Math.floor(milliseconds / 1000)
  return [seconds, Math.floor((milliseconds - seconds * 1000) * 1_000_000)]
}
function wallTimeFromMonotonic(milliseconds: number): number {
  return (typeof performance === "undefined" ? Date.now() : performance.timeOrigin) + milliseconds
}

export class BrowserOtelSdk {
  private loggerProvider: LoggerProvider
  private tracerProvider: WebTracerProvider
  private logger
  private tracer
  private closing = false
  readonly exportState: ExportState = { sending: 0, queued: 0, dropped: 0, lastSentAt: null, error: "" }
  private outstanding = 0
  private inFlightRecords = 0
  private onState: () => void

  constructor(config: TelemetryConfig, onState: () => void, providedExporters?: BrowserSdkExporters) {
    this.onState = onState
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "tincanban.browser",
      [ATTR_SERVICE_VERSION]: buildVersion,
      "session.id": sessionId,
    })
    const logs = providedExporters?.logs ?? new OTLPLogExporter(exporterConfig(config, config.logsEndpoint))
    const traces = providedExporters?.traces ?? new OTLPTraceExporter(exporterConfig(config, config.tracesEndpoint))
    const trackedLogs = {
      export: (records: Parameters<typeof logs.export>[0], callback: Parameters<typeof logs.export>[1]) => {
        if (this.closing) { callback({ code: ExportResultCode.SUCCESS }); this.onState(); return }
        this.exportStarted(records.length)
        logs.export(records, result => { this.exportFinished(records.length, result, "log"); callback(result) })
      },
      forceFlush: () => logs.forceFlush(),
      shutdown: () => logs.shutdown(),
    }
    const trackedTraces = {
      export: (spans: Parameters<typeof traces.export>[0], callback: Parameters<typeof traces.export>[1]) => {
        if (this.closing) { callback({ code: ExportResultCode.SUCCESS }); this.onState(); return }
        this.exportStarted(spans.length)
        traces.export(spans, result => { this.exportFinished(spans.length, result, "trace"); callback(result) })
      },
      forceFlush: () => traces.forceFlush?.() ?? Promise.resolve(),
      shutdown: () => traces.shutdown(),
    }
    this.loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: trackedLogs, scheduledDelayMillis: 2000, exportTimeoutMillis: 5000, maxExportBatchSize: 50, maxQueueSize: 512 })] })
    this.tracerProvider = new WebTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(trackedTraces, { scheduledDelayMillis: 2000, exportTimeoutMillis: 5000, maxExportBatchSize: 50, maxQueueSize: 512 })] })
    this.logger = this.loggerProvider.getLogger("tincanban.browser")
    this.tracer = this.tracerProvider.getTracer("tincanban.browser", buildVersion)
  }

  emit(input: DiagnosticInput, spanContext?: ReturnType<typeof trace.setSpan>): boolean {
    if (!this.reserve()) return false
    const detail = { ...input.detail }
    const error = input.exception ?? detail.error
    delete detail.error
    const attributes = safeAttributes(detail)
    if (error !== undefined) {
      Object.assign(attributes, capturedException(error))
      attributes["error.code"] = diagnosticErrorCode(error)
    }
    try {
      this.logger.emit({
        eventName: input.event,
        timestamp: monotonicTime(input.timestamp),
        severityNumber: severity(input.level),
        severityText: severityName(input.level),
        body: input.event,
        attributes,
        ...(spanContext ? { context: spanContext } : {}),
      })
      return true
    } catch {
      this.releaseUnqueued(1)
      return false
    }
  }

  operation(input: OperationInput) {
    const active = this.startOperation(input.name, input.attributes, input.startedAt)
    if (!active) return
    this.finishOperation(active.span, active.context, input.name, input.attributes, input.endedAt, input.exception)
  }

  startOperation(name: string, inputAttributes: Record<string, string | number>, startedAt = performance.now()) {
    if (!this.reserve()) return undefined
    const safeName = safeText(name, 160) ?? "diagnostic.operation"
    const attributes = safeAttributes(inputAttributes)
    try {
      const span = this.tracer.startSpan(safeName, { startTime: monotonicTime(wallTimeFromMonotonic(startedAt)), attributes })
      const spanContext = trace.setSpan(context.active(), span)
      const sc = span.spanContext()
      return { span, context: spanContext, traceparent: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}` }
    } catch {
      this.releaseUnqueued(1)
      return undefined
    }
  }

  finishOperation(span: Span, parent: Context, name: string, attributes: Record<string, string | number>, endedAt = performance.now(), error?: unknown) {
    const safeName = safeText(name, 160) ?? "diagnostic.operation"
    if (error !== undefined) {
      span.addEvent("exception", capturedException(error))
      span.setStatus({ code: SpanStatusCode.ERROR })
      this.emit({ event: `${safeName}.failed`, detail: { error, ...attributes }, level: "error", timestamp: Date.now(), exception: error }, parent)
    } else span.setStatus({ code: SpanStatusCode.OK })
    span.end(monotonicTime(wallTimeFromMonotonic(endedAt)))
  }

  beginHttp(name: string, inputAttributes: Record<string, string | number>, parent?: Context): HttpDiagnosticSpan {
    if (this.closing) return { headers: {}, end: () => {} }
    if (!this.reserve()) return { headers: {}, end: () => {} }
    const attributes = safeAttributes(inputAttributes)
    let span: Span
    try { span = this.tracer.startSpan(safeText(name, 160) ?? "http.request", { attributes, kind: SpanKind.CLIENT }, parent) }
    catch { this.releaseUnqueued(1); return { headers: {}, end: () => {} } }
    const spanContext = trace.setSpan(context.active(), span)
    const contextId = span.spanContext()
    let ended = false
    return {
      headers: { traceparent: `00-${contextId.traceId}-${contextId.spanId}-${contextId.traceFlags.toString(16).padStart(2, "0")}` },
      end: (error?: unknown, statusCode?: number) => {
        if (ended) return
        ended = true
        if (statusCode !== undefined && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) span.setAttribute("http.response.status_code", statusCode)
        if (error !== undefined) {
          span.addEvent("exception", capturedException(error))
          span.setStatus({ code: SpanStatusCode.ERROR })
          this.emit({ event: `${name}.failed`, detail: { ...inputAttributes, "http.response.status_code": statusCode, error }, level: "error", timestamp: Date.now(), exception: error }, spanContext)
        } else if (statusCode !== undefined && statusCode >= 400) span.setStatus({ code: SpanStatusCode.ERROR })
        else span.setStatus({ code: SpanStatusCode.OK })
        span.end()
      },
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    this.exportState.dropped += Math.max(0, this.outstanding - this.inFlightRecords)
    this.outstanding = this.inFlightRecords
    this.exportState.queued = 0
    this.onState()
    await Promise.allSettled([this.loggerProvider.shutdown(), this.tracerProvider.shutdown()])
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([this.loggerProvider.forceFlush(), this.tracerProvider.forceFlush()])
  }

  private reserve() {
    if (this.closing) return false
    if (this.outstanding >= maxOutstandingRecords) {
      this.exportState.dropped++
      this.onState()
      return false
    }
    this.outstanding++
    this.exportState.queued++
    this.onState()
    return true
  }

  private releaseUnqueued(count: number) {
    this.outstanding = Math.max(0, this.outstanding - count)
    this.exportState.queued = Math.max(0, this.exportState.queued - count)
    this.exportState.dropped += count
    this.onState()
  }

  private exportStarted(count: number) {
    this.exportState.sending++
    this.inFlightRecords += count
    this.exportState.queued = Math.max(0, this.exportState.queued - count)
    this.exportState.error = ""
    this.onState()
  }

  private exportFinished(count: number, result: { code: ExportResultCode; error?: Error }, signal: "log" | "trace") {
    this.exportState.sending = Math.max(0, this.exportState.sending - 1)
    this.inFlightRecords = Math.max(0, this.inFlightRecords - count)
    this.outstanding = Math.max(0, this.outstanding - count)
    if (result.code === ExportResultCode.SUCCESS) this.exportState.lastSentAt = Date.now()
    else {
      this.exportState.dropped += count
      this.exportState.error = `The OTLP ${signal} export failed; its batch was discarded. Resume applies only to diagnostics still queued or recorded later.`
    }
    this.onState()
  }
}
