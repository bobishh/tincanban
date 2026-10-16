import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteExecutionStorage } from "../src/sqliteStorage.ts";
import { resolveMigrationEvents } from "../src/manualResolution.ts";

function storageWithEvents() {
  const storage = new SqliteExecutionStorage(":memory:");
  storage.sql.exec(`CREATE TABLE events (
    event_id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, body_hash TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result TEXT
  )`);
  storage.sql.exec("INSERT INTO events (event_id, source, source_id, body_hash, payload, status, created_at, updated_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "event-one", "email", "source-one", "hash-one", "ciphertext", "pending", 1, 2, '{"retained":true}');
  return storage;
}

test("Given exact queued migration events, when explicitly resolved, then evidence is audited and events become nonretryable review", () => {
  const storage = storageWithEvents();
  try {
    const resolutions = [{ eventId: "event-one", reason: "Operator confirmed already handled", itemId: "item-one" }];
    const result = resolveMigrationEvents(storage, resolutions, {
      instructionRef: "user-instruction-2026-10-16", hasAuthoredEvent: () => false, now: () => 100,
    });
    assert.deepEqual(result, [{ eventId: "event-one", originalStatus: "pending", duplicate: false }]);
    assert.deepEqual(storage.sql.exec("SELECT event_id, source_id, body_hash, original_status, reason, instruction_ref, resolved_at, current_item_id FROM manual_event_resolutions").one(), {
      event_id: "event-one", source_id: "source-one", body_hash: "hash-one", original_status: "pending",
      reason: "Operator confirmed already handled", instruction_ref: "user-instruction-2026-10-16", resolved_at: 100, current_item_id: "item-one",
    });
    const event = storage.sql.exec<{ status: string; result: string; payload: string }>("SELECT status, result, payload FROM events WHERE event_id = ?", "event-one").one();
    assert.equal(event.status, "review");
    assert.deepEqual(JSON.parse(event.result), { retained: true, reason: "Handled manually before executor migration", retryable: false });
    assert.equal(event.payload, "ciphertext");
  } finally { storage.close(); }
});

test("Given an identical resolution retry, when submitted twice, then it is idempotent; changed instructions conflict", () => {
  const storage = storageWithEvents();
  const resolutions = [{ eventId: "event-one", reason: "Already handled" }];
  const options = { instructionRef: "instruction-1", hasAuthoredEvent: () => false, now: () => 10 };
  try {
    resolveMigrationEvents(storage, resolutions, options);
    assert.deepEqual(resolveMigrationEvents(storage, resolutions, options), [
      { eventId: "event-one", originalStatus: "pending", duplicate: true },
    ]);
    assert.throws(() => resolveMigrationEvents(storage, [{ ...resolutions[0]!, reason: "Changed" }], options), /conflict/i);
    assert.equal(storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM manual_event_resolutions").one().count, 1);
  } finally { storage.close(); }
});

test("Given a missing, nonqueued, or already-authored event, when resolved, then no resolution is persisted", () => {
  for (const status of ["processing", "failed", "applied"]) {
    const storage = storageWithEvents();
    try {
      storage.sql.exec("UPDATE events SET status = ? WHERE event_id = ?", status, "event-one");
      assert.throws(() => resolveMigrationEvents(storage, [{ eventId: "event-one", reason: "Explicit" }], {
        instructionRef: "instruction-1", hasAuthoredEvent: () => false, now: () => 10,
      }), /queued or review/i);
      assert.equal(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manual_event_resolutions'").toArray().length, 0);
    } finally { storage.close(); }
  }
  const storage = storageWithEvents();
  try {
    assert.throws(() => resolveMigrationEvents(storage, [{ eventId: "event-one", reason: "Explicit" }], {
      instructionRef: "instruction-1", hasAuthoredEvent: id => id === "event-one", now: () => 10,
    }), /already authored/i);
    assert.equal(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manual_event_resolutions'").toArray().length, 0);
  } finally { storage.close(); }
});

test("Given a batch with one invalid target, when resolution starts, then the entire batch rolls back", () => {
  const storage = storageWithEvents();
  try {
    assert.throws(() => resolveMigrationEvents(storage, [
      { eventId: "event-one", reason: "Explicit" }, { eventId: "missing", reason: "Do not guess" },
    ], { instructionRef: "instruction-1", hasAuthoredEvent: () => false, now: () => 10 }), /does not exist/i);
    assert.equal(storage.sql.exec<{ status: string }>("SELECT status FROM events WHERE event_id = ?", "event-one").one().status, "pending");
    assert.equal(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manual_event_resolutions'").toArray().length, 0);
  } finally { storage.close(); }
});
