import { expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AutomationCoordinator } from "../src/coordinator";
import * as telemetry from "../src/telemetry";
import { encryptEventPayload } from "../src/eventPayload";
import type { WorkerEnv } from "../src/index";
import type { AutomationEvent } from "../src/pipeline";

it("Given standalone executor intake wakes without an HTTP request, When forwarding fails, Then its adapter records the original retry error and flushes telemetry before suspension", async () => {
  const integrationId = "intake-alarm-telemetry";
  const eventId = "t".repeat(43);
  const secret = "intake-telemetry-event-secret-with-thirty-two-bytes";
  const runtime = env as unknown as WorkerEnv;
  const configure = vi.spyOn(telemetry, "configureAutomationTelemetry");
  const record = vi.spyOn(telemetry, "recordAutomationException").mockImplementation(() => {});
  let restoreFlush: (() => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://executor.example/")) return Response.json({ error: "Executor classification temporarily unavailable" }, { status: 503 });
    throw new Error("Unexpected request outside executor forwarding");
  }));
  try {
    await runInDurableObject(runtime.AUTOMATION.getByName(integrationId), async (_instance, ctx) => {
      const intakeEnv = {
        ...runtime, EXECUTOR_ORIGIN: "https://executor.example",
        EXECUTOR_SERVICE_TOKEN: "intake-telemetry-service-token-with-thirty-two-bytes",
        EVENT_STORAGE_SECRET: secret,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
        TELEMETRY_TOKEN: "intake-telemetry-test-token",
      };
      const worker = new AutomationCoordinator(ctx, intakeEnv);
      expect(configure).toHaveBeenCalledWith(intakeEnv);
      const alarmFlush = vi.spyOn(telemetry.automationTelemetry(), "flush").mockResolvedValue(undefined);
      restoreFlush = () => { alarmFlush.mockRestore(); };
      ctx.storage.sql.exec(`INSERT INTO executor_migration
        (singleton, phase, origin, epoch, updated_at) VALUES (1, 'active', 'https://executor.example', 1, ?)`, Date.now());
      const event: AutomationEvent = { source: "email", receivedAt: "2026-10-16T10:00:00.000Z", rawMime: "", message: {
        messageId: "<telemetry@example.test>", inReplyTo: null, references: [], from: "jobs@example.test", to: "owner@example.test",
        subject: "Private message", text: "Private email content", date: null, urls: [], confirmation: false, attachments: [],
      } };
      await worker.enqueueEmail({ eventId, sourceId: "<telemetry@example.test>", bodyHash: "test-body-hash",
        payload: await encryptEventPayload(secret, eventId, event) });
      await worker.alarm();
      expect(alarmFlush).toHaveBeenCalled();
      await Promise.all(alarmFlush.mock.results.map(result => result.value));
      expect(ctx.storage.sql.exec<{ attempt: number }>("SELECT attempt FROM executor_intake_outbox WHERE event_id = ?", eventId).one().attempt).toBe(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Executor classification temporarily unavailable", name: "ExecutorRpcError" }),
        expect.objectContaining({ event: "executor.intake.forward.retry", integrationId, eventId, attempt: 1 }),
      );
      const captured = JSON.stringify(record.mock.calls);
      expect(captured).not.toContain("Private email content");
      expect(captured).not.toContain(secret);
    });
  } finally {
    restoreFlush?.();
    record.mockRestore();
    configure.mockRestore();
    vi.unstubAllGlobals();
  }
});
