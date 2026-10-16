import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ExecutionCoordinator } from "../src/executionCoordinator";
import type { ExecutionEnvironment } from "../src/executionPorts";
import type { WorkerEnv } from "../src/index";

it("Given durable SQL and alarm ports, when the same executor restarts, then queued intake and its idempotency conflict remain intact without loading a replica", async () => {
  const runtime = env as unknown as WorkerEnv;
  const stub = runtime.AUTOMATION.getByName("portable-coordinator-restart");
  const configuration: ExecutionEnvironment = {
    INTEGRATIONS_JSON: "[]", AI: { run: async () => { throw new Error("Queue acceptance must not classify or open a board"); } },
  };
  await runInDurableObject(stub, async (_instance, ctx) => {
    const input = { eventId: "durable-event", sourceId: "mail-source", bodyHash: "original-hash", payload: "encrypted-event" };
    const initial = new ExecutionCoordinator(ctx, configuration);
    expect(await initial.enqueueEmail(input)).toEqual({ eventId: input.eventId, status: "pending", duplicate: false });
    expect(await ctx.storage.getAlarm()).not.toBeNull();

    const restarted = new ExecutionCoordinator(ctx, configuration);
    expect(await restarted.enqueueEmail(input)).toEqual({ eventId: input.eventId, status: "pending", duplicate: true });
    expect(await restarted.enqueueEmail({ ...input, bodyHash: "changed-hash" })).toEqual({ error: "idempotency-conflict" });
    expect(restarted.getEvent(input.eventId)).toMatchObject({ eventId: input.eventId, source: "email", status: "pending" });
    await ctx.storage.deleteAlarm();
  });
});
