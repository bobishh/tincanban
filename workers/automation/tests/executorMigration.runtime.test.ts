import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AutomationCoordinator } from "../src/coordinator";
import { ExecutionCoordinator } from "../src/executionCoordinator";
import type { WorkerEnv } from "../src/index";
import { encryptEventPayload } from "../src/eventPayload";
import type { AutomationEvent } from "../src/pipeline";
import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identityCrypto";
import { handleExecutorMigrationApi } from "../src/executorMigrationApi";

const secret = "migration-test-event-secret-with-at-least-thirty-two-bytes";
const migrationSecret = "migration-test-key-with-at-least-thirty-two-bytes";
const serviceToken = "migration-test-service-token-with-more-than-thirty-two-bytes";
const origin = "https://executor.example";

function coordinatorEnv(): WorkerEnv {
  return { ...env, EVENT_STORAGE_SECRET: secret, EXECUTOR_MIGRATION_SECRET: migrationSecret,
    EXECUTOR_SERVICE_TOKEN: serviceToken, EXECUTOR_ORIGIN: origin,
    AI: { run: async () => { throw new Error("Frozen intake must not classify locally"); } },
    INTEGRATIONS_JSON: "[]" } as unknown as WorkerEnv;
}

describe("Cloudflare executor migration fence", () => {
  it("Given an unauthenticated migration request, When its body is malformed, Then authentication rejects it before parsing", async () => {
    const unauthorized = await handleExecutorMigrationApi(new Request(
      "https://worker.example/internal/executor-migrations/private-migration-api/prepare", {
        method: "POST", headers: { "content-type": "text/plain" }, body: "not-json",
      }), coordinatorEnv());
    expect(unauthorized.status).toBe(401);
  });

  it("Given a frozen writer, When intake retries or conflicts, Then it remains durable without invoking local execution", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("migration-frozen-outbox");
    await runInDurableObject(stub, async (_instance, ctx) => {
      const worker = new AutomationCoordinator(ctx, coordinatorEnv());
      const manifest = await worker.prepareExecutorMigration(11);
      expect(manifest.epoch).toBe(11);
      expect(await worker.executionRoute()).toBeNull();

      const event: AutomationEvent = { source: "email", receivedAt: "2026-10-16T10:00:00.000Z", rawMime: "", message: {
        messageId: "<same@example.test>", inReplyTo: null, references: [], from: "jobs@example.test", to: "owner@example.test",
        subject: "Role", text: "Hiring", date: null, urls: [], confirmation: false, attachments: [],
      } };
      const input = { eventId: "a".repeat(43), sourceId: "<same@example.test>", bodyHash: "original-hash",
        payload: await encryptEventPayload(secret, "a".repeat(43), event) };
      await expect(worker.enqueueEmail(input)).resolves.toMatchObject({ duplicate: false, status: "pending" });
      await expect(worker.enqueueEmail(input)).resolves.toMatchObject({ duplicate: true, status: "pending" });
      await expect(worker.enqueueEmail({ ...input, bodyHash: "changed-hash" })).resolves.toEqual({ error: "idempotency-conflict" });
      await expect(worker.loadReplicaState(secret)).rejects.toThrow(/migration|fenced/i);
      expect(ctx.storage.sql.exec("SELECT event_id FROM executor_intake_outbox").toArray()).toHaveLength(1);
    });
  });

  it("Given a prepared migration, When Node is not active for the exact epoch and manifest, Then acknowledgement leaves the old writer fenced", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("migration-ack-fails-closed");
    const fetchMock = vi.fn(async () => Response.json({ status: "importing", epoch: 12, manifestHash: "wrong" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(stub, async (_instance, ctx) => {
        const worker = new AutomationCoordinator(ctx, coordinatorEnv());
        const manifest = await worker.prepareExecutorMigration(12);
        const hash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(manifest)));

        await expect(worker.acknowledgeExecutorMigration(12, hash)).rejects.toThrow(/active|manifest|epoch/i);
        expect(await worker.executionRoute()).toBeNull();
        expect(fetchMock).toHaveBeenCalledOnce();
      });
    } finally { vi.unstubAllGlobals(); }
  });

  it("Given a frozen manifest with old intake evidence, When participant state migrates, Then queued letters and replay ledgers stay behind", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("migration-immutable-challenges");
    await runInDurableObject(stub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, coordinatorEnv());
      ctx.storage.sql.exec("INSERT INTO consumed_challenges (nonce, expires_at, event_id) VALUES ('old-nonce', ?, 'old-event')", Date.now() + 60_000);
      const worker = new AutomationCoordinator(ctx, coordinatorEnv());
      ctx.storage.sql.exec(`INSERT INTO events (event_id, source, source_id, body_hash, payload, status, created_at, updated_at)
        VALUES ('d', 'email', 'old-message-id', 'old-body-hash', 'old-ciphertext', 'pending', ?, ?)`, Date.now(), Date.now());
      const manifest = await worker.prepareExecutorMigration(15);
      expect(manifest.tables.map(table => table.name)).toEqual([
        "automation_registration", "automation_identities", "automation_replica", "automation_replica_chunks",
        "automation_storage_transition", "automation_storage_transition_completed",
        "automation_history_transition", "automation_history_transition_completed",
      ]);
      const excluded = new Set(["events", "consumed_challenges", "application_bindings", "application_review_requests"]);
      expect(manifest.tables.some(table => excluded.has(table.name))).toBe(false);
      const event: AutomationEvent = { source: "website", receivedAt: "2026-10-16T10:00:00.000Z", submission: {
        message: "Hiring", contact: "owner@example.test", company: "Example", role: "Engineer",
      } };
      const payload = await encryptEventPayload(secret, "c".repeat(43), event);
      await expect(worker.enqueueWebsite({ eventId: "c".repeat(43), sourceId: "c".repeat(43), bodyHash: "website-hash",
        nonce: "new-nonce", challengeExpiresAt: Date.now() + 60_000, payload })).resolves.toMatchObject({ status: "pending", duplicate: false });

      expect(ctx.storage.sql.exec("SELECT nonce FROM consumed_challenges").toArray()).toEqual([{ nonce: "old-nonce" }]);
      expect(ctx.storage.sql.exec<{ event_id: string }>("SELECT event_id FROM events").toArray()).toEqual([{ event_id: "d" }]);
      expect(ctx.storage.sql.exec("SELECT nonce FROM executor_intake_challenges").toArray()).toEqual([{ nonce: "new-nonce" }]);
      for (const table of manifest.tables) {
        for (const page of table.pages) await worker.readExecutorMigrationPage(manifest.epoch, table.name, page.offset);
      }
    });
  });

  it("Given Node confirms the exact approved participant, When intake acknowledges the route, Then old reading keys are removed and routing survives", async () => {
    const runtime = env as unknown as WorkerEnv;
    const integrationId = "migration-retired-participant";
    const stub = runtime.AUTOMATION.getByName(integrationId);
    let manifestHash = "";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "active", epoch: 16, manifestHash })));
    try {
      await runInDurableObject(stub, async (_instance, ctx) => {
        const worker = new AutomationCoordinator(ctx, coordinatorEnv());
        const routing = { id: integrationId, workspaceId: "workspace", scope: { version: 1,
          boardId: "board", columns: { lead: "lead", interview: "interview", rejected: "rejected" },
          fieldIds: { company: "company", role: "role", jobUrl: "job-url" }, expiresAt: "2099-01-01T00:00:00.000Z" }, allowedForwarders: [] };
        ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id, routing) VALUES (1, 'owner', 'workspace', ?, ?)",
          integrationId, JSON.stringify(routing));
        ctx.storage.sql.exec("INSERT INTO automation_identities VALUES (?, 'opaque-encrypted-identity', 1)", integrationId);
        ctx.storage.sql.exec("INSERT INTO automation_replica(singleton, encrypted_state, updated_at) VALUES (1, 'opaque-encrypted-replica', 1)");
        const manifest = await worker.prepareExecutorMigration(16);
        manifestHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(manifest)));

        await worker.acknowledgeExecutorMigration(16, manifestHash);
        await worker.acknowledgeExecutorMigration(16, manifestHash);

        expect(ctx.storage.sql.exec("SELECT * FROM automation_identities").toArray()).toEqual([]);
        expect(ctx.storage.sql.exec("SELECT * FROM automation_replica").toArray()).toEqual([]);
        expect(ctx.storage.sql.exec("SELECT * FROM automation_registration").toArray()).toEqual([]);
        expect(await worker.intakeIntegrationRouting()).toEqual(routing);
        expect(await worker.executionRoute()).toEqual({ origin, epoch: 16 });
        expect(await worker.executorMigrationManifestHash()).toBe(manifestHash);
      });
    } finally { vi.unstubAllGlobals(); }
  });

  it("Given a frozen source snapshot, When its page is requested, Then page ciphertext is bound to the migration manifest", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("migration-sealed-pages");
    await runInDurableObject(stub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, coordinatorEnv());
      const worker = new AutomationCoordinator(ctx, coordinatorEnv());
      ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, 'owner', 'workspace', 'migration-sealed-pages')");
      const manifest = await worker.prepareExecutorMigration(13);
      const page = await worker.readExecutorMigrationPage(13, "automation_registration", 0);

      expect(manifest.tables[0]?.name).toBe("automation_registration");
      expect(page).toMatchObject({ table: "automation_registration", offset: 0 });
      expect(typeof page.nonce).toBe("string");
      expect(typeof page.ciphertext).toBe("string");
      await expect(worker.readExecutorMigrationPage(14, "automation_registration", 0)).rejects.toThrow(/epoch|migration/i);
    });
  });

  it("Given an item command response is lost, When outbox retries, Then the same frozen classification is forwarded", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("migration-lost-forward-response");
    let manifestHash = "";
    const itemBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/status")) return Response.json({ status: "active", epoch: 14, manifestHash });
      if (url.pathname.endsWith("/rpc")) return Response.json({
        integrationId: "migration-lost-forward-response", control: "active", employeeProfile: { stack: "", work_profile: "" },
        allowedSources: { website: true, email: true },
      });
      itemBodies.push(String(init?.body));
      return itemBodies.length === 1 ? Response.json({ error: "temporary outage" }, { status: 503 }) : Response.json({ status: "accepted" }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(stub, async (_instance, ctx) => {
        const worker = new AutomationCoordinator(ctx, coordinatorEnv());
        const manifest = await worker.prepareExecutorMigration(14);
        manifestHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(manifest)));
        await worker.acknowledgeExecutorMigration(14, manifestHash);
        const event: AutomationEvent = { source: "email", receivedAt: "2026-10-16T10:00:00.000Z", rawMime: "", message: {
          messageId: "<confirm@example.test>", inReplyTo: null, references: [], from: "jobs@example.test", to: "owner@example.test",
          subject: "Confirm forwarding", text: "Confirm your forwarding address", date: null, urls: [], confirmation: true, attachments: [],
        } };
        const rawMime = new TextEncoder().encode("Message-ID: <confirm@example.test>\r\nSubject: Confirm forwarding\r\n\r\nConfirm forwarding address");
        const eventWithOriginal = { ...event, rawMime: encodeBase64Url(rawMime) };
        const input = { eventId: "b".repeat(43), sourceId: "<confirm@example.test>", bodyHash: await sha256Base64Url(rawMime),
          payload: await encryptEventPayload(secret, "b".repeat(43), eventWithOriginal) };
        await worker.enqueueEmail(input);

        await worker.alarm();
        const firstStored = ctx.storage.sql.exec<{ classification_payload: string | null; state: string }>(
          "SELECT classification_payload, state FROM executor_intake_outbox WHERE event_id = ?", input.eventId).one();
        expect(firstStored.classification_payload).toBeTruthy();
        expect(firstStored.state).not.toBe("forwarded");
        ctx.storage.sql.exec("UPDATE executor_intake_outbox SET next_attempt_at = 0 WHERE event_id = ?", input.eventId);

        await worker.alarm();
        expect(itemBodies).toHaveLength(2);
        expect(itemBodies[0]).toBe(itemBodies[1]);
        expect(ctx.storage.sql.exec<{ state: string }>("SELECT state FROM executor_intake_outbox WHERE event_id = ?", input.eventId).one().state)
          .toBe("forwarded");
      });
    } finally { vi.unstubAllGlobals(); }
  });
});

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 0x8000) binary += String.fromCharCode(...value.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
