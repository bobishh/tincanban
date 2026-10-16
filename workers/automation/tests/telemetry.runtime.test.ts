import { describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { automationDiagnosticContext, configureAutomationTelemetry, flushAutomationTelemetryAfter, withAutomationSpan } from "../src/telemetry";
import { fetchBlind } from "../../../src/sync/rustyHttp";

describe("automation OpenTelemetry producers", () => {
  it("exports correlated standard OTLP logs and traces with server tenant headers", async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "");
      requests.push({ url: String(input), headers: new Headers(init?.headers), body });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    const telemetry = configureAutomationTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      TELEMETRY_TOKEN: "server-test-secret",
      RELEASE_SHA: "test-revision",
    });
    expect(telemetry.enabled).toBe(true);

    let propagatedTraceId = "";
    let workerSpanId = "";
    await expect(withAutomationSpan(telemetry, "automation.replica.sync", { phase: "merge" }, async span => {
      const propagated = trace.getSpan(automationDiagnosticContext(span)!);
      propagatedTraceId = propagated?.spanContext().traceId ?? "";
      workerSpanId = propagated?.spanContext().spanId ?? "";
      await fetchBlind("https://rusty.example.test/v2/scopes/scope-1/objects", {
        method: "GET", diagnosticContext: automationDiagnosticContext(span),
      });
      throw new Error("merge failed; Bearer do-not-export");
    }, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).rejects.toThrow("merge failed");
    expect(propagatedTraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    await telemetry.flush();

    const logs = requests.find(request => request.url.endsWith("/v1/logs"));
    const traces = requests.find(request => request.url.endsWith("/v1/traces"));
    expect(logs).toBeDefined();
    expect(traces).toBeDefined();
    for (const request of [logs!, traces!]) {
      expect(request.headers.get("authorization")).toBe("Bearer server-test-secret");
      expect(request.headers.get("x-tinsink-project")).toBe("tincanban-automation");
      expect(request.headers.get("x-tinsink-source")).toBe("server");
      expect(request.body).not.toContain("server-test-secret");
      expect(request.body).not.toContain("do-not-export");
    }
    const log = JSON.parse(logs!.body);
    const traceExport = JSON.parse(traces!.body);
    expect(log.resourceLogs[0].scopeLogs[0].logRecords[0].attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "exception.type", value: { stringValue: "Error" } }),
      expect.objectContaining({ key: "exception.message", value: { stringValue: "merge failed; Bearer [REDACTED]" } }),
    ]));
    const exportedSpans = traceExport.resourceSpans[0].scopeSpans[0].spans;
    const syncSpan = exportedSpans.find((candidate: { name: string }) => candidate.name === "automation.replica.sync");
    const outbound = requests.find(request => request.url.includes("rusty.example.test"));
    expect(outbound?.headers.get("traceparent")).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    const outgoingHttpSpanId = outbound?.headers.get("traceparent")?.split("-")[2];
    expect(exportedSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentSpanId: "00f067aa0ba902b7" }),
      expect.objectContaining({ spanId: outgoingHttpSpanId, parentSpanId: workerSpanId }),
    ]));
    expect(syncSpan?.status.code).toBe(2);
    expect(syncSpan?.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "phase", value: { stringValue: "merge" } }),
      expect.objectContaining({ key: "exception.stacktrace", value: { stringValue: expect.stringContaining("merge failed") } }),
    ]));
    vi.unstubAllGlobals();
  });

  it("flushes Durable Object telemetry after work settles without replacing its outcome", async () => {
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    const pending: Promise<unknown>[] = [];
    flushAutomationTelemetryAfter({ waitUntil: promise => pending.push(promise) }, work);
    expect(pending).toHaveLength(1);

    let completed = false;
    void pending[0]!.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await pending[0];
    expect(completed).toBe(true);
  });
});
