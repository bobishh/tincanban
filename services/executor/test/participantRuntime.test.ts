import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoundedParticipantRuntime } from "../src/participantRuntime.ts";
import { SqliteExecutionStorage } from "../src/sqliteStorage.ts";
import { ExecutionCoordinator } from "../../../workers/automation/src/executionCoordinator";
import { captureMigrationManifest, readMigrationPage, sealMigrationPage } from "../../../workers/automation/src/executorMigration";

test("Given continuous management RPCs for one integration, when scheduled ticks run, then ticks join the lane once and rotate fairly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-scheduler-"));
  const workerPath = join(directory, "participant-fixture.mjs");
  const eventsPath = join(directory, "events.jsonl");
  writeFileSync(eventsPath, "");
  writeFileSync(join(directory, "one.sqlite"), "");
  writeFileSync(join(directory, "two.sqlite"), "");
  writeFileSync(workerPath, `
    import { appendFileSync } from "node:fs";
    import { parentPort, workerData } from "node:worker_threads";
    const record = (kind, request) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({
      kind, integrationId: workerData.integrationId, operation: request.operation, at: Date.now(),
    }) + "\\n");
    parentPort.on("message", ({ id, request }) => {
      record("start", request);
      const delay = request.operation === "tick" ? 3500 : 40;
      setTimeout(() => {
        record("end", request);
        parentPort.postMessage({ id, result: { active: true } });
      }, delay);
    });
  `);
  const runtime = new BoundedParticipantRuntime(directory, "https://executor.example.test", "https://automation.example.test", pathToFileURL(workerPath));
  const runtimeQueue = runtime as unknown as { pending: number };
  const pendingSamples: number[] = [];
  let producing = true;
  const readEvents = () => readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string; integrationId: string; operation: string; at: number });
  const pump = async () => {
    while (producing) await runtime.call("one", { operation: "rpc", method: "management", args: [] });
  };
  const pumps = Array.from({ length: 4 }, pump);
  const waitFor = async (predicate: (events: ReturnType<typeof readEvents>) => boolean) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const events = readEvents();
      if (predicate(events)) return events;
      pendingSamples.push(runtimeQueue.pending);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return readEvents();
  };

  try {
    const events = await waitFor(rows => rows.filter(row => row.kind === "start" && row.operation === "tick").length >= 2);
    const loadStoppedAt = Date.now();
    const ticks = events.filter(row => row.kind === "start" && row.operation === "tick");
    const tickEnds = events.filter(row => row.kind === "end" && row.operation === "tick");
    assert.equal(ticks.length, 2, "one slow tick must not accumulate a second scheduled tick while running");
    assert.notEqual(ticks[0]!.integrationId, ticks[1]!.integrationId, "timer cursor must rotate independently of management RPC selection");
    assert.ok(ticks[0]!.at < loadStoppedAt && ticks[1]!.at < loadStoppedAt, "timer ticks must join the lane before continuous RPC load stops");
    assert.equal(tickEnds.length, 1);
    assert.equal(Math.max(...pendingSamples), 5, "four producer calls and one scheduled or running tick should occupy the lane");
    assert.ok(pendingSamples.every(count => count <= 5), "a slow scheduled tick must not accumulate behind the four management producers");
  } finally {
    producing = false;
    await Promise.all(pumps);
    await runtime.close();
    rmSync(directory, { recursive: true });
  }
});

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
    await assert.rejects(runtime.call("one", { operation: "activate", body: { epoch: 1, manifestHash: status.manifestHash } }));
    await assert.rejects(runtime.call("one", { operation: "rpc", method: "classificationContext", args: [] }), /not been activated/);
  } finally {
    source.close(); await runtime.close(); rmSync(directory, { recursive: true });
    if (previousSecret === undefined) delete process.env.EXECUTOR_MIGRATION_SECRET;
    else process.env.EXECUTOR_MIGRATION_SECRET = previousSecret;
  }
});

test("Given a fresh owner binding, when enrollment restarts, then the same executor identity survives without enabling item execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "executor-fresh-"));
  const previousSecret = process.env.IDENTITY_STORAGE_SECRET;
  process.env.IDENTITY_STORAGE_SECRET = "fresh-owner-" + "s".repeat(40);
  const binding = { integrationId: "fresh", ownerPersonId: "owner", workspaceId: "workspace", origin: "https://executor.example.test", epoch: 1 };
  let runtime = new BoundedParticipantRuntime(directory, binding.origin, "https://automation.example.test");
  try {
    const first = await runtime.call("fresh", { operation: "bootstrap", body: binding }) as { identity: unknown };
    assert.ok(first.identity);
    await runtime.close();
    runtime = new BoundedParticipantRuntime(directory, binding.origin, "https://automation.example.test");
    const repeated = await runtime.call("fresh", { operation: "bootstrap", body: binding }) as { identity: unknown };
    assert.deepEqual(repeated.identity, first.identity);
    await assert.rejects(runtime.call("fresh", { operation: "bootstrap", body: { ...binding, ownerPersonId: "another-owner" } }), /another|binding|bound/i);
    await assert.rejects(runtime.call("fresh", { operation: "rpc", method: "enqueueItemCommand", args: [{}] }), /activation|activated|enrollment/i);
    await assert.rejects(runtime.call("fresh", { operation: "rpc", method: "getRegisteredIntegration", args: [], epoch: 2 }), /epoch/i);
    assert.deepEqual(await runtime.call("fresh", { operation: "rpc", method: "getRegisteredIntegration", args: [], epoch: 1 }), null);
  } finally {
    await runtime.close(); rmSync(directory, { recursive: true });
    if (previousSecret === undefined) delete process.env.IDENTITY_STORAGE_SECRET;
    else process.env.IDENTITY_STORAGE_SECRET = previousSecret;
  }
});
