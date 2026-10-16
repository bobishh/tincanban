import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteExecutionStorage } from "../src/sqliteStorage.ts";

test("Given a persisted pending upload and alarm, when the service restarts, then exact bytes and schedule survive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-journal-"));
  let storage = new SqliteExecutionStorage(join(directory, "integration.sqlite"));
  try {
    storage.sql.exec("CREATE TABLE pending (request_id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)");
    const ciphertext = Uint8Array.of(0, 255, 17).buffer;
    storage.transactionSync(() => storage.sql.exec("INSERT INTO pending VALUES (?, ?)", "same-request", ciphertext));
    await storage.setAlarm(1792169006000);
    storage.close();
    storage = new SqliteExecutionStorage(join(directory, "integration.sqlite"));
    assert.deepEqual(storage.sql.exec("SELECT * FROM pending").one(), { request_id: "same-request", ciphertext });
    assert.equal(await storage.getAlarm(), 1792169006000);
  } finally { storage.close(); rmSync(directory, { recursive: true }); }
});

test("Given atomic state publication, when a nested write fails, then no partial generation becomes current", () => {
  const storage = new SqliteExecutionStorage(":memory:");
  try {
    storage.sql.exec("CREATE TABLE generation (id TEXT PRIMARY KEY); INSERT INTO generation VALUES ('original');");
    assert.throws(() => storage.transactionSync(() => {
      storage.sql.exec("DELETE FROM generation");
      storage.transactionSync(() => storage.sql.exec("INSERT INTO generation VALUES ('partial')"));
      throw new Error("interrupted");
    }), /interrupted/);
    assert.deepEqual(storage.sql.exec("SELECT id FROM generation").toArray(), [{ id: "original" }]);
    assert.throws(() => storage.sql.exec("SELECT id FROM generation WHERE id = 'missing'").one(), /Expected one/);
  } finally { storage.close(); }
});
