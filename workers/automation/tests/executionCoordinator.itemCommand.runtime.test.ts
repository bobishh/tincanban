import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { sha256Base64Url } from "../../../src/domain/identityCrypto";
import { ExecutionCoordinator } from "../src/executionCoordinator";
import type { ExecutionEnvironment } from "../src/executionPorts";
import type { WorkerEnv } from "../src/index";

const decision = {
  relevance: "yes",
  assessment: { version: 1, employee_profile: { stack: "", work_profile: "" },
    scores: { companyRecognition: null, companyStability: null, stackFit: null, workFit: null } },
  assessmentDistributions: Object.fromEntries(["companyRecognition", "companyStability", "stackFit", "workFit"].map(key => [key, {
    type: "choice", choice: "unknown", confidence: 1, probabilities: { strong: 0, partial: 0, weak: 0, unknown: 1 },
  }])),
  priority: { score: 0, optionId: "p3" }, roleType: "backend", seniority: "senior",
  distributions: {
    job_opportunity: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0, uncertain: 0 } },
    role_type: { type: "choice", choice: "backend", confidence: 1,
      probabilities: { backend: 1, frontend: 0, fullstack: 0, platform_devops: 0, data_ai: 0, mobile: 0, engineering_management: 0, other_unknown: 0 } },
    seniority: { type: "choice", choice: "senior", confidence: 1,
      probabilities: { intern_junior: 0, middle: 0, senior: 1, staff_principal: 0, lead_manager: 0, unknown: 0 } },
  },
  model: "@cf/cloudflare/clef-flash", policyVersion: "lead-clef-v2",
};

const command = async (integrationId: string) => {
  const value = {
    integrationId, sourceEventId: "A".repeat(43), idempotencyKey: "",
    event: { source: "website" as const, receivedAt: "2026-10-16T12:00:00.000Z",
      submission: { message: "Source message", contact: "", company: "Example", role: "Engineer", jobUrl: "https://example.com/jobs/1" } },
    classification: { status: "review" as const, reason: "Needs approval",
      source: { type: "website" as const, receivedAt: "2026-10-16T12:00:00.000Z" }, decision },
  };
  value.idempotencyKey = await sha256Base64Url(new TextEncoder().encode(JSON.stringify(value.event.submission)));
  return value;
};

it("Given an authenticated producer command, when accepted and retried, then the executor durably dedupes it and stores a frozen classification", async () => {
  const runtime = env as unknown as WorkerEnv;
  const stub = runtime.AUTOMATION.getByName(`item-command-${crypto.randomUUID()}`);
  const secret = "item-command-storage-secret-32-bytes";
  const configuration: ExecutionEnvironment = { INTEGRATIONS_JSON: "[]", EVENT_STORAGE_SECRET: secret,
    AI: { run: async () => { throw new Error("Preclassified commands must not invoke CLEF"); } } };
  await runInDurableObject(stub, async (_instance, ctx) => {
    const coordinator = new ExecutionCoordinator(ctx, configuration);
    const integrationId = ctx.id.name!;
    ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, 'owner', 'workspace', ?)", integrationId);

    const input = await command(integrationId);
    expect(await coordinator.enqueueItemCommand(input)).toMatchObject({ eventId: "A".repeat(43), status: "pending", duplicate: false });
    expect(await coordinator.enqueueItemCommand(input)).toMatchObject({ eventId: "A".repeat(43), status: "pending", duplicate: true });
    expect(await coordinator.enqueueItemCommand({ ...input, classification: { ...input.classification, reason: "Changed" } }))
      .toEqual({ error: "idempotency-conflict" });
    expect(coordinator.getItemCommandResult("A".repeat(43), integrationId)).toMatchObject({ commandId: "A".repeat(43), status: "pending" });
    expect(ctx.storage.sql.exec<{ classification_payload: string }>(
      "SELECT classification_payload FROM events WHERE event_id = ?", "A".repeat(43),
    ).toArray()[0]?.classification_payload).not.toContain("Source message");
    await coordinator.alarm();
    expect(coordinator.getItemCommandResult("A".repeat(43), "command-integration")).toMatchObject({
      commandId: "A".repeat(43), status: "review", result: { decision: { relevance: "yes" } },
    });
    await ctx.storage.deleteAlarm();
  });
});

it("Given a provisioned legacy executor with no registration row, when context and item APIs run, then instance identity scopes them", async () => {
  const runtime = env as unknown as WorkerEnv;
  const stub = runtime.AUTOMATION.getByName(`legacy-item-command-${crypto.randomUUID()}`);
  const configuration: ExecutionEnvironment = { INTEGRATIONS_JSON: "[]", EVENT_STORAGE_SECRET: "legacy-item-command-storage-secret-32-bytes",
    AI: { run: async () => { throw new Error("Preclassified commands must not invoke CLEF"); } } };
  await runInDurableObject(stub, async (_instance, ctx) => {
    const coordinator = new ExecutionCoordinator(ctx, configuration);
    const integrationId = ctx.id.name!;
    const input = await command(integrationId);
    const admittedReplica = {
      controlForRuntime: () => ({ state: "active" as const }),
      definitionForRuntime: () => ({ id: "definition" }), employeeProfileForRuntime: () => ({ stack: "", work_profile: "" }),
      priorityBandsForRuntime: () => [{ optionId: "p3", minScore: 0 }], allowsSource: () => true,
    };
    Reflect.set(coordinator, "refreshReplica", async () => admittedReplica);

    expect(await coordinator.classificationContext()).toMatchObject({ integrationId, control: "active", allowedSources: { website: true, email: true } });
    expect(await coordinator.enqueueItemCommand(input)).toMatchObject({ eventId: "A".repeat(43), status: "pending", duplicate: false });
    expect(coordinator.getItemCommandResult("A".repeat(43), integrationId)).toMatchObject({ commandId: "A".repeat(43), status: "pending" });
    expect(coordinator.getItemCommandResult("A".repeat(43), "another-integration")).toBeNull();
    expect(ctx.storage.sql.exec("SELECT integration_id FROM automation_registration").toArray()).toEqual([]);
    await ctx.storage.deleteAlarm();
  });
});

it("Given a legacy instance with a mismatched registration row, when item scope is resolved, then it fails closed", async () => {
  const runtime = env as unknown as WorkerEnv;
  const stub = runtime.AUTOMATION.getByName(`legacy-item-command-mismatch-${crypto.randomUUID()}`);
  const configuration: ExecutionEnvironment = { INTEGRATIONS_JSON: "[]", EVENT_STORAGE_SECRET: "legacy-item-command-storage-secret-32-bytes",
    AI: { run: async () => { throw new Error("Preclassified commands must not invoke CLEF"); } } };
  await runInDurableObject(stub, async (_instance, ctx) => {
    const coordinator = new ExecutionCoordinator(ctx, configuration);
    ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, 'owner', 'workspace', 'foreign-integration')");

    await expect(coordinator.classificationContext()).rejects.toThrow(/instance identity/i);
    await expect(coordinator.enqueueItemCommand(await command(ctx.id.name!))).rejects.toThrow(/instance identity/i);
    expect(coordinator.getItemCommandResult("A".repeat(43), ctx.id.name!)).toBeNull();
    await ctx.storage.deleteAlarm();
  });
});
