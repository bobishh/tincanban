import { parentPort, workerData } from "node:worker_threads";
import { chmodSync } from "node:fs";
import { ExecutionCoordinator } from "../../../workers/automation/src/executionCoordinator";
import type { ExecutionEnvironment } from "../../../workers/automation/src/executionPorts";
import { initializeImport, initializeImportTables, importMigrationPage, openMigrationPage,
  parseMigrationManifest, verifyCompleteImport, type MigrationManifest } from "../../../workers/automation/src/executorMigration";
import { decryptEventPayload } from "../../../workers/automation/src/eventPayload";
import { observeReplicaReceipts } from "../../../workers/automation/src/replica";
import { automationTelemetry, recordAutomationException, withAutomationSpan } from "../../../workers/automation/src/telemetry";
import { SqliteExecutionStorage } from "./sqliteStorage";
import { resolveMigrationEvents, type ManualMigrationResolution } from "./manualResolution";
import type { ParticipantRequest } from "./httpApi";

const { integrationId, databasePath, publicOrigin, automationOrigin } = workerData as {
  integrationId: string; databasePath: string; publicOrigin: string; automationOrigin: string;
};
const storage = new SqliteExecutionStorage(databasePath);
chmodSync(databasePath, 0o600);
const env: ExecutionEnvironment = {
  AI: { run: async () => { throw new Error("Executor has no direct model binding"); } },
  INTEGRATIONS_JSON: process.env.INTEGRATIONS_JSON ?? "[]",
  EMAIL_ROUTES_JSON: process.env.EMAIL_ROUTES_JSON,
  IDENTITY_STORAGE_SECRET: process.env.IDENTITY_STORAGE_SECRET,
  EVENT_STORAGE_SECRET: process.env.EVENT_STORAGE_SECRET,
  RELEASE_SHA: process.env.RELEASE_SHA,
  SERVICE_NAME: "tincanban-executor",
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  TELEMETRY_TOKEN: process.env.TELEMETRY_TOKEN,
};
const coordinator: ExecutionCoordinator = new ExecutionCoordinator({ storage, id: { name: integrationId }, waitUntil: promise => { void promise.catch(() => {}); } }, env, {
  replicaTransport: observeReplicaReceipts(async (receipt, _object, requestId, applied) => {
    storage.transactionSync(() => {
      const processing = storage.sql.exec<{ event_id: string }>("SELECT event_id FROM events WHERE status = 'processing'").toArray();
      for (const { event_id: eventId } of processing) {
        const changeHash = applied[eventId]?.changeHash;
        if (!changeHash) continue;
        storage.sql.exec(`INSERT INTO executor_command_receipts(event_id, change_hash, request_id, receipt_json)
          VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`, eventId, changeHash, requestId, JSON.stringify(receipt));
      }
    });
  }),
  classify: async (event, definition, employeeProfile, priorityBands) => {
    const response = await fetch(`${automationOrigin}/internal/classify`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CLASSIFICATION_SERVICE_TOKEN}` },
      body: JSON.stringify({ event, context: { definition, employeeProfile, priorityBands } }),
    });
    if (!response.ok) throw new Error(`Intake classification failed (HTTP ${response.status}): ${(await response.text()).slice(0, 2048)}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Classification response exceeds its bound");
    return JSON.parse(new TextDecoder().decode(bytes));
  },
});
initializeImportTables(storage);
storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_command_receipts (
  event_id TEXT PRIMARY KEY, change_hash TEXT NOT NULL, request_id TEXT NOT NULL, receipt_json TEXT NOT NULL
);`);

function importState() {
  return storage.sql.exec<{ manifest_hash: string; manifest_json: string; active: number }>("SELECT manifest_hash, manifest_json, active FROM executor_import WHERE singleton = 1").toArray()[0];
}

async function dispatch(request: ParticipantRequest): Promise<unknown> {
  const state = importState();
  const manifest = state ? JSON.parse(state.manifest_json) as MigrationManifest : undefined;
  if (request.operation === "status") return { status: state?.active ? "active" : state ? "importing" : "unconfigured",
    epoch: manifest?.epoch ?? null, manifestHash: state?.manifest_hash ?? null };
  if (request.operation === "import-manifest") {
    const incoming = parseMigrationManifest(request.body, integrationId, publicOrigin);
    await initializeImport(storage, incoming);
    return { status: "importing", epoch: incoming.epoch };
  }
  if (request.operation === "import-page") {
    if (!manifest) throw new Error("Migration manifest required before pages");
    const body = request.body as { table: string; offset: number; page: { nonce: string; ciphertext: string } };
    const page = await openMigrationPage(required("EXECUTOR_MIGRATION_SECRET"), manifest, body.table, body.offset, body.page);
    await importMigrationPage(storage, manifest, page);
    return { imported: true, table: body.table, offset: body.offset };
  }
  if (request.operation === "review-migration-events") {
    if (!manifest || state?.active) throw new Error("Migration review requires an inactive imported participant");
    await verifyCompleteImport(storage, manifest);
    const rows = storage.sql.exec<{ event_id: string; source_id: string; source: string; status: string; payload: string; body_hash: string; created_at: number }>(
      "SELECT event_id, source_id, source, status, payload, body_hash, created_at FROM events WHERE status <> 'applied' ORDER BY created_at LIMIT 100",
    ).toArray();
    return Promise.all(rows.map(async row => {
      const event = await decryptEventPayload(required("EVENT_STORAGE_SECRET"), row.event_id, row.payload);
      return { eventId: row.event_id, sourceId: row.source_id, bodyHash: row.body_hash, source: row.source, status: row.status, createdAt: row.created_at,
        ...(event.source === "email" ? { subject: event.message.subject, urls: event.message.urls, sentAt: event.message.date }
          : { company: event.submission.company, role: event.submission.role, jobUrl: event.submission.jobUrl }) };
    }));
  }
  if (request.operation === "activate") {
    const body = request.body as { epoch: number; manifestHash: string; manualResolutions: ManualMigrationResolution[] };
    if (!manifest || body.epoch !== manifest.epoch || body.manifestHash !== state?.manifest_hash) throw new Error("Activation requires the exact imported migration");
    if (state.active) return { status: "active", epoch: manifest.epoch, manifestHash: state.manifest_hash };
    if (!Array.isArray(body.manualResolutions)) throw new TypeError("Explicit migration resolution list required");
    await verifyCompleteImport(storage, manifest);
    await coordinator.validateMigrationState();
    const serialized = await coordinator.loadReplicaState(required("EVENT_STORAGE_SECRET"));
    const applied = serialized ? (JSON.parse(serialized) as { applied?: Record<string, unknown> }).applied ?? {} : {};
    storage.transactionSync(() => {
      if (body.manualResolutions.length) resolveMigrationEvents(storage, body.manualResolutions, {
        instructionRef: "user:2026-10-16/tesla-amazon-already-handled", hasAuthoredEvent: eventId => Object.hasOwn(applied, eventId),
      });
      storage.sql.exec("UPDATE executor_import SET active = 1 WHERE singleton = 1");
    });
    return { status: "active", epoch: manifest.epoch, manifestHash: state.manifest_hash };
  }
  if (!state?.active) {
    if (request.operation === "tick") return { active: false };
    const error = new Error("Executor migration has not been activated") as Error & { status: number };
    error.status = 503; throw error;
  }
  if (request.operation === "tick") {
    const time = await storage.getAlarm();
    if (time !== null && time <= Date.now()) {
      // Clear before dispatch, just as the platform consumes an alarm. The shared coordinator rearms on failure.
      await storage.deleteAlarm();
      try { await coordinator.alarm(); }
      catch (error) { await storage.setAlarm(Date.now() + 15_000); throw error; }
    }
    return { active: true, nextAlarm: await storage.getAlarm() };
  }
  if (request.operation === "rpc") {
    if (request.epoch !== undefined && request.epoch !== manifest?.epoch) throw new Error("Executor routing epoch is stale");
    const method = request.method as keyof ExecutionCoordinator;
    const fn = coordinator[method];
    if (typeof fn !== "function") throw new TypeError("Unknown participant method");
    const result = await Reflect.apply(fn, coordinator, request.args ?? []);
    if ((method === "getItemCommandResult" || method === "getEvent") && result?.status === "applied") {
      const receipt = storage.sql.exec<{ change_hash: string; receipt_json: string }>(
        "SELECT change_hash, receipt_json FROM executor_command_receipts WHERE event_id = ?", String(request.args?.[0]),
      ).toArray()[0];
      if (receipt) return { ...result, changeHash: receipt.change_hash, storageReceipt: JSON.parse(receipt.receipt_json) };
    }
    return result;
  }
  throw new TypeError("Unknown participant operation");
}

let lane: Promise<unknown> = Promise.resolve();
parentPort!.on("message", (message: { id: number; request: ParticipantRequest }) => {
  lane = lane.then(async () => {
    try {
      const result = await withAutomationSpan(automationTelemetry(), `executor.${message.request.operation}`, {
        "integration.id": integrationId, "executor.operation": message.request.method ?? message.request.operation,
      }, () => dispatch(message.request), message.request.traceparent);
      parentPort!.postMessage({ id: message.id, result });
    }
    catch (error) {
      recordAutomationException(error, { event: "executor.operation.failed", "integration.id": integrationId, operation: message.request.operation });
      parentPort!.postMessage({ id: message.id, error: { message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error", status: error && typeof error === "object" && "status" in error ? error.status : undefined } });
    } finally { await automationTelemetry().flush(); }
  });
});

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} is not configured`);
  return value;
}
