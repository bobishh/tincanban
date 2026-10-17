import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runReaction, type ReactionParticipant, type ReactionRequest } from "../src/reactionRuntime.ts";

const input: ReactionRequest = {
  version: 1,
  runId: "run-1",
  sourceDigest: "a".repeat(64),
  signals: [{ id: "signal-1", source: "email", body: "hello", payload: { subject: "Hello" } }],
  participant: { integrationId: "integration-1", epoch: 1 },
  capabilities: { operations: ["item-command"], targets: ["integration-1"] },
};

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
