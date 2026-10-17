import { parentPort, workerData } from "node:worker_threads";
import { chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { ExecutionCoordinator } from "../../../workers/automation/src/executionCoordinator";
import type { ExecutionEnvironment } from "../../../workers/automation/src/executionPorts";
import { initializeImport, initializeImportTables, importMigrationPage, openMigrationPage,
  parseMigrationManifest, verifyCompleteImport, type MigrationManifest } from "../../../workers/automation/src/executorMigration";
import { observeReplicaReceipts } from "../../../workers/automation/src/replica";
import { automationTelemetry, recordAutomationException, withAutomationSpan } from "../../../workers/automation/src/telemetry";
import { SqliteExecutionStorage } from "./sqliteStorage";
import type { ParticipantRequest } from "./httpApi";
import { freshBindingHash, readNodeFreshBinding, reserveNodeFreshBinding, validateExecutorFreshBinding } from "../../../workers/automation/src/executorFresh";
import { createReactionAi, runReaction, type ReactionCommandIdentity, type ReactionRequest } from "./reactionRuntime";
import { itemCommandSourceBodyHash } from "../../../workers/automation/src/itemCommands";

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
storage.sql.exec(`CREATE TABLE IF NOT EXISTS reaction_journal (
  journal_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('command', 'clef-opportunity', 'clef-application-event')),
  input_hash TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`);

const reactionEvidenceInFlight = new Map<string, Promise<unknown>>();
async function getOrCreateReactionJournalValue<T>(journalKey: string, kind: string, inputHash: string,
  compute: () => Promise<T>): Promise<T> {
  const read = () => storage.sql.exec<{ kind: string; input_hash: string; value_json: string }>(
    "SELECT kind, input_hash, value_json FROM reaction_journal WHERE journal_key = ?", journalKey,
  ).toArray()[0];
  const existing = read();
  if (existing) {
    if (existing.kind !== kind || existing.input_hash !== inputHash) throw new Error("Reaction journal identity conflicts with retained evidence");
    return JSON.parse(existing.value_json) as T;
  }
  const prior = reactionEvidenceInFlight.get(journalKey);
  if (prior) return prior as Promise<T>;
  const pending = (async () => {
    const value = await compute();
    const valueJson = JSON.stringify(value);
    if (!valueJson || Buffer.byteLength(valueJson, "utf8") > 1_048_576) throw new TypeError("Reaction journal value exceeds its bound");
    storage.transactionSync(() => storage.sql.exec(
      `INSERT OR IGNORE INTO reaction_journal(journal_key, kind, input_hash, value_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      journalKey, kind, inputHash, valueJson, Date.now(),
    ));
    const retained = read();
    if (!retained || retained.kind !== kind || retained.input_hash !== inputHash) {
      throw new Error("Reaction journal evidence could not be retained");
    }
    return JSON.parse(retained.value_json) as T;
  })();
  reactionEvidenceInFlight.set(journalKey, pending);
  try { return await pending; }
  finally { reactionEvidenceInFlight.delete(journalKey); }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function verifyReactionCommandIdentity(commandId: string, identity: ReactionCommandIdentity): void {
  if (!Number.isSafeInteger(identity.slot) || identity.slot < 0 || identity.slot >= 100 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(identity.runId) || !/^[a-f0-9]{64}$/.test(identity.sourceDigest)) {
    throw new TypeError("Reaction command identity is invalid");
  }
  const expected = createHash("sha256").update(`${identity.runId}\0${identity.sourceDigest}\0${identity.slot}`).digest("base64url");
  if (commandId !== expected) throw new TypeError("Reaction command ID is not bound to its run and source");
}

function importState() {
  return storage.sql.exec<{ manifest_hash: string; manifest_json: string; active: number }>("SELECT manifest_hash, manifest_json, active FROM executor_import WHERE singleton = 1").toArray()[0];
}

async function dispatch(request: ParticipantRequest): Promise<unknown> {
  const state = importState();
  const manifest = state ? JSON.parse(state.manifest_json) as MigrationManifest : undefined;
  const fresh = await readNodeFreshBinding(storage);
  // Only the existing coordinator can publish this state, after validating activation authority.
  const freshActivated = fresh !== null && storage.sql.exec(
    "SELECT singleton FROM automation_replica WHERE singleton = 1 AND (state_generation IS NOT NULL OR encrypted_state IS NOT NULL)",
  ).toArray().length > 0;
  if (request.operation === "status") return fresh
    ? { status: freshActivated ? "active" : "enrolling", epoch: fresh.epoch, manifestHash: null, bindingHash: await freshBindingHash(fresh) }
    : { status: state?.active ? "active" : state ? "importing" : "unconfigured",
      epoch: manifest?.epoch ?? null, manifestHash: state?.manifest_hash ?? null };
  if (request.operation === "bootstrap") {
    const binding = validateExecutorFreshBinding(request.body, { integrationId, origin: publicOrigin });
    const reservation = await reserveNodeFreshBinding(storage, binding);
    const profile = await coordinator.enrollOwner({ integrationId, ownerPersonId: binding.ownerPersonId, workspaceId: binding.workspaceId }, required("IDENTITY_STORAGE_SECRET"));
    return { ...profile, epoch: binding.epoch, bindingHash: reservation.hash };
  }
  if (request.operation === "import-manifest") {
    if (fresh) throw new Error("Fresh enrollment already owns this participant; migration cannot replace it");
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
  if (request.operation === "activate") {
    const body = request.body as { epoch: number; manifestHash: string };
    if (!manifest || body.epoch !== manifest.epoch || body.manifestHash !== state?.manifest_hash) throw new Error("Activation requires the exact imported migration");
    if (state.active) return { status: "active", epoch: manifest.epoch, manifestHash: state.manifest_hash };
    await verifyCompleteImport(storage, manifest);
    await coordinator.validateMigrationState();
    storage.transactionSync(() => storage.sql.exec("UPDATE executor_import SET active = 1 WHERE singleton = 1"));
    return { status: "active", epoch: manifest.epoch, manifestHash: state.manifest_hash };
  }
  const freshLifecycle = fresh && request.operation === "rpc" && ["enrollOwner", "activateOwner", "getRegisteredIntegration", "observeOwner"].includes(request.method ?? "");
  if (!state?.active && !freshActivated && !freshLifecycle) {
    if (request.operation === "tick") return { active: false };
    const error = new Error(fresh ? "Executor enrollment requires owner activation" : "Executor migration has not been activated") as Error & { status: number };
    error.status = 503; throw error;
  }
  if (request.operation === "reaction") {
    if (request.epoch !== (fresh?.epoch ?? manifest?.epoch)) throw new Error("Reaction participant epoch is stale");
    const body = request.body as ReactionRequest & { source: string };
    if (body.participant.integrationId !== integrationId) throw new Error("Reaction participant does not match its journal");
    return runReaction(body, {
      async enqueueItemCommand(commandId, value, identity) {
        verifyReactionCommandIdentity(commandId, identity);
        const journalKey = `command:${commandId}`;
        const inputHash = hashJson({ runId: identity.runId, sourceDigest: identity.sourceDigest, slot: identity.slot });
        const commandValue = await getOrCreateReactionJournalValue(journalKey, "command", inputHash, async () => value);
        const command = commandValue as { event?: unknown; classification?: unknown };
        if (!command || !command.event || !command.classification) throw new TypeError("Reaction command requires event and classification");
        const idempotencyKey = await itemCommandSourceBodyHash(command.event as Parameters<typeof itemCommandSourceBodyHash>[0]);
        return coordinator.enqueueItemCommand({ integrationId, sourceEventId: commandId, idempotencyKey,
          event: command.event, classification: command.classification });
      },
      async getItemCommandResult(commandId) {
        const result = coordinator.getItemCommandResult(commandId, integrationId);
        if (!result || result.status !== "applied") return result as never;
        const receipt = storage.sql.exec<{ change_hash: string; receipt_json: string }>(
          "SELECT change_hash, receipt_json FROM executor_command_receipts WHERE event_id = ?", commandId,
        ).toArray()[0];
        return receipt ? { ...result, changeHash: receipt.change_hash, storageReceipt: JSON.parse(receipt.receipt_json) } : result as never;
      },
      async getOrCreateOpportunity(evidenceKey, inputHash, compute) {
        return getOrCreateReactionJournalValue(`clef-opportunity:${evidenceKey}`, "clef-opportunity", inputHash, compute);
      },
      async getOrCreateApplicationEvent(evidenceKey, inputHash, compute) {
        return getOrCreateReactionJournalValue(`clef-application-event:${evidenceKey}`, "clef-application-event", inputHash, compute);
      },
      async classificationContext() {
        const context = await coordinator.classificationContext();
        if (!context) throw new Error("An admitted participant is required before classification");
        return { employeeProfile: context.employeeProfile, priorityBands: context.priorityBands };
      },
    });
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
    if (request.epoch !== undefined && request.epoch !== (fresh?.epoch ?? manifest?.epoch)) throw new Error("Executor routing epoch is stale");
    const method = request.method as keyof ExecutionCoordinator;
    const fn = coordinator[method];
    if (typeof fn !== "function") throw new TypeError("Unknown participant method");
    const args = [...(request.args ?? [])];
    // Encryption keys belong to this runtime, never to the forwarding request.
    if (method === "enrollOwner" || method === "provisionIdentity") args[1] = required("IDENTITY_STORAGE_SECRET");
    if (method === "activateReplica") { args[1] = required("IDENTITY_STORAGE_SECRET"); args[2] = required("EVENT_STORAGE_SECRET"); }
    const result = await Reflect.apply(fn, coordinator, args);
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
        "automation.event.id": requestEventId(message.request),
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

function requestEventId(request: ParticipantRequest): string | undefined {
  const first = request.args?.[0];
  const value = request.method === "enqueueItemCommand" && first && typeof first === "object" && "sourceEventId" in first
    ? first.sourceEventId : ["getEvent", "getItemCommandResult"].includes(request.method ?? "") ? first : undefined;
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} is not configured`);
  return value;
}
