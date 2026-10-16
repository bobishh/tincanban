import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutorHandler } from "../src/httpApi.ts";

const token = "service-" + "a".repeat(40), producer = "producer-" + "b".repeat(40);
const config = { serviceToken: token, producers: [{ token: producer, integrationIds: ["one"] }] };
const artifact = { component: "tincanban-executor", sourceSha: "a".repeat(40), sdkSha: "b".repeat(40), artifactSha256: "c".repeat(64) };

test("Given an integration-bound producer, when it targets a foreign integration, then no participant is opened", async () => {
  const calls: unknown[] = [];
  const handler = createExecutorHandler({ call: async (...args) => { calls.push(args); return null; } }, config, artifact);
  const denied = await handler(new Request("https://executor.test/v1/items/commands", {
    method: "POST", headers: { authorization: `Bearer ${producer}`, "x-executor-integration": "two" }, body: "{}",
  }));
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);
});

test("Given a committed item command, when acceptance replies, then result URL identifies the durable command without claiming it applied", async () => {
  const calls: unknown[] = [];
  const handler = createExecutorHandler({ call: async (...args) => {
    calls.push(args); return { eventId: "x".repeat(43), status: "pending", duplicate: false };
  } }, config, artifact);
  const response = await handler(new Request("https://executor.test/v1/items/commands", {
    method: "POST", headers: { authorization: `Bearer ${producer}`, "x-executor-integration": "one" },
    body: JSON.stringify({ integrationId: "one" }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(calls[0], ["one", { operation: "rpc", method: "enqueueItemCommand", args: [{ integrationId: "one" }] }]);
  assert.deepEqual(await response.json(), { commandId: "x".repeat(43), eventId: "x".repeat(43), status: "pending", duplicate: false,
    durable: true, resultUrl: `/v1/items/commands/${"x".repeat(43)}` });
});

test("Given a service token, when a caller requests arbitrary replica persistence, then the private RPC allowlist denies it", async () => {
  const handler = createExecutorHandler({ call: async () => { throw new Error("Must not open participant"); } }, config, artifact);
  const response = await handler(new Request("https://executor.test/internal/integrations/one/rpc", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ method: "saveReplicaState", args: [] }),
  }));
  assert.equal(response.status, 400);
});
