import assert from "node:assert/strict";
import test from "node:test";
import { decryptEventClassification, decryptEventPayload, encryptEventClassification, encryptEventPayload } from "../src/eventPayload.ts";

const secret = "0123456789abcdef0123456789abcdef";
const event = { source: "website" as const, receivedAt: "2026-10-16T10:00:00.000Z", submission: {
  message: "Role", contact: "", company: "Example", role: "Engineer",
} };

test("Given an encrypted intake payload, when decrypted, then the existing format remains event-bound", async () => {
  const encrypted = await encryptEventPayload(secret, "event-1", event);

  assert.deepEqual(await decryptEventPayload(secret, "event-1", encrypted), event);
  await assert.rejects(decryptEventPayload(secret, "event-2", encrypted));
});

test("Given a classification payload, when encrypted, then it uses a separate authenticated context", async () => {
  const classification = { status: "review", reason: "Needs review" };
  const encrypted = await encryptEventClassification(secret, "event-1", classification);

  assert.deepEqual(await decryptEventClassification(secret, "event-1", encrypted), classification);
  await assert.rejects(decryptEventPayload(secret, "event-1", encrypted));
});
