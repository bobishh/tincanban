import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedParticipantRuntime } from "../src/participantRuntime.ts";
import { SqliteExecutionStorage } from "../src/sqliteStorage.ts";
import { ExecutionCoordinator } from "../../../workers/automation/src/executionCoordinator";
import { captureMigrationManifest, readMigrationPage, sealMigrationPage } from "../../../workers/automation/src/executorMigration";

test("Given the real packaged Node participant, when migration restarts, then imported pages survive and missing authority cannot activate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-worker-"));
  const previousSecret = process.env.EXECUTOR_MIGRATION_SECRET;
  process.env.EXECUTOR_MIGRATION_SECRET = "test-migration-" + "s".repeat(40);
  let runtime = new BoundedParticipantRuntime(directory, "https://executor.example.test", "https://automation.example.test");
  const source = new SqliteExecutionStorage(":memory:");
  try {
    new ExecutionCoordinator({ storage: source, id: { name: "one" }, waitUntil: () => {} }, {
      INTEGRATIONS_JSON: "[]", AI: { run: async () => { throw new Error("No classifier during import"); } },
    });
    source.sql.exec("INSERT INTO automation_identities VALUES (?, ?, ?)", "one", "untrusted-test-ciphertext", 1);
    const manifest = await captureMigrationManifest(source, "one", "https://executor.example.test", 1);
    assert.deepEqual(await runtime.call("one", { operation: "status" }), { status: "unconfigured", epoch: null, manifestHash: null });
    await runtime.call("one", { operation: "import-manifest", body: manifest });
    for (const table of manifest.tables) for (const page of table.pages) {
      const plain = await readMigrationPage(source, manifest, table.name, page.offset);
      const sealed = await sealMigrationPage(process.env.EXECUTOR_MIGRATION_SECRET, manifest, plain);
      await runtime.call("one", { operation: "import-page", body: { table: table.name, offset: page.offset, page: sealed } });
    }
    const status = await runtime.call("one", { operation: "status" }) as { manifestHash: string };
    await runtime.close();
    runtime = new BoundedParticipantRuntime(directory, "https://executor.example.test", "https://automation.example.test");
    assert.deepEqual(await runtime.call("one", { operation: "status" }), status);
    await assert.rejects(runtime.call("one", { operation: "activate", body: { epoch: 1, manifestHash: status.manifestHash, manualResolutions: [] } }));
    await assert.rejects(runtime.call("one", { operation: "rpc", method: "classificationContext", args: [] }), /not been activated/);
  } finally {
    source.close(); await runtime.close(); rmSync(directory, { recursive: true });
    if (previousSecret === undefined) delete process.env.EXECUTOR_MIGRATION_SECRET;
    else process.env.EXECUTOR_MIGRATION_SECRET = previousSecret;
  }
});
