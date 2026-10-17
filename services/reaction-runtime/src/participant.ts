import { createHash } from "node:crypto";
import { ExecutionCoordinator } from "../../../workers/automation/src/executionCoordinator";
import type { ExecutionEnvironment } from "../../../workers/automation/src/executionPorts";
import { observeReplicaReceipts } from "../../../workers/automation/src/replica";
import type { ExecutionStoragePort } from "../../../workers/automation/src/executionPorts";
import type { ParticipantRequest } from "./participantPorts";
import { createReactionAi, runReaction, type ReactionCommandIdentity, type ReactionRequest } from "./reactionRuntime";
import { itemCommandSourceBodyHash } from "../../../workers/automation/src/itemCommands";

export function createParticipant(integrationId: string, epoch: number, storage: ExecutionStoragePort) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(integrationId) || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new TypeError("Participant binding is invalid");
  }
  const env: ExecutionEnvironment = {
    AI: { run: async () => { throw new Error("Classification requires a Reflux reaction"); } },
    INTEGRATIONS_JSON: process.env.INTEGRATIONS_JSON ?? "[]",
    EMAIL_ROUTES_JSON: process.env.EMAIL_ROUTES_JSON,
    IDENTITY_STORAGE_SECRET: process.env.IDENTITY_STORAGE_SECRET,
    EVENT_STORAGE_SECRET: process.env.EVENT_STORAGE_SECRET,
    RELEASE_SHA: process.env.RELEASE_SHA,
    SERVICE_NAME: "tincanban-reaction",
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
          storage.sql.exec(`INSERT INTO participant_command_receipts(event_id, change_hash, request_id, receipt_json)
            VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`, eventId, changeHash, requestId, JSON.stringify(receipt));
        }
      });
    }),
    classify: async () => { throw new Error("Classification belongs to the Reflux reaction"); },
  });

  async function dispatchCoordinatorAlarm(force: boolean): Promise<boolean> {
    const scheduledAt = await storage.getAlarm();
    if (!force && (scheduledAt === null || scheduledAt > Date.now())) return false;
    if (scheduledAt !== null) await storage.deleteAlarm();
    try { await coordinator.alarm(); }
    catch (error) { await storage.setAlarm(Date.now() + 15_000); throw error; }
    return true;
  }
  if (!storage.schemaManaged) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS participant_schedule (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), alarm_at INTEGER
    );
    INSERT INTO participant_schedule (singleton, alarm_at) VALUES (1, NULL) ON CONFLICT(singleton) DO NOTHING;`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS participant_command_receipts (
      event_id TEXT PRIMARY KEY, change_hash TEXT NOT NULL, request_id TEXT NOT NULL, receipt_json TEXT NOT NULL
    );`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS reaction_journal (
      journal_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('command', 'clef-opportunity', 'clef-application-event')),
      input_hash TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`);

  }

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
        `INSERT INTO reaction_journal(journal_key, kind, input_hash, value_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(journal_key) DO NOTHING`,
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

  async function dispatch(request: ParticipantRequest): Promise<unknown> {
    if (request.epoch !== epoch) throw new Error("Participant epoch is stale");
    if (request.operation === "reaction") {
      const body = request.body as ReactionRequest & { source: string };
      if (body.participant.integrationId !== integrationId) throw new Error("Reaction participant does not match its journal");
      return runReaction(body, {
        async flushPendingCommands() { await dispatchCoordinatorAlarm(true); },
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
            "SELECT change_hash, receipt_json FROM participant_command_receipts WHERE event_id = ?", commandId,
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
      await dispatchCoordinatorAlarm(false);
      return { active: true, nextAlarm: await storage.getAlarm() };
    }
    throw new TypeError("Unknown participant operation");
  }

  return { coordinator, dispatch };

}
