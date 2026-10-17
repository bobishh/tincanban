import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import worker, { type WorkerEnv } from "../src/index";
import { runPipeline } from "../src/pipeline";
import { profileFromIdentitySeedForDevice } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import { createAutomationOwnerRequest as createVerifiedOwnerRequest, type AutomationOwnerRequestInput } from "../../../src/domain/automationProtocol";
import { resolveSigningContext } from "../../../src/domain/signingContext";
import { AutomationCoordinator, writeReplicaChunksAtomically } from "../src/coordinator";

const testEnv = {
  ...env,
  HUMAN_CHECK_SECRET: "test-only-human-check-secret-with-at-least-thirty-two-bytes",
  IDENTITY_STORAGE_SECRET: "test-only-identity-storage-secret-with-at-least-thirty-two-bytes",
  EVENT_STORAGE_SECRET: "test-only-event-storage-secret-with-at-least-thirty-two-bytes",
  PROVISIONING_TOKEN: "test-only-provisioning-token-with-enough-entropy",
  INTEGRATIONS_JSON: JSON.stringify([{
    id: "test-integration",
    workspaceId: "test-workspace",
    scope: {
      version: 1,
      boardId: "test-board",
      columns: { lead: "lead", interview: "interview", rejected: "rejected" },
      fieldIds: { company: "company", role: "role", jobUrl: "job-url" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    emailAddress: "intake@example.test",
    allowedForwarders: ["owner@example.test"],
  }, {
    id: "expired-integration",
    workspaceId: "expired-workspace",
    scope: {
      version: 1,
      boardId: "expired-board",
      columns: { lead: "lead", interview: "interview", rejected: "rejected" },
      fieldIds: { company: "company", role: "role", jobUrl: "job-url" },
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
    allowedForwarders: [],
  }]),
  CORS_ORIGINS: "https://app.example.test",
} as unknown as WorkerEnv;

async function createAutomationOwnerRequest(profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>,
  input: AutomationOwnerRequestInput) {
  const context = await resolveSigningContext({ profile, certificates: [profile.certificate], purpose: "automation-owner-request",
    binding: { origin: input.origin, workspaceId: input.workspaceId, integrationId: input.integrationId, action: input.action },
    authorityRevision: "fixture-owner-policy", current: async () => ({ personId: profile.identity.personId,
      deviceId: profile.device.deviceId, authorityRevision: "fixture-owner-policy" }) });
  return createVerifiedOwnerRequest(context, input);
}

async function fetchWorker(request: Request, environment: WorkerEnv = testEnv): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, environment, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("automation Worker", () => {
  it("Given a concurrently replaced replica generation, When publishing access maintenance, Then reject its stale generation before any write", async () => {
    const writes: string[] = [];
    const storage = { transactionSync: <T>(run: () => T) => run(), sql: { exec(statement: string) {
      if (!statement.includes("SELECT state_generation")) writes.push(statement);
      return { toArray: () => [{ state_generation: "newer-generation" }] };
    } } };
    expect(() => Reflect.apply(writeReplicaChunksAtomically, undefined,
      [storage, "maintenance-generation", ["ciphertext"], Date.now(), undefined, "captured-generation"])).toThrow(/changed|generation/i);
    expect(writes).toEqual([]);
  });

  it("Given an existing replica generation, When routing publication fails, Then roll back the new chunks, pointer and registration together", async () => {
    const stub = testEnv.AUTOMATION.getByName("managed-routing-rollback");
    const secret = testEnv.EVENT_STORAGE_SECRET!;
    const original = JSON.stringify({ retained: "original durable replica" });
    await stub.saveReplicaState(secret, original);
    await runInDurableObject(stub, async (instance, ctx) => {
      const previous = ctx.storage.sql.exec<{ state_generation: string }>("SELECT state_generation FROM automation_replica WHERE singleton = 1").one().state_generation;
      ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id, routing) VALUES (1, 'old-owner', 'workspace', 'managed-routing-rollback', 'old-routing')");
      expect(() => writeReplicaChunksAtomically(ctx.storage, "uncommitted-generation", ["uncommitted ciphertext"], Date.now(), () => {
        ctx.storage.sql.exec("UPDATE automation_registration SET owner_id = 'new-owner', routing = 'new-routing' WHERE singleton = 1");
        throw new Error("Routing publication interrupted");
      })).toThrow("Routing publication interrupted");
      expect(ctx.storage.sql.exec<{ state_generation: string }>("SELECT state_generation FROM automation_replica WHERE singleton = 1").one().state_generation).toBe(previous);
      expect(ctx.storage.sql.exec("SELECT data FROM automation_replica_chunks WHERE generation = 'uncommitted-generation'").toArray()).toEqual([]);
      expect(ctx.storage.sql.exec<{ owner_id: string; routing: string }>("SELECT owner_id, routing FROM automation_registration WHERE singleton = 1").one())
        .toEqual({ owner_id: "old-owner", routing: "old-routing" });
      expect(await instance.loadReplicaState(secret)).toBe(original);
    });
  });

  it("Given encrypted replica state larger than 2 MiB, When its chunks are committed, Then all chunks and generation pointer change in one synchronous transaction", () => {
    const operations: Array<{ sql: string; inTransaction: boolean }> = [];
    let inTransaction = false;
    const storage = {
      transactionSync<T>(callback: () => T): T {
        inTransaction = true;
        try { return callback(); } finally { inTransaction = false; }
      },
      sql: {
        exec(statement: string) {
          operations.push({ sql: statement, inTransaction });
          if (statement.includes("SELECT state_generation")) {
            return { toArray: () => [{ state_generation: "old-generation" }] };
          }
          return { toArray: () => [] };
        },
      },
    };
    const encryptedFixture = "x".repeat(3_000_000);
    const chunks = Array.from({ length: Math.ceil(encryptedFixture.length / 900_000) }, (_, index) =>
      encryptedFixture.slice(index * 900_000, (index + 1) * 900_000));

    writeReplicaChunksAtomically(storage as never, "new-generation", chunks, Date.now());

    expect(chunks.length).toBeGreaterThan(2);
    expect(operations.length).toBe(chunks.length + 3);
    expect(operations.every(operation => operation.inTransaction)).toBe(true);
    expect(operations[0]?.sql).toContain("SELECT state_generation");
    expect(operations.at(-2)?.sql).toContain("state_generation = excluded.state_generation");
    expect(operations.at(-1)?.sql).toContain("DELETE FROM automation_replica_chunks");
  });

  it("Given serialized replica state larger than 2 MiB, When saved and loaded by the Durable Object, Then the full state survives encryption and chunking", async () => {
    const coordinator = testEnv.AUTOMATION.getByName("oversized-state");
    const secret = "test-only-replica-storage-secret-with-at-least-thirty-two-bytes";
    const serialized = JSON.stringify({ payload: "x".repeat(2_500_000) });
    await coordinator.saveReplicaState(secret, serialized);

    expect(await coordinator.loadReplicaState(secret)).toBe(serialized);
  });

  it("Given the Worker is running, When health is checked, Then it reports ready", async () => {
    const response = await fetchWorker(new Request("https://automation.test/health"));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });
  });

  it("Given a Worker build has a commit SHA, When health and capabilities are read, Then both expose that exact build identity", async () => {
    const sha = "a".repeat(40);
    const buildEnv = { ...testEnv, RELEASE_SHA: sha };
    const health = await fetchWorker(new Request("https://automation.test/health"), buildEnv);
    const capabilities = await fetchWorker(new Request("https://automation.test/v2/capabilities"), buildEnv);

    expect(await health.json()).toMatchObject({ status: "ready", buildSha: sha });
    expect(await capabilities.json()).toMatchObject({ version: 2, buildSha: sha, readers: { automationState: 5 } });
  });

  it("Given a Worker has no valid build SHA, When health and capabilities are read, Then report unknown explicitly", async () => {
    for (const configured of [undefined, "unknown", "not-a-commit"]) {
      const buildEnv = { ...testEnv, RELEASE_SHA: configured } as WorkerEnv;
      const health = await fetchWorker(new Request("https://automation.test/health"), buildEnv);
      const capabilities = await fetchWorker(new Request("https://automation.test/v2/capabilities"), buildEnv);

      expect(await health.json()).toMatchObject({ status: "ready", buildSha: null });
      expect(await capabilities.json()).toMatchObject({ version: 2, buildSha: null, readers: { automationState: 5 } });
    }
  });

  it("Given the configured browser origin, When activation preflight is requested, Then bearer and PUT are allowed", async () => {
    const response = await fetchWorker(new Request("https://automation.test/v1/integrations/test-integration/activation", {
      method: "OPTIONS", headers: { origin: "https://app.example.test", "access-control-request-method": "PUT" },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("Given a configured integration, When a challenge is requested, Then it returns a signed prompt", async () => {
    const response = await fetchWorker(new Request("https://automation.test/v1/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ integrationId: "test-integration" }),
    }));

    expect(response.status, await response.clone().text()).toBe(200);
    const challenge = await response.json() as { token: string; prompt: string };
    expect(challenge.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(challenge.prompt).toMatch(/^What is \d \+ \d\?$/);
  });

  it("Given operator authorization, When automation identity is provisioned twice, Then its public certificate is stable", async () => {
    const request = () => fetchWorker(new Request("https://automation.test/v1/integrations/test-integration/identity", {
      method: "POST",
      headers: { authorization: "Bearer test-only-provisioning-token-with-enough-entropy" },
    }));
    const first = await request();
    const second = await request();
    const profile = await first.json() as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(profile).toMatchObject({ integrationId: "test-integration" });
    expect(profile.personId).toEqual((await second.json() as Record<string, unknown>).personId);
    expect(profile).toHaveProperty("deviceCertificate");
    expect(profile).not.toHaveProperty("privateKey");
    expect(profile).not.toHaveProperty("identitySeed");
  });

  it("Given an operator but no approved integration scope, When provisioning the Worker identity, Then it returns only the public identity needed for owner approval", async () => {
    const response = await fetchWorker(new Request("https://automation.test/v1/integrations/preapproval-identity/identity", {
      method: "POST",
      headers: { authorization: "Bearer test-only-provisioning-token-with-enough-entropy" },
    }));
    const profile = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(profile).toMatchObject({ integrationId: "preapproval-identity" });
    expect(profile).toHaveProperty("deviceCertificate");
    expect(profile).not.toHaveProperty("privateKey");
  });

  it("Given no operator authorization, When an unconfigured identity is requested, Then it returns unauthorized", async () => {
    const response = await fetchWorker(new Request("https://automation.test/v1/integrations/preapproval-identity/identity", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("Given a provisioned public identity but no approved scope, When challenge and intake are requested, Then both remain unavailable", async () => {
    const challenge = await fetchWorker(new Request("https://automation.test/v1/challenge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ integrationId: "preapproval-identity" }),
    }));
    const intake = await fetchWorker(new Request("https://automation.test/v1/intake/preapproval-identity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(challenge.status).toBe(404);
    expect(intake.status).toBe(404);
  });

  it("Given operator authorization, When activation omits its signed scope packet, Then it rejects before storing a replica", async () => {
    const response = await fetchWorker(new Request("https://automation.test/v1/integrations/test-integration/activation", {
      method: "PUT", headers: { authorization: "Bearer test-only-provisioning-token-with-enough-entropy", "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Activation grant does not match configured integration scope" });
  });

  it("Given a valid challenge, When website intake is retried, Then it stores one durable event", async () => {
    const challengeResponse = await fetchWorker(new Request("https://automation.test/v1/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ integrationId: "test-integration" }),
    }));
    const challenge = await challengeResponse.json() as { token: string; prompt: string };
    const [left, right] = challenge.prompt.match(/\d+/g)!.map(Number);
    const body = JSON.stringify({
      message: "Senior backend engineer opening",
      contact: "owner@example.test",
      company: "Example GmbH",
      role: "Senior Backend Engineer",
      jobUrl: "https://jobs.example.test/123",
      humanCheckToken: challenge.token,
      humanCheckAnswer: String(left + right),
    });
    const headers = { "content-type": "application/json", "Idempotency-Key": "website-event-1" };
    const first = await fetchWorker(new Request("https://automation.test/v1/intake/test-integration", {
      method: "POST", headers, body,
    }));
    const accepted = await first.json() as { eventId: string; status: string; durable: boolean; duplicate: boolean };

    expect(first.status, JSON.stringify(accepted)).toBe(202);
    expect(accepted).toMatchObject({ status: "pending", durable: true, duplicate: false });

    const retry = await fetchWorker(new Request("https://automation.test/v1/intake/test-integration", {
      method: "POST", headers, body,
    }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ eventId: accepted.eventId, durable: true, duplicate: true });

    const challengeReplay = await fetchWorker(new Request("https://automation.test/v1/intake/test-integration", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "website-event-2" }, body,
    }));
    expect(challengeReplay.status).toBe(409);

    const unauthorizedStatus = await fetchWorker(new Request(`https://automation.test/v1/integrations/test-integration/events/${accepted.eventId}`));
    expect(unauthorizedStatus.status).toBe(401);
    const status = await fetchWorker(new Request(`https://automation.test/v1/integrations/test-integration/events/${accepted.eventId}`, {
      headers: { authorization: "Bearer test-only-provisioning-token-with-enough-entropy" },
    }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ eventId: accepted.eventId, status: "pending", source: "website" });
  });

  it("Given an expired integration, When intake is requested, Then it rejects before consuming the challenge", async () => {
    const response = await fetchWorker(new Request("https://automation.test/v1/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ integrationId: "expired-integration" }),
    }));

    expect(response.status, await response.clone().text()).toBe(403);
  });

  it("Given an email needing review, when its bound owner retries, then requeue the same event and preserve applied-event deduplication", async () => {
    const stub = testEnv.AUTOMATION.getByName("retry-email-integration");
    const owner = { ownerPersonId: "retry-owner", workspaceId: "retry-workspace", integrationId: "retry-email-integration" };
    const eventId = await digestIdForTest("upvest-review-retry");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, ?, ?, ?)", owner.ownerPersonId, owner.workspaceId, owner.integrationId);
    });
    await stub.enqueueEmail({ eventId, sourceId: "upvest-review-retry", bodyHash: "fixed-body", payload: "encrypted-original" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE events SET status = 'review', result = ? WHERE event_id = ?", JSON.stringify({ reason: "Company context does not identify a role" }), eventId);
    });
    const retry = stub as unknown as { retryEmail: (registration: typeof owner, eventId: string) => Promise<{ status: string }> };
    await expect(retry.retryEmail(owner, eventId)).resolves.toMatchObject({ status: "pending" });
    expect(await stub.getEvent(eventId)).toMatchObject({ eventId, status: "pending" });
    const denied = await runInDurableObject(stub, async instance => {
      try { await instance.retryEmail({ ...owner, ownerPersonId: "foreign-owner" }, eventId); return false; }
      catch { return true; }
    });
    expect(denied).toBe(true);
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE events SET status = 'applied' WHERE event_id = ?", eventId); });
    await expect(retry.retryEmail(owner, eventId)).resolves.toMatchObject({ status: "applied" });
  });

  it("Given an approved forwarder and recipient, When forwarded email arrives, Then it is durably queued for that integration", async () => {
    const raw = [
      "From: recruiter@example.test",
      "To: owner@example.test",
      "Subject: Interview invitation",
      "Message-ID: <mail-1@example.test>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "We would like to schedule an interview for the Senior Engineer role.",
    ].join("\r\n");
    const rejection: string[] = [];
    await worker.email!({
      from: "owner@example.test",
      to: "intake@example.test",
      raw: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.close(); } }),
      rawSize: new TextEncoder().encode(raw).byteLength,
      headers: new Headers(),
      setReject(reason: string) { rejection.push(reason); },
      async forward() { throw new Error("not expected"); },
      async reply() { throw new Error("not expected"); },
    } as ForwardableEmailMessage, testEnv, createExecutionContext());

    expect(rejection).toEqual([]);
    const eventId = await digestIdForTest("test-integration:email:<mail-1@example.test>");
    const event = await testEnv.AUTOMATION.getByName("test-integration").getEvent(eventId);
    expect(event).toMatchObject({ eventId, source: "email", status: "pending" });
  });

  it("Given forwarded mail without Message-ID, When the same MIME bytes arrive again, Then the digest deduplicates retries", async () => {
    const raw = ["From: recruiter@example.test", "Subject: Role update", "Content-Type: text/plain; charset=utf-8", "", "Interview scheduled."].join("\r\n");
    const bytes = new TextEncoder().encode(raw);
    const deliver = async () => {
      const rejection: string[] = [];
      await worker.email!({
        from: "owner@example.test", to: "intake@example.test",
        raw: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        rawSize: bytes.byteLength, headers: new Headers(),
        setReject(reason: string) { rejection.push(reason); },
        async forward() { throw new Error("not expected"); }, async reply() { throw new Error("not expected"); },
      } as ForwardableEmailMessage, testEnv, createExecutionContext());
      expect(rejection).toEqual([]);
    };
    await deliver();
    await deliver();
    const mimeHash = await digestIdForTest(raw);
    const eventId = await digestIdForTest(`test-integration:email:sha256:${mimeHash}`);
    const event = await testEnv.AUTOMATION.getByName("test-integration").getEvent(eventId);
    expect(event).toMatchObject({ eventId, source: "email" });
  });


  it("Given a sender outside the integration allowlist, When email arrives, Then it is rejected before parsing", async () => {
    const rejection: string[] = [];
    await worker.email!({
      from: "attacker@example.test",
      to: "intake@example.test",
      raw: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array()); controller.close(); } }),
      rawSize: 0,
      headers: new Headers(),
      setReject(reason: string) { rejection.push(reason); },
      async forward() { throw new Error("not expected"); },
      async reply() { throw new Error("not expected"); },
    } as ForwardableEmailMessage, testEnv, createExecutionContext());

    expect(rejection).toEqual(["Sender is not approved for this automation integration"]);
  });

  it("Given a private forwarding recipient, When Gmail preserves the original SMTP sender, Then it queues mail but rejects a changed recipient", async () => {
    const address = "jobs-" + "a".repeat(32) + "@example.test";
    const routed = { ...testEnv, EMAIL_ROUTES_JSON: JSON.stringify([{ id: "test-integration", address, mailbox: "owner@example.test" }]) };
    const raw = new TextEncoder().encode("From: recruiter@example.test\r\nMessage-ID: <gmail-forward@example.test>\r\n\r\nApplication received");
    for (const recipient of [address, address.replace("aaa", "aab")]) {
      const rejection: string[] = [];
      await worker.email!({ from: "recruiter@example.test", to: recipient, rawSize: raw.length,
        raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
        headers: new Headers(), setReject(reason: string) { rejection.push(reason); },
        async forward() { throw new Error("not expected"); }, async reply() { throw new Error("not expected"); },
      } as ForwardableEmailMessage, routed, createExecutionContext());
      expect(rejection).toEqual(recipient === address ? [] : ["Unknown automation forwarding address"]);
    }
    const eventId = await digestIdForTest("test-integration:email:<gmail-forward@example.test>");
    expect(await testEnv.AUTOMATION.getByName("test-integration").getEvent(eventId)).toMatchObject({ source: "email", status: "pending" });
  });

  it("Given a clear vacancy decision, When Clef classifies intake, Then it records a review instead of claiming a board write", async () => {
    const roleProbabilities = { backend: 1, frontend: 0, fullstack: 0, platform_devops: 0, data_ai: 0,
      mobile: 0, engineering_management: 0, other_unknown: 0 };
    const seniorityProbabilities = { intern_junior: 0, middle: 0, senior: 1, staff_principal: 0, lead_manager: 0, unknown: 0 };
    const ai = { run: async () => ({ answers: {
      ...Object.fromEntries(['company_recognition', 'company_stability', 'stack_fit', 'work_fit'].map(key => [key, {
        type: 'choice', choice: 'unknown', confidence: 1, probabilities: { strong: 0, partial: 0, weak: 0, unknown: 1 },
      }])),
      job_opportunity: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0, uncertain: 0 } },
      role_type: { type: "choice", choice: "backend", confidence: 1, probabilities: roleProbabilities },
      seniority: { type: "choice", choice: "senior", confidence: 1, probabilities: seniorityProbabilities },
    } }) };
    const result = await runPipeline({
      source: "website",
      receivedAt: "2026-10-08T00:00:00.000Z",
      submission: { message: "Hiring now", contact: "owner@example.test", company: "Example GmbH",
        role: "Senior Backend Engineer", jobUrl: "https://jobs.example.test/123" },
    }, ai, async () => new Response('<title>Senior Backend Engineer</title><meta property="og:site_name" content="Example GmbH">', {
      headers: { "content-type": "text/html" },
    }));

    expect(result).toMatchObject({ status: "review", decision: { relevance: "yes" } });
    expect(result.reason).toContain("confidence and an approved scope");
  });

  it("Given a forwarded vacancy URL and employee profile, When intake classifies it, Then it extracts the job and assesses the same priority as website intake", async () => {
    const profile = { stack: "Ruby, Rails", work_profile: "Senior Software Engineer" };
    const ai = { run: async (_model: string, input: unknown) => {
      const request = input as { questions: Record<string, unknown>; state: unknown };
      if (request.questions.application_event) return { answers: { application_event: {
        type: "choice", choice: "new_opportunity", confidence: 1, probabilities: { applied: 0, new_opportunity: 1, interview: 0, rejected: 0, offer: 0, follow_up: 0, unrelated: 0, uncertain: 0 },
      } } };
      expect(request.state).toMatchObject({ employee_profile: profile });
      return { answers: { ...Object.fromEntries(["company_recognition", "company_stability", "stack_fit", "work_fit"].map(key => [key, {
        type: "choice", choice: "strong", confidence: 1, probabilities: { strong: 1, partial: 0, weak: 0, unknown: 0 },
      }])), job_opportunity: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0, uncertain: 0 } },
      role_type: { type: "choice", choice: "backend", confidence: 1, probabilities: { backend: 1, frontend: 0, fullstack: 0, platform_devops: 0, data_ai: 0, mobile: 0, engineering_management: 0, other_unknown: 0 } },
      seniority: { type: "choice", choice: "senior", confidence: 1, probabilities: { intern_junior: 0, middle: 0, senior: 1, staff_principal: 0, lead_manager: 0, unknown: 0 } } } };
    } };
    const result = await runPipeline({ source: "email", receivedAt: new Date().toISOString(), rawMime: "",
      message: { from: "recruiter@example.test", to: "owner@example.test", messageId: "<vacancy@example.test>", inReplyTo: null,
        references: [], subject: "Job opportunity", text: "Senior Software Engineer at Example GmbH", date: null,
        urls: ["https://jobs.example.test/42"], confirmation: false, attachments: [] } }, ai,
      async () => new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Software Engineer","hiringOrganization":{"name":"Example GmbH"},"description":"Ruby and Rails"}</script>', { headers: { "content-type": "text/html" } }), profile);
    expect(result.opportunity).toMatchObject({ priority: { score: 10, optionId: "p0" } });
    expect(result.extraction).toMatchObject({ company: "Example GmbH", role: "Senior Software Engineer" });
  });

  it("Given a forwarding confirmation, When mail is classified, Then it stays visible for owner review without AI", async () => {
    const result = await runPipeline({
      source: "email",
      receivedAt: "2026-10-08T00:00:00.000Z",
      message: { messageId: "<confirm@example.test>", inReplyTo: null, references: [], from: "Cloudflare <noreply@example.test>",
        to: "owner@example.test", subject: "Confirm email forwarding", text: "Please confirm this forwarding address.",
        date: null, urls: [], confirmation: true, attachments: [] },
      rawMime: "",
    }, { run: async () => { throw new Error("AI should not run for confirmation mail"); } });

    expect(result).toMatchObject({ status: "review", reason: "Forwarding-address confirmation requires owner attention" });
  });
});

async function digestIdForTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

it("Given deployment-approved owners, when browser enrollment is signed, then identity provisioning is idempotent and another owner cannot rebind the instance", async () => {
  const owner = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Owner", crypto.getRandomValues(new Uint8Array(32)));
  const other = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Other", crypto.getRandomValues(new Uint8Array(32)));
  const origin = "https://worker.example.test";
  const scopedEnv = { ...testEnv, AUTOMATION_OWNER_IDS: `${owner.identity.personId},${other.identity.personId}` };
  const integrationId = crypto.randomUUID();
  const enroll = async (profile: typeof owner, workspaceId: string) => {
    const ownerRequest = await createAutomationOwnerRequest(profile, { action: "enroll", origin, integrationId, workspaceId, bodyHash: null });
    return worker.fetch(new Request(`${origin}/v2/integrations/${integrationId}/identity`, { method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" }, body: JSON.stringify({ ownerRequest }) }), scopedEnv, createExecutionContext());
  };
  const first = await enroll(owner, "workspace");
  expect(first.status).toBe(200);
  const identity = await first.json();
  expect(await (await enroll(owner, "workspace")).json()).toEqual(identity);
  const conflict = await enroll(other, "workspace");
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
  expect((await enroll(owner, "another-workspace")).status).toBe(409);
});

it("Given a signed public status observation, when replayed against private email setup, then rejects it before reading routing secrets", async () => {
  const owner = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(77), "Owner", new Uint8Array(32).fill(78));
  const integrationId = crypto.randomUUID();
  const origin = "https://automation.test";
  const ownerRequest = await createAutomationOwnerRequest(owner, { action: "observe", origin, integrationId, workspaceId: "workspace", bodyHash: null });
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}/v2/integrations/${integrationId}/email`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerRequest }),
  }), { ...testEnv, AUTOMATION_OWNER_IDS: owner.identity.personId }, context);
  await waitOnExecutionContext(context);
  expect(response.status).toBe(400);
});
