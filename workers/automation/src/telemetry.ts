import { context, ROOT_CONTEXT, trace, type Context, type Span } from "@opentelemetry/api";
import { SeverityNumber, type Logger as OTelLogger } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { capturedException } from "../../../src/domain/exceptionCapture";
import { diagnosticHttpRequest, setHttpDiagnosticSpanFactory, type HttpDiagnosticSpanFactory } from "../../../src/domain/httpDiagnostics";
import { fetchRusty, readRustyJson } from "@meta-uber/mesh-replication/rusty-replica";
import type { PublicDeliveryInput } from "../../../src/public/publicDelivery";

export const automationPublicDeliveryHttp: NonNullable<PublicDeliveryInput["http"]> = {
  request: (url, init, parent) => diagnosticHttpRequest(url, init, fetchRusty, parent),
  readJson: async <T>(response: Response, maximumBytes: number) => await readRustyJson(response, maximumBytes) as T,
};

export type AutomationTelemetryBindings = {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  TELEMETRY_TOKEN?: string;
  RELEASE_SHA?: string;
  /** Separate runtime identity; the intake tenant and server authentication remain unchanged. */
  SERVICE_NAME?: string;
};

export type TelemetryAttributes = Record<string, string | number | boolean | undefined>;
export type WorkerTelemetry = {
  enabled: boolean;
  logger?: OTelLogger;
  tracer?: ReturnType<BasicTracerProvider["getTracer"]>;
  flush: () => Promise<void>;
};

let configuredTelemetry: WorkerTelemetry | undefined;

/** Initialize one SDK per isolate; credentials stay in runtime bindings. */
export function configureAutomationTelemetry(env: AutomationTelemetryBindings): WorkerTelemetry {
  if (configuredTelemetry) return configuredTelemetry;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/$/, "");
  const token = env.TELEMETRY_TOKEN;
  if (!endpoint || !token || token.length > 256 || !isCollectorEndpoint(endpoint)) {
    configuredTelemetry = { enabled: false, flush: async () => {} };
    return configuredTelemetry;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-TinSink-Project": "tincanban-automation",
    "X-TinSink-Source": "server",
  };
  const resource = resourceFromAttributes({
    "service.name": env.SERVICE_NAME === "tincanban-executor" ? "tincanban-executor" : "tincanban-automation",
    "service.version": bounded(env.RELEASE_SHA ?? "unknown", 128),
    "deployment.environment.name": "production",
  });
  const logProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
    maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 1_000, exportTimeoutMillis: 2_000,
  })] });
  const traceProvider = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
    { maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 1_000, exportTimeoutMillis: 2_000 },
  )] });
  const logger = logProvider.getLogger("tincanban-automation");
  const tracer = traceProvider.getTracer("tincanban-automation");
  configuredTelemetry = {
    enabled: true,
    logger,
    tracer,
    flush: async () => {
      await Promise.allSettled([logProvider.forceFlush({ timeoutMillis: 2_500 }), traceProvider.forceFlush({ timeoutMillis: 2_500 })]);
    },
  };
  setHttpDiagnosticSpanFactory(workerHttpSpanFactory);
  return configuredTelemetry;
}

export function automationTelemetry(): WorkerTelemetry {
  return configuredTelemetry ?? { enabled: false, flush: async () => {} };
}

/** Flush logs and spans after Durable Object work settles, without changing its result. */
export function flushAutomationTelemetryAfter(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  operation: Promise<unknown>,
): void {
  const flush = () => automationTelemetry().flush();
  try { ctx.waitUntil(operation.then(flush, flush).catch(() => {})); }
  catch { /* Telemetry lifecycle support is optional and must not affect the operation. */ }
}

/** Carry this operation's parent explicitly across Durable Object boundaries. */
export function automationDiagnosticContext(span?: Span): Context | undefined {
  return span ? trace.setSpan(ROOT_CONTEXT, span) : undefined;
}

/** Request-scoped child spans; context is explicit so concurrent Worker requests never share parents. */
const workerHttpSpanFactory: HttpDiagnosticSpanFactory = (name, attributes, parent) => {
  const tracer = configuredTelemetry?.tracer;
  if (!tracer) return undefined;
  const parentContext = parent ?? ROOT_CONTEXT;
  const span = tracer.startSpan(name, { attributes: boundedAttributes(attributes) }, parentContext);
  const spanContext = trace.setSpan(parentContext, span);
  const carrier: Record<string, string> = {};
  new W3CTraceContextPropagator().inject(spanContext, carrier, {
    set: (target, key, value) => { target[key.toLowerCase()] = value; },
  });
  let ended = false;
  return {
    headers: carrier,
    end(error, statusCode) {
      if (ended) return;
      ended = true;
      if (statusCode !== undefined && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
        span.setAttribute("http.response.status_code", statusCode);
      }
      if (error !== undefined) {
        const exception = capturedException(error);
        for (const [key, value] of Object.entries(exception)) span.setAttribute(key, value);
        span.setStatus({ code: 2, message: exception["exception.type"] });
        recordAutomationException(error, { ...attributes, event: `${name}.failed`, "http.response.status_code": statusCode }, span);
      } else if (statusCode !== undefined && statusCode >= 400) span.setStatus({ code: 2 });
      else span.setStatus({ code: 1 });
      span.end();
    },
  };
};

/** Log safe OpenTelemetry exception attributes; retain useful message and cause context. */
export function recordAutomationException(error: unknown, attributes: TelemetryAttributes, span?: Span): void {
  const telemetry = configuredTelemetry;
  if (!telemetry?.enabled || !telemetry.logger) return;
  const exception = capturedException(error);
  const contextWithSpan = span ? trace.setSpan(context.active(), span) : context.active();
  telemetry.logger.emit({
    eventName: "automation.exception",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: "Automation operation failed",
    attributes: boundedAttributes({
      "event.name": attributes.event ?? "automation.operation.failed",
      ...attributes,
      ...exception,
    }),
    context: contextWithSpan,
  });
}

/** Run real async Worker work in an SDK span, adopting a valid inbound W3C parent. */
export async function withAutomationSpan<T>(
  telemetry: WorkerTelemetry,
  name: string,
  attributes: TelemetryAttributes,
  operation: (span?: Span) => Promise<T>,
  traceparent?: string | null,
): Promise<T> {
  if (!telemetry.enabled || !telemetry.tracer) return operation();
  const parent = extractTraceParent(traceparent);
  return telemetry.tracer.startActiveSpan(name, { attributes: boundedAttributes(attributes) }, parent, async span => {
    try {
      return await operation(span);
    } catch (error) {
      const exception = capturedException(error);
      span.setAttribute("exception.type", exception["exception.type"]);
      if (exception["exception.message"]) span.setAttribute("exception.message", exception["exception.message"]);
      if (exception["exception.stacktrace"]) span.setAttribute("exception.stacktrace", exception["exception.stacktrace"]);
      span.setStatus({ code: 2, message: exception["exception.type"] });
      recordAutomationException(error, { ...attributes, event: `${name}.failed` }, span);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function normalizedWorkerRoute(pathname: string): string {
  return pathname
    .replace(/\/v1\/integrations\/[^/]+/g, "/v1/integrations/{integrationId}")
    .replace(/\/events\/[^/]+/g, "/events/{eventId}")
    .replace(/\/automation-instances\/[^/]+/g, "/automation-instances/{instanceId}");
}

function extractTraceParent(header: string | null | undefined) {
  if (!header || header.length > 128) return ROOT_CONTEXT;
  return new W3CTraceContextPropagator().extract(ROOT_CONTEXT, { traceparent: header }, {
    get: (carrier, key) => carrier[key.toLowerCase()],
    keys: carrier => Object.keys(carrier),
  });
}

function isCollectorEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || (url.protocol === "http:" && loopback));
  } catch { return false; }
}

function bounded(value: string, max: number): string { return value.slice(0, max); }

function boundedAttributes(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const normalized = key.toLowerCase();
    if (/(?:token|secret|password|private.?key|content|body|payload|authorization|credential)/i.test(key)) {
      if (!key.startsWith("exception.")) continue;
    }
    if (typeof value === "string") output[key] = bounded(value, key.startsWith("exception.") ? 16_384 : 256);
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
  }
  return output;
}
