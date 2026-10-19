import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReactionAi, runReaction, type ReactionParticipant, type ReactionRequest } from "../src/reactionRuntime.ts";

const input: ReactionRequest = {
  version: 1,
  runId: "run-1",
  sourceDigest: "a".repeat(64),
  signals: [{ id: "signal-1", source: "email", body: "hello", payload: { subject: "Hello" } }],
  participant: { integrationId: "integration-1", epoch: 1 },
  capabilities: { operations: ["item-command"], targets: ["integration-1"] },
};

test("Given the CLEF model path, when issuing Cloudflare inference, then preserve its slash segments and @ prefix", async () => {
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = "test-token-that-is-long-enough";
  globalThis.fetch = async input => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ success: true, result: { response: "{}" } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await createReactionAi().run("@cf/cloudflare/clef-flash", { prompt: "test" });
    assert.equal(new URL(requestedUrl).pathname,
      "/client/v4/accounts/" + "a".repeat(32) + "/ai/run/@cf/cloudflare/clef-flash");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("Given a reaction that submits a participant command, when run twice, then it reuses stable command identity and requires the Rusty receipt", async () => {
  const calls: unknown[] = [];
  const participant = stubParticipant({
    async enqueueItemCommand(_commandId, command) { calls.push(command); return { commandId: "command-1", status: "pending" }; },
    async getItemCommandResult() { return { status: "applied", changeHash: "change-1", storageReceipt: { requestId: "receipt-1" } }; },
  });
  const source = `export default async function(input, participant) {
    const command = await participant.enqueueItemCommand({ title: input.signals[0].payload.subject });
    return { commandId: command.commandId };
  }`;
  const request = { ...input, source, sourceDigest: createHash("sha256").update(source).digest("hex") };
  const first = await runReaction(request, participant);
  const second = await runReaction(request, participant);
  assert.equal(first.status, "completed");
  assert.equal(first.commands[0]?.changeHash, "change-1");
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(second.status, "completed");
});

test("Given an enqueued command without its durable receipt, when the reaction returns, then result stays pending", async () => {
  const participant = stubParticipant({
    async enqueueItemCommand() { return { commandId: "command-1", status: "pending" }; },
    async getItemCommandResult() { return { status: "pending" }; },
  });
  const source = `export default async function(_input, participant) {
    await participant.enqueueItemCommand({ title: "Approved" });
    return { ok: true };
  }`;
  const result = await runReaction({ ...input, source, sourceDigest: createHash("sha256").update(source).digest("hex") }, participant);
  assert.equal(result.status, "pending");
  assert.equal(result.commands[0]?.storageReceipt, undefined);
});

test("Given a fast CLI reaction with a queued command, when it is about to exit, then it flushes the shared writer before polling the receipt", async () => {
  let processed = false;
  const participant = stubParticipant({
    async enqueueItemCommand() { return { status: "pending" }; },
    async flushPendingCommands() { processed = true; },
    async getItemCommandResult() {
      return processed ? { status: "applied", changeHash: "change-flushed", storageReceipt: { requestId: "receipt-flushed" } }
        : { status: "pending" };
    },
  });
  const source = `export default async (_input, participant) => participant.enqueueItemCommand({ event: { id: "fast-cli" } })`;
  const result = await runReaction({ ...input, source, sourceDigest: createHash("sha256").update(source).digest("hex") }, participant);
  assert.equal(processed, true);
  assert.equal(result.status, "completed");
  assert.equal(result.commands[0]?.changeHash, "change-flushed");
});

test("Given a Rusty write whose command response is lost, when the same run resumes, then it reconciles the original command receipt", async () => {
  let stored = false;
  let storedId = "";
  const participant = stubParticipant({
    async enqueueItemCommand(commandId) {
      storedId = commandId;
      stored = true;
      throw new Error("response lost after journal commit");
    },
    async getItemCommandResult(commandId) {
      assert.equal(commandId, storedId);
      return stored ? { status: "applied", changeHash: "change-1", storageReceipt: { requestId: "receipt-1" } } : null;
    },
  });
  const source = `export default async (_input, participant) => participant.enqueueItemCommand({ event: { id: "stable" } })`;
  const result = await runReaction({ ...input, source, sourceDigest: createHash("sha256").update(source).digest("hex") }, participant);
  assert.equal(result.status, "completed");
  assert.equal(result.commands[0]?.commandId, storedId);
  assert.equal(result.commands[0]?.storageReceipt && typeof result.commands[0]?.storageReceipt, "object");
});

test("Given oversized JSON or an unsupported port capability, when invoked, then reaction fails before execution", async () => {
  const participant = stubParticipant({
    async enqueueItemCommand() { throw new Error("unexpected"); },
    async getItemCommandResult() { throw new Error("unexpected"); },
  });
  const oversized = `export default () => ({ x: "${"x".repeat(1_100_000)}" })`;
  await assert.rejects(runReaction({ ...input, source: oversized, sourceDigest: createHash("sha256").update(oversized).digest("hex") }, participant), /bound/);
  const source = `export default async (_input, participant) => participant.enqueueItemCommand({})`;
  const denied = await runReaction({ ...input, capabilities: { operations: [], targets: [] }, source,
    sourceDigest: createHash("sha256").update(source).digest("hex") }, participant);
  assert.equal(denied.status, "failed");
  assert.match(denied.error ?? "", /capabilit/);
  const classificationSource = `export default async (_input, participant) => participant.classifyApplicationEvent("mail")`;
  const classificationDenied = await runReaction({ ...input, capabilities: { operations: [], targets: [] }, source: classificationSource,
    sourceDigest: createHash("sha256").update(classificationSource).digest("hex") }, participant);
  assert.equal(classificationDenied.status, "failed");
  assert.match(classificationDenied.error ?? "", /clef.application-event/);
});

test("Given a target outside the participant grant, when the reaction submits a command, then it is denied", async () => {
  const participant = stubParticipant({
    async enqueueItemCommand() { throw new Error("unexpected write"); },
  });
  const source = `export default async (_input, participant) => participant.enqueueItemCommand({ title: "No" })`;
  const result = await runReaction({ ...input,
    capabilities: { operations: ["item-command"], targets: ["another-integration"] }, source,
    sourceDigest: createHash("sha256").update(source).digest("hex") }, participant);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /target/);
});

test("Given CLEF returns different answers on retry, when journal has retained its first answer, then reuse exact evidence and stable command ID", async () => {
  let classifyCalls = 0;
  const evidence = new Map<string, unknown>();
  const commandIds: string[] = [];
  const participant = stubParticipant({
    async getOrCreateOpportunity(key) {
      if (!evidence.has(key)) {
        classifyCalls += 1;
        evidence.set(key, { relevance: "yes", evidence: "first" });
      }
      return evidence.get(key) as never;
    },
    async enqueueItemCommand(commandId, command) { commandIds.push(commandId); return { status: "pending", command }; },
    async getItemCommandResult() { return { status: "applied", changeHash: "change-1", storageReceipt: { requestId: "receipt-1" } }; },
  });
  const source = `export default async (_input, participant) => {
    const decision = await participant.classifyOpportunity("same submission");
    return await participant.enqueueItemCommand({ event: { source: "website" }, classification: decision });
  }`;
  const request = { ...input, source, sourceDigest: createHash("sha256").update(source).digest("hex"),
    capabilities: { operations: ["item-command", "clef.opportunity"], targets: ["integration-1"] } };
  const first = await runReaction(request, participant);
  const second = await runReaction(request, participant);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(classifyCalls, 1);
  assert.equal(commandIds[0], commandIds[1]);
});


test("Given the current homepage signal, when reaction runs, then it sends the normalized website event through the existing scoped command path", async () => {
  let source: string;
  try { source = await readFile(new URL("../../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  catch { source = await readFile(new URL("../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  const submission = { message: "Please consider me", contact: "owner@example.test", company: "Nacre", role: "Engineer", jobUrl: "https://jobs.example.test/1" };
  let command: unknown;
  const participant = stubParticipant({
    async getOrCreateOpportunity(_key, _inputHash, _compute) { return { relevance: "yes" } as never; },
    async enqueueItemCommand(_commandId, value) { command = value; return { status: "pending" }; },
    async getItemCommandResult() { return { status: "applied", changeHash: "change-1", storageReceipt: { requestId: "receipt-1" } }; },
  });
  const request = { ...input, source, sourceDigest: createHash("sha256").update(source).digest("hex"),
    signals: [{ id: "signal-1", source: "website", external_id: "homepage-event-1", body: submission.message,
      payload: { source: "website", receivedAt: "2026-10-17T12:00:00.000Z", submission } }],
    capabilities: { operations: ["item-command", "clef.opportunity"], targets: ["integration-1"] } };
  const result = await runReaction(request, participant);
  assert.equal(result.status, "completed");
  assert.deepEqual(command, {
    event: { source: "website", receivedAt: "2026-10-17T12:00:00.000Z", submission },
    classification: { status: "review", reason: "Lead needs review until Clef confidence and an approved scope satisfy the write policy",
      source: { type: "website", receivedAt: "2026-10-17T12:00:00.000Z" }, decision: { relevance: "yes" } },
  });
});

test("Given a retained application receipt, when the default reaction retries, then it journals classification and queues the same raw event and command", async () => {
  let source: string;
  try { source = await readFile(new URL("../../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  catch { source = await readFile(new URL("../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  const originalFetch = globalThis.fetch;
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = "test-token-that-is-long-enough";
  const probabilities = { applied: 0.92, new_opportunity: 0.01, interview: 0.01, rejected: 0.01,
    offer: 0.01, follow_up: 0.01, unrelated: 0.01, uncertain: 0.02 };
  globalThis.fetch = async () => Response.json({ success: true, result: { answers: {
    application_event: { type: "choice", choice: "applied", confidence: 0.92, probabilities },
  } } });
  const event = { source: "email", receivedAt: "2026-10-19T10:00:00.000Z",
    message: { messageId: "<mail-1@example.test>", inReplyTo: null, references: [], from: "recruiter@example.test",
      to: "private@example.test", subject: "Application received", text: "We received your application.",
      date: null, urls: [], confirmation: false, attachments: [] }, rawMime: Buffer.from("From: recruiter@example.test\r\n\r\nInterview").toString("base64url") };
  const classificationJournal = new Map<string, unknown>();
  const commands: Array<{ commandId: string; value: unknown }> = [];
  let classifierCalls = 0;
  const participant = stubParticipant({
    async getOrCreateApplicationEvent(key, _inputHash, compute) {
      const prior = classificationJournal.get(key);
      if (prior) return prior as never;
      classifierCalls += 1;
      const classified = await compute();
      classificationJournal.set(key, structuredClone(classified));
      return classified;
    },
    async enqueueItemCommand(commandId, value) { commands.push({ commandId, value: structuredClone(value) }); return { status: "pending" }; },
  });
  const request = { ...input, runId: "email-retry-1", source, sourceDigest: createHash("sha256").update(source).digest("hex"),
    signals: [{ id: "mail-signal-1", source: "email", external_id: "mail-event-1", body: event.message.text, payload: event }],
    capabilities: { operations: ["item-command", "clef.application-event"], targets: ["integration-1"] } };
  try {
    const first = await runReaction(request, participant);
    const second = await runReaction(request, participant);
    assert.equal(first.status, "pending");
    assert.equal(second.status, "pending");
    assert.equal(classifierCalls, 1);
    assert.equal((classificationJournal.values().next().value as { event: string }).event, "applied");
    assert.equal(commands[0]?.commandId, commands[1]?.commandId);
    assert.deepEqual(commands[0]?.value, commands[1]?.value);
    assert.deepEqual(commands[0]?.value, {
      event,
      classification: {
        status: "review",
        reason: "Message needs a unique approved application match and scoped status-move authoring",
        source: { type: "email", receivedAt: event.receivedAt, messageId: event.message.messageId },
        decision: await classificationJournal.values().next().value,
      },
    });
    assert.equal(first.commands[0]?.storageReceipt, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("Given forwarding confirmations or conditional reminders, when email reaction runs, then queue review without invoking AI", async () => {
  let source: string;
  try { source = await readFile(new URL("../../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  catch { source = await readFile(new URL("../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  const commands: unknown[] = [];
  let classifierCalls = 0;
  const participant = stubParticipant({
    async getOrCreateApplicationEvent() { classifierCalls += 1; throw new Error("AI should not run for confirmation mail"); },
    async enqueueItemCommand(_commandId, value) { commands.push(value); return { status: "pending" }; },
  });
  const baseMessage = { messageId: null, inReplyTo: null, references: [], from: "mail@example.test", to: "private@example.test",
    subject: "Forwarding check", text: "Confirm address", date: null, urls: [], confirmation: true, attachments: [] };
  const events = [
    { source: "email", receivedAt: "2026-10-19T10:00:00.000Z", message: baseMessage, rawMime: "bWFpbA" },
    { source: "email", receivedAt: "2026-10-19T10:01:00.000Z", message: { ...baseMessage, confirmation: false,
      subject: "Application reminder", text: "If you have completed your application, reply. If you are still working on your application, continue." }, rawMime: "cmVtaW5kZXI" },
  ];
  for (const [index, event] of events.entries()) {
    const request = { ...input, runId: `email-review-${index}`, source,
      sourceDigest: createHash("sha256").update(source).digest("hex"),
      signals: [{ id: `signal-${index}`, source: "email", external_id: `event-${index}`, body: event.message.text, payload: event }],
      capabilities: { operations: ["item-command", "clef.application-event"], targets: ["integration-1"] } };
    const result = await runReaction(request, participant);
    assert.equal(result.status, "pending");
  }
  assert.equal(classifierCalls, 0);
  assert.deepEqual(commands.map(value => (value as { classification: { reason: string } }).classification.reason), [
    "Forwarding-address confirmation requires owner attention",
    "Conditional application reminder does not confirm submission",
  ]);
  assert.equal((commands[0] as { event: { rawMime: string } }).event.rawMime, events[0]!.rawMime);
  assert.equal((commands[1] as { event: { rawMime: string } }).event.rawMime, events[1]!.rawMime);
});

test("Given an authorized vacancy URL in email, when classification finds a new opportunity, then fetch bounded page evidence through the scoped capability", async () => {
  let source: string;
  try { source = await readFile(new URL("../../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  catch { source = await readFile(new URL("../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  const originalFetch = globalThis.fetch;
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "c".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = "test-token-that-is-long-enough";
  const probabilities = { applied: 0.01, new_opportunity: 0.92, interview: 0.01, rejected: 0.01,
    offer: 0.01, follow_up: 0.01, unrelated: 0.01, uncertain: 0.02 };
  let pageFetches = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("api.cloudflare.com")) {
      return Response.json({ success: true, result: { answers: {
        application_event: { type: "choice", choice: "new_opportunity", confidence: 0.92, probabilities },
      } } });
    }
    pageFetches += 1;
    return new Response('<html><head><title>Software Development Engineer II</title></head><body><script type="application/ld+json">{"@type":"JobPosting","title":"Software Development Engineer II","description":"Develop PartyRock tools.","hiringOrganization":{"name":"Amazon"}}</script></body></html>',
      { status: 200, headers: { "content-type": "text/html" } });
  };
  const event = { source: "email", receivedAt: "2026-10-19T10:00:00.000Z",
    message: { messageId: "<vacancy@example.test>", inReplyTo: null, references: [], from: "recruiter@example.test",
      to: "private@example.test", subject: "New role", text: "We found a Software Development Engineer II opportunity.",
      date: null, urls: ["https://www.amazon.jobs/de/jobs/10471492/software-development-engineer"], confirmation: false, attachments: [] },
    rawMime: Buffer.from("From: recruiter@example.test\r\n\r\nNew role").toString("base64url") };
  const commands: unknown[] = [];
  const participant = stubParticipant({
    async getOrCreateOpportunity() { return { relevance: "yes" } as never; },
    async enqueueItemCommand(_commandId, value) { commands.push(value); return { status: "pending" }; },
  });
  const requestFor = (runId: string, operations: string[]) => ({ ...input, runId, source,
    sourceDigest: createHash("sha256").update(source).digest("hex"),
    signals: [{ id: `signal-${runId}`, source: "email", external_id: runId, body: event.message.text, payload: event }],
    capabilities: { operations, targets: ["integration-1"] } });
  try {
    const withoutPageGrant = await runReaction(requestFor("email-vacancy-denied", ["item-command", "clef.application-event", "clef.opportunity"]), participant);
    assert.equal(withoutPageGrant.status, "pending");
    assert.equal(pageFetches, 0);
    assert.equal((commands[0] as { classification: { extraction?: unknown } }).classification.extraction, undefined);

    const withPageGrant = await runReaction(requestFor("email-vacancy-allowed", ["item-command", "clef.application-event", "clef.opportunity", "job-page-fetch"]), participant);
    assert.equal(withPageGrant.status, "pending");
    assert.equal(pageFetches, 1);
    const command = commands[1] as { event: typeof event; classification: { extraction: { company: string; role: string; body: string; finalUrl: string } } };
    assert.deepEqual(command.event, event);
    assert.equal(command.classification.extraction.company, "Amazon");
    assert.equal(command.classification.extraction.role, "Software Development Engineer II");
    assert.equal(command.classification.extraction.finalUrl, event.message.urls[0]);
    assert.match(command.classification.extraction.body, /Develop PartyRock tools/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("Given near-limit retained MIME, when reaction input is checked, then accept it under the 2-MiB envelope and reject overflow", async () => {
  let source: string;
  try { source = await readFile(new URL("../../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  catch { source = await readFile(new URL("../reaction-runtime/defaultReaction.ts", import.meta.url), "utf8"); }
  const message = { messageId: null, inReplyTo: null, references: [], from: "mail@example.test", to: "private@example.test",
    subject: "Forwarding check", text: "Confirm address", date: null, urls: [], confirmation: true, attachments: [] };
  const acceptedCommands: unknown[] = [];
  const participant = stubParticipant({ async enqueueItemCommand(_commandId, value) {
    acceptedCommands.push(value);
    return { status: "pending" };
  } });
  const nearLimitRawMime = Buffer.alloc(1_048_576, 0x61).toString("base64url");
  const acceptedRequest = { ...input, runId: "email-near-limit", source,
    sourceDigest: createHash("sha256").update(source).digest("hex"),
    signals: [{ id: "large-mail", source: "email", external_id: "large-mail-event", body: "", payload: {
      source: "email", receivedAt: "2026-10-19T10:00:00.000Z", message, rawMime: nearLimitRawMime,
    } }], capabilities: { operations: ["item-command"], targets: ["integration-1"] } };
  assert.equal((await runReaction(acceptedRequest, participant)).status, "pending");
  assert.equal((acceptedCommands[0] as { event: { rawMime: string } }).event.rawMime, nearLimitRawMime);

  let oversizedCommandCalls = 0;
  const oversizedParticipant = stubParticipant({ async enqueueItemCommand() { oversizedCommandCalls += 1; return { status: "pending" }; } });
  const oversizedRequest = { ...acceptedRequest, runId: "email-over-limit", signals: [{
    ...acceptedRequest.signals[0]!, payload: { ...acceptedRequest.signals[0]!.payload,
      rawMime: "A".repeat(2_097_153) },
  }] };
  await assert.rejects(runReaction(oversizedRequest, oversizedParticipant), /Reaction input exceeds its JSON bound/);
  assert.equal(oversizedCommandCalls, 0);
});

function stubParticipant(overrides: Partial<ReactionParticipant> = {}): ReactionParticipant {
  return {
    async enqueueItemCommand() { return { status: "pending" }; },
    async getItemCommandResult() { return null; },
    async getOrCreateOpportunity(_key, _inputHash, compute) { return compute(); },
    async getOrCreateApplicationEvent(_key, _inputHash, compute) { return compute(); },
    async classificationContext() { return {}; },
    ...overrides,
  };
}

test("Given a reaction granted public job-page fetch, when it uses fetch, then access is available only with that capability", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("job page", { status: 200 });
  const source = `export default async () => ({ body: await (await fetch("https://jobs.example.test/1")).text() })`;
  try {
    const allowed = await runReaction({ ...input, capabilities: { operations: ["job-page-fetch"], targets: [] }, source,
      sourceDigest: createHash("sha256").update(source).digest("hex") }, stubParticipant());
    assert.deepEqual(allowed.result, { body: "job page" });
    await assert.rejects(runReaction({ ...input, capabilities: { operations: [], targets: [] }, source,
      sourceDigest: createHash("sha256").update(source).digest("hex") }, stubParticipant()), /job-page-fetch/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Given the Reflux homepage source, when executed by the shared reaction engine, then public fetch enrichment reaches the existing card command", { skip: !process.env.REFLUX_HOMEPAGE_SOURCE_PATH }, async () => {
  const source = await readFile(process.env.REFLUX_HOMEPAGE_SOURCE_PATH!, "utf8");
  const originalFetch = globalThis.fetch;
  let command: unknown;
  globalThis.fetch = async () => new Response('<html><head><title>Software Development Engineer II</title></head><body><script type="application/ld+json">{"@type":"JobPosting","title":"Software Development Engineer II","description":"Develop PartyRock tools.","hiringOrganization":{"name":"Amazon"}}</script></body></html>',
    { status: 200, headers: { "content-type": "text/html" } });
  const submission = { message: "PartyRock", contact: "", company: "", role: "",
    jobUrl: "https://www.amazon.jobs/de/jobs/10471492/software-development-engineer" };
  const request = { ...input, runId: "reflux-source-proof", source, sourceDigest: createHash("sha256").update(source).digest("hex"),
    signals: [{ id: "signal-1", source: "website", external_id: "home-proof-1", body: submission.message,
      payload: { source: "website", receivedAt: "2026-10-17T12:00:00.000Z", submission } }],
    capabilities: { operations: ["item-command", "clef.opportunity", "job-page-fetch"], targets: ["integration-1"] } };
  try {
    const participant = stubParticipant({
      async getOrCreateOpportunity() { return { relevance: "yes" } as never; },
      async enqueueItemCommand(_commandId, value) { command = value; return { status: "pending" }; },
    });
    const result = await runReaction(request, participant);
    assert.equal(result.status, "pending");
    assert.equal((command as any).classification.extraction.company, "Amazon");
    assert.equal((command as any).classification.extraction.role, "Software Development Engineer II");
    assert.equal((command as any).event.submission.message, "PartyRock");
  } finally { globalThis.fetch = originalFetch; }
});
