import { expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { encryptEventPayload } from "../src/eventPayload";
import type { WorkerEnv } from "../src/index";
import type { AutomationEvent } from "../src/pipeline";

it("Given standalone executor intake wakes without an HTTP request, When forwarding fails, Then its alarm exports the original retry error before suspension", async () => {
  const integrationId = "intake-alarm-telemetry";
  const eventId = "t".repeat(43);
  const secret = "intake-telemetry-event-secret-with-thirty-two-bytes";
  const runtime = env as unknown as WorkerEnv;
  const requests: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://executor.example/")) return Response.json({ error: "Executor classification temporarily unavailable" }, { status: 503 });
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "");
    requests.push({ url, body });
    return Response.json({});
  }));
  try {
    await runInDurableObject(runtime.AUTOMATION.getByName(integrationId), async (_instance, ctx) => {
      // The harness created its default legacy instance; model a fresh intake-only isolate.
      vi.resetModules();
      const { AutomationCoordinator } = await import("../src/coordinator");
      const { automationTelemetry } = await import("../src/telemetry");
      const worker = new AutomationCoordinator(ctx, {
        ...runtime, EXECUTOR_ORIGIN: "https://executor.example",
        EXECUTOR_SERVICE_TOKEN: "intake-telemetry-service-token-with-thirty-two-bytes",
        EVENT_STORAGE_SECRET: secret,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
        TELEMETRY_TOKEN: "intake-telemetry-test-token",
      });
      expect(automationTelemetry().enabled).toBe(true);
      const flush = vi.spyOn(automationTelemetry(), "flush");
      ctx.storage.sql.exec(`INSERT INTO executor_migration
        (singleton, phase, origin, epoch, updated_at) VALUES (1, 'active', 'https://executor.example', 1, ?)`, Date.now());
      const event: AutomationEvent = { source: "email", receivedAt: "2026-10-16T10:00:00.000Z", rawMime: "", message: {
        messageId: "<telemetry@example.test>", inReplyTo: null, references: [], from: "jobs@example.test", to: "owner@example.test",
        subject: "Private message", text: "Private email content", date: null, urls: [], confirmation: false, attachments: [],
      } };
      await worker.enqueueEmail({ eventId, sourceId: "<telemetry@example.test>", bodyHash: "test-body-hash",
        payload: await encryptEventPayload(secret, eventId, event) });
      await worker.alarm();
      expect(flush).toHaveBeenCalled();
      await Promise.all(flush.mock.results.map(result => result.value));
      expect(ctx.storage.sql.exec<{ attempt: number }>("SELECT attempt FROM executor_intake_outbox WHERE event_id = ?", eventId).one().attempt).toBe(1);
      const logs = requests.filter(request => request.url.endsWith("/v1/logs")).map(request => request.body).join("\n");
      expect(logs).toContain("executor.intake.forward.retry");
      expect(logs).toContain("Executor classification temporarily unavailable");
      expect(logs).toContain(eventId);
      expect(logs).not.toContain("Private email content");
      expect(logs).not.toContain(secret);
      flush.mockRestore();
    });
  } finally { vi.unstubAllGlobals(); }
});
