import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteExecutionStorage } from "../src/sqliteStorage.ts";
import { ExecutionCoordinator } from "../../../workers/automation/src/executionCoordinator";
import { captureMigrationManifest, readMigrationPage, sealMigrationPage, openMigrationPage,
  initializeImport, importMigrationPage, verifyCompleteImport } from "../../../workers/automation/src/executorMigration";

function fixture() {
  const storage = new SqliteExecutionStorage(":memory:");
  new ExecutionCoordinator({ storage, id: { name: "integration" }, waitUntil: () => {} }, {
    INTEGRATIONS_JSON: "[]", AI: { run: async () => { throw new Error("Migration cannot classify"); } },
  });
  return storage;
}

test("Given a frozen executor with exact pending state, when paged encrypted migration retries, then all original rows survive once", async () => {
  const source = fixture(), target = fixture();
  try {
    source.sql.exec("INSERT INTO automation_identities VALUES (?, ?, ?)", "integration", "exact-encrypted-seed", 10);
    await source.setAlarm(123456);
    const manifest = await captureMigrationManifest(source, "integration", "https://executor.example.test", 1);
    await initializeImport(target, manifest);
    await assert.rejects(verifyCompleteImport(target, manifest), /incomplete/);
    for (const table of manifest.tables) for (const page of table.pages) {
      const value = await readMigrationPage(source, manifest, table.name, page.offset);
      const sealed = await sealMigrationPage("a".repeat(48), manifest, value);
      await assert.rejects(openMigrationPage("b".repeat(48), manifest, table.name, page.offset, sealed));
      const opened = await openMigrationPage("a".repeat(48), manifest, table.name, page.offset, sealed);
      await importMigrationPage(target, manifest, opened);
      await importMigrationPage(target, manifest, opened);
    }
    await verifyCompleteImport(target, manifest);
    assert.deepEqual(target.sql.exec("SELECT * FROM automation_identities").one(), {
      integration_id: "integration", encrypted_seed: "exact-encrypted-seed", created_at: 10,
    });
    assert.equal(await target.getAlarm(), 123456);
  } finally { source.close(); target.close(); }
});

test("Given a migration page, when ciphertext targets another integration or rows change, then import rejects without partial publication", async () => {
  const source = fixture(), target = fixture();
  try {
    source.sql.exec("INSERT INTO automation_identities VALUES (?, ?, ?)", "integration", "seed", 10);
    const manifest = await captureMigrationManifest(source, "integration", "https://executor.example.test", 7);
    await initializeImport(target, manifest);
    const value = await readMigrationPage(source, manifest, "automation_identities", 0);
    const sealed = await sealMigrationPage("a".repeat(48), manifest, value);
    await assert.rejects(openMigrationPage("a".repeat(48), { ...manifest, integrationId: "another" }, value.table, 0, sealed));
    await assert.rejects(importMigrationPage(target, manifest, { ...value, rows: [{ integration_id: "integration", encrypted_seed: "tampered", created_at: 10 }] }), /digest/);
    assert.deepEqual(target.sql.exec("SELECT * FROM automation_identities").toArray(), []);
  } finally { source.close(); target.close(); }
});
