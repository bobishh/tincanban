import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ExecutionCoordinator } from "../src/executionCoordinator";
import { AutomationCoordinator } from "../src/coordinator";
import { readCloudflareFreshRoute, readNodeFreshBinding, reserveCloudflareFreshRoute, reserveNodeFreshBinding,
  type ExecutorFreshBinding } from "../src/executorFresh";
import type { WorkerEnv } from "../src/index";
import { freshBindingHash } from "../src/executorFresh";

const binding: ExecutorFreshBinding = {
  integrationId: "fresh-instance-one", ownerPersonId: "owner-one", workspaceId: "workspace-one",
  origin: "https://executor.example", epoch: 7,
};

function workerEnv(): WorkerEnv {
  return { ...env, AI: { run: async () => { throw new Error("Fresh reservation must not classify"); } }, INTEGRATIONS_JSON: "[]" } as unknown as WorkerEnv;
}

describe("executor fresh bootstrap reservation", () => {
  it("Given a new signed enrollment, When CF reserves and bootstraps Node, Then identity returns only after exact route confirmation", async () => {
    const runtime = env as unknown as WorkerEnv;
    const integrationId = "fresh-bootstrap-do";
    const stub = runtime.AUTOMATION.getByName(integrationId);
    const serviceToken = "fresh-bootstrap-service-token-with-at-least-thirty-two-bytes";
    const enrolled = { ...binding, integrationId, epoch: 1 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      identity: { personId: "automation-person-1", publicKey: "automation-key" },
      device: { deviceId: "device-1", publicKey: "device-key" }, deviceCertificate: {
        payload: { kind: "device-certificate", version: 1, personId: "automation-person-1", deviceId: "device-1", devicePublicKey: "device-key" },
        signerKeyId: "automation-person-1", signature: "signed-certificate",
      },
      epoch: enrolled.epoch, bindingHash: await freshBindingHash(enrolled),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runInDurableObject(stub, async (_instance, ctx) => {
        const worker = new AutomationCoordinator(ctx, { ...workerEnv(), EXECUTOR_ORIGIN: enrolled.origin, EXECUTOR_SERVICE_TOKEN: serviceToken });
        const profile = await worker.enrollOwner({ integrationId, ownerPersonId: enrolled.ownerPersonId, workspaceId: enrolled.workspaceId }, "identity-secret-must-stay-local");
        expect(profile.identity.personId).toBe(enrolled.ownerPersonId);
        expect(await worker.executionRoute()).toEqual({ origin: enrolled.origin, epoch: enrolled.epoch });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(`https://executor.example/internal/integrations/${integrationId}/bootstrap`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${serviceToken}`);
        expect(JSON.parse(String(init?.body))).toEqual(enrolled);
        expect(String(init?.body)).not.toContain("identity-secret-must-stay-local");
        expect(ctx.storage.sql.exec("SELECT binding_hash FROM executor_fresh_route").toArray()).toHaveLength(1);
      });
    } finally { vi.unstubAllGlobals(); }
  });

  it("Given an empty participant, When CF and Node reserve the same binding, Then retries preserve one canonical route", async () => {
    const runtime = env as unknown as WorkerEnv;
    const cfStub = runtime.AUTOMATION.getByName("fresh-binding-cf");
    const nodeStub = runtime.AUTOMATION.getByName("fresh-binding-node");
    await runInDurableObject(cfStub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, workerEnv());
      const first = await reserveCloudflareFreshRoute(ctx.storage, binding);
      expect(first.binding).toEqual(binding);
      expect(await readCloudflareFreshRoute(ctx.storage)).toEqual(binding);
      expect(await reserveCloudflareFreshRoute(ctx.storage, binding)).toEqual(first);
    });
    await runInDurableObject(nodeStub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, workerEnv());
      expect(await readNodeFreshBinding(ctx.storage)).toBeNull();
      const first = await reserveNodeFreshBinding(ctx.storage, binding);
      expect(first.binding).toEqual(binding);
      expect(await readNodeFreshBinding(ctx.storage)).toEqual(binding);
      expect(await reserveNodeFreshBinding(ctx.storage, binding)).toEqual(first);
    });
  });

  it("Given retained legacy rows, When a fresh route is requested, Then CF and Node refuse to claim that integration", async () => {
    const runtime = env as unknown as WorkerEnv;
    const cfStub = runtime.AUTOMATION.getByName("fresh-binding-cf-legacy");
    const nodeStub = runtime.AUTOMATION.getByName("fresh-binding-node-legacy");
    await runInDurableObject(cfStub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, workerEnv());
      ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, 'owner-one', 'workspace-one', 'fresh-instance-one')");
      await expect(reserveCloudflareFreshRoute(ctx.storage, binding)).rejects.toThrow(/legacy|migration/i);
      expect(await readCloudflareFreshRoute(ctx.storage)).toBeNull();
    });
    await runInDurableObject(nodeStub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, workerEnv());
      ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, 'owner-one', 'workspace-one', 'fresh-instance-one')");
      await expect(reserveNodeFreshBinding(ctx.storage, binding)).rejects.toThrow(/legacy|migration/i);
      expect(await readNodeFreshBinding(ctx.storage)).toBeNull();
    });
  });

  it("Given an existing fresh reservation, When a different owner, workspace, origin or epoch retries, Then the binding conflicts", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("fresh-binding-conflict");
    await runInDurableObject(stub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, workerEnv());
      await reserveNodeFreshBinding(ctx.storage, binding);
      await expect(reserveNodeFreshBinding(ctx.storage, { ...binding, ownerPersonId: "other-owner" })).rejects.toThrow(/binding|conflict/i);
      await expect(reserveNodeFreshBinding(ctx.storage, { ...binding, workspaceId: "other-workspace" })).rejects.toThrow(/binding|conflict/i);
      await expect(reserveNodeFreshBinding(ctx.storage, { ...binding, origin: "https://other-executor.example" })).rejects.toThrow(/binding|conflict/i);
      await expect(reserveNodeFreshBinding(ctx.storage, { ...binding, epoch: binding.epoch + 1 })).rejects.toThrow(/binding|conflict/i);
    });
  });

  it("Given a migration marker, When CF requests fresh reservation, Then migration owns the route", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("fresh-binding-migration-conflict");
    await runInDurableObject(stub, async (_instance, ctx) => {
      new ExecutionCoordinator(ctx, workerEnv());
      ctx.storage.sql.exec(`CREATE TABLE executor_migration (singleton INTEGER PRIMARY KEY, phase TEXT NOT NULL, origin TEXT NOT NULL,
        epoch INTEGER NOT NULL, manifest_json TEXT, manifest_hash TEXT, updated_at INTEGER NOT NULL)`);
      ctx.storage.sql.exec("INSERT INTO executor_migration (singleton, phase, origin, epoch, updated_at) VALUES (1, 'frozen', 'https://executor.example', 7, ?)", Date.now());
      await expect(reserveCloudflareFreshRoute(ctx.storage, binding)).rejects.toThrow(/migration|reserved/i);
      expect(await readCloudflareFreshRoute(ctx.storage)).toBeNull();
    });
  });

  it("Given a reserved fresh route with no legacy tables, When website and email intake arrive, Then the adapter stores bounded outbox rows without creating legacy state", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("fresh-intake-outbox");
    await runInDurableObject(stub, async (_instance, ctx) => {
      const worker = new AutomationCoordinator(ctx, { ...workerEnv(), EXECUTOR_ORIGIN: binding.origin,
        EXECUTOR_SERVICE_TOKEN: "fresh-intake-service-token-with-at-least-thirty-two-bytes" });
      const freshBinding = { ...binding, integrationId: "fresh-intake-outbox" };
      await reserveCloudflareFreshRoute(ctx.storage, freshBinding);
      await expect(worker.enqueueEmail({ eventId: "e".repeat(43), sourceId: "message-id", bodyHash: "email-hash", payload: "bounded-ciphertext" }))
        .resolves.toMatchObject({ eventId: "e".repeat(43), status: "pending", duplicate: false });
      await expect(worker.enqueueWebsite({ eventId: "w".repeat(43), sourceId: "w".repeat(43), bodyHash: "website-hash", nonce: "fresh-challenge",
        challengeExpiresAt: Date.now() + 60_000, payload: "bounded-ciphertext" }))
        .resolves.toMatchObject({ eventId: "w".repeat(43), status: "pending", duplicate: false });
      expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','consumed_challenges')").toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT event_id FROM executor_intake_outbox ORDER BY event_id").toArray()).toHaveLength(2);
      expect(ctx.storage.sql.exec("SELECT nonce FROM executor_intake_challenges").toArray()).toEqual([{ nonce: "fresh-challenge" }]);
    });
  });

  it("Given an empty unreserved instance in configured production, When owner discovery runs, Then SQL-only discovery returns no match without constructing legacy runtime", async () => {
    const runtime = env as unknown as WorkerEnv;
    const stub = runtime.AUTOMATION.getByName("fresh-empty-discovery");
    await runInDurableObject(stub, async (_instance, ctx) => {
      const worker = new AutomationCoordinator(ctx, { ...workerEnv(), EXECUTOR_ORIGIN: binding.origin });
      await expect(worker.manageInstance({} as never, "discover", {} as never, "https://automation.example")).resolves.toBeNull();
      await expect(worker.applicationReview({} as never, "discover", {} as never, "https://automation.example")).resolves.toBeNull();
      expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='automation_registration'").toArray()).toEqual([]);
    });
  });
});
