import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identityCrypto";
import type { ItemCommandEnvelope } from "./itemCommands";
import type { AutomationEvent, AutomationPipelineResult } from "./pipeline";
import type { EnqueueResult, StoredEventStatus } from "./executionCoordinator";
import type { ExecutionStoragePort } from "./executionPorts";
import { captureMigrationManifest, parseMigrationManifest, readMigrationPage, sealMigrationPage, type MigrationManifest, type MigrationPage } from "./executorMigration";
import { decryptEventClassification, decryptEventPayload, encryptEventClassification } from "./eventPayload";
import { classifyExecutorEvent, type ClassificationContext } from "./classificationEndpoint";
import { callExecutorRpc, submitExecutorItemCommand } from "./executorClient";
import { readCloudflareFreshRoute } from "./executorFresh";
import { recordAutomationException } from "./telemetry";
import type { WorkerEnv } from "./index";

const maxOutboxRows = 1_000;
const maxOutboxBytes = 64 * 1024 * 1024;
const maxStoredPayloadBytes = 2 * 1024 * 1024;
const maxStoredClassificationBytes = 2 * 1024 * 1024;
const retryBaseMs = 1_000;
const retryMaximumMs = 5 * 60_000;

type MigrationState = {
  phase: "frozen" | "active";
  origin: string;
  epoch: number;
  manifest_json: string | null;
  manifest_hash: string | null;
};

type OutboxRow = {
  event_id: string;
  source: AutomationEvent["source"];
  source_id: string;
  body_hash: string;
  payload: string;
  challenge_nonce: string | null;
  challenge_expires_at: number | null;
  state: "queued" | "classified" | "forwarded";
  classification_payload: string | null;
  attempt: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
};

type IntakeWebsiteInput = { eventId: string; sourceId: string; bodyHash: string; nonce: string; challengeExpiresAt: number; payload: string };
type IntakeEmailInput = { eventId: string; sourceId: string; bodyHash: string; payload: string };
type IntakeEnvironment = Pick<WorkerEnv, "EVENT_STORAGE_SECRET" | "EXECUTOR_MIGRATION_SECRET" | "EXECUTOR_ORIGIN" | "EXECUTOR_SERVICE_TOKEN" | "AI">;

/** Durable cutover marker, encrypted snapshot transport and post-freeze intake outbox. */
export class ExecutorIntakeOutbox {
  constructor(private readonly storage: ExecutionStoragePort, private readonly integrationId: string, private readonly env: IntakeEnvironment) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_migration (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), phase TEXT NOT NULL CHECK (phase IN ('frozen', 'active')),
      origin TEXT NOT NULL, epoch INTEGER NOT NULL, manifest_json TEXT, manifest_hash TEXT, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS executor_intake_outbox (
      event_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('website', 'email')), source_id TEXT NOT NULL,
      body_hash TEXT NOT NULL, payload TEXT NOT NULL, challenge_nonce TEXT, challenge_expires_at INTEGER,
      state TEXT NOT NULL CHECK (state IN ('queued', 'classified', 'forwarded')), classification_payload TEXT,
      attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source, source_id)
    ); CREATE INDEX IF NOT EXISTS executor_intake_outbox_queue ON executor_intake_outbox(state, next_attempt_at, created_at);
    CREATE TABLE IF NOT EXISTS executor_intake_challenges (
      nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, event_id TEXT NOT NULL
    );`);
  }

  async phase(): Promise<MigrationState | null> {
    return this.storage.sql.exec<MigrationState>("SELECT phase, origin, epoch, manifest_json, manifest_hash FROM executor_migration WHERE singleton = 1").toArray()[0] ?? null;
  }

  async executionRoute(): Promise<{ origin: string; epoch: number } | null> {
    const state = await this.phase();
    return state?.phase === "active" ? { origin: state.origin, epoch: state.epoch } : null;
  }

  async freshExecutionRoute(): Promise<{ origin: string; epoch: number } | null> {
    const binding = await readCloudflareFreshRoute(this.storage);
    return binding ? { origin: binding.origin, epoch: binding.epoch } : null;
  }

  async prepare(epoch: number): Promise<MigrationManifest> {
    const origin = configuredOrigin(this.env.EXECUTOR_ORIGIN);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new TypeError("Executor migration epoch is invalid");
    const current = await this.phase();
    if (current) {
      if (current.origin !== origin || current.epoch !== epoch) throw new Error("Another executor migration already owns this integration");
      if (current.manifest_json) return parseMigrationManifest(JSON.parse(current.manifest_json), this.integrationId, origin);
    } else {
      this.storage.transactionSync(() => this.storage.sql.exec(
        "INSERT INTO executor_migration (singleton, phase, origin, epoch, manifest_json, manifest_hash, updated_at) VALUES (1, 'frozen', ?, ?, NULL, NULL, ?)",
        origin, epoch, Date.now(),
      ));
    }

    const manifest = await captureMigrationManifest(this.storage, this.integrationId, origin, epoch);
    const manifestJson = canonicalizeJson(manifest);
    const manifestHash = await sha256Base64Url(new TextEncoder().encode(manifestJson));
    this.storage.transactionSync(() => this.storage.sql.exec(
      "UPDATE executor_migration SET manifest_json = ?, manifest_hash = ?, updated_at = ? WHERE singleton = 1 AND phase = 'frozen' AND origin = ? AND epoch = ?",
      manifestJson, manifestHash, Date.now(), origin, epoch,
    ));
    await this.storage.deleteAlarm();
    return manifest;
  }

  async manifestHash(): Promise<string> {
    const state = await this.phase();
    if (!state?.manifest_hash) throw new Error("Executor migration snapshot is not prepared");
    return state.manifest_hash;
  }

  async page(epoch: number, table: string, offset: number): Promise<{ table: string; offset: number; nonce: string; ciphertext: string }> {
    const state = await this.phase();
    if (!state || state.epoch !== epoch || !state.manifest_json || !state.manifest_hash) throw new Error("Executor migration page is unavailable for this epoch");
    const manifest = parseMigrationManifest(JSON.parse(state.manifest_json), this.integrationId, state.origin);
    const page = await readMigrationPage(this.storage, manifest, table, offset);
    const secret = this.env.EXECUTOR_MIGRATION_SECRET;
    if (!secret) throw new Error("Executor migration encryption is not configured");
    const sealed = await sealMigrationPage(secret, manifest, page);
    return { table: page.table, offset: page.offset, ...sealed };
  }

  async acknowledge(epoch: number, manifestHash: string): Promise<void> {
    const state = await this.phase();
    if (!state || state.epoch !== epoch || !state.manifest_json || !state.manifest_hash || state.manifest_hash !== manifestHash) {
      throw new Error("Executor migration acknowledgement does not match the prepared snapshot");
    }
    await this.verifyNodeActive(state);
    this.storage.transactionSync(() => this.storage.sql.exec(
      "UPDATE executor_migration SET phase = 'active', updated_at = ? WHERE singleton = 1 AND phase IN ('frozen', 'active') AND origin = ? AND epoch = ? AND manifest_hash = ?",
      Date.now(), state.origin, epoch, manifestHash,
    ));
    await this.scheduleOutboxAlarm(Date.now() + 1_000);
  }

  async enqueueWebsite(input: IntakeWebsiteInput): Promise<EnqueueResult> {
    if (input.challengeExpiresAt <= Date.now()) return { error: "human-check-used" };
    if (!input.nonce || input.nonce.length > 256 || !input.payload || new TextEncoder().encode(input.payload).byteLength > maxStoredPayloadBytes) {
      throw new TypeError("Website intake payload exceeds its bound");
    }
    const used = this.storage.sql.exec<{ nonce: string; event_id: string }>(
      hasSqlTable(this.storage, "consumed_challenges")
        ? "SELECT nonce, event_id FROM consumed_challenges WHERE nonce = ? UNION ALL SELECT nonce, event_id FROM executor_intake_challenges WHERE nonce = ? LIMIT 1"
        : "SELECT nonce, event_id FROM executor_intake_challenges WHERE nonce = ? LIMIT 1",
      ...(hasSqlTable(this.storage, "consumed_challenges") ? [input.nonce, input.nonce] : [input.nonce]),
    ).toArray()[0];
    if (used) {
      if (used.event_id === input.eventId) {
        const prior = this.findOutboxByEventId(input.eventId);
        if (prior) return existingOutboxResult(prior, input.bodyHash);
        const legacy = this.findLegacyByEventId(input.eventId);
        if (legacy) return existingLegacyResult(legacy, input.bodyHash);
      }
      return { error: "human-check-used" };
    }

    const duplicate = this.findOutboxByEventIdOrSource("website", input.eventId, input.sourceId) ?? this.findLegacyByEventId(input.eventId);
    if (duplicate) {
      const result = "state" in duplicate ? existingOutboxResult(duplicate, input.bodyHash) : existingLegacyResult(duplicate, input.bodyHash);
      if (!isError(result)) this.storage.transactionSync(() => this.storage.sql.exec(
        "INSERT INTO executor_intake_challenges (nonce, expires_at, event_id) VALUES (?, ?, ?)", input.nonce, input.challengeExpiresAt, input.eventId,
      ));
      return result;
    }

    this.assertOutboxCapacity(input.payload);
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.storage.sql.exec("INSERT INTO executor_intake_challenges (nonce, expires_at, event_id) VALUES (?, ?, ?)", input.nonce, input.challengeExpiresAt, input.eventId);
      this.storage.sql.exec(`INSERT INTO executor_intake_outbox
        (event_id, source, source_id, body_hash, payload, challenge_nonce, challenge_expires_at, state, created_at, updated_at)
        VALUES (?, 'website', ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      input.eventId, input.sourceId, input.bodyHash, input.payload, input.nonce, input.challengeExpiresAt, now, now);
    });
    await this.scheduleIfActive(now + 1_000);
    return { eventId: input.eventId, status: "pending", duplicate: false };
  }

  async enqueueEmail(input: IntakeEmailInput): Promise<EnqueueResult> {
    if (!input.sourceId || input.sourceId.length > 512 || !input.payload || new TextEncoder().encode(input.payload).byteLength > maxStoredPayloadBytes) {
      throw new TypeError("Email intake payload exceeds its bound");
    }
    const duplicate = this.findOutboxByEventIdOrSource("email", input.eventId, input.sourceId) ??
      this.findLegacyByEventId(input.eventId) ?? this.findLegacyEmailBySource(input.sourceId);
    if (duplicate) return "state" in duplicate ? existingOutboxResult(duplicate, input.bodyHash) : existingLegacyResult(duplicate, input.bodyHash);

    this.assertOutboxCapacity(input.payload);
    const now = Date.now();
    this.storage.transactionSync(() => this.storage.sql.exec(`INSERT INTO executor_intake_outbox
      (event_id, source, source_id, body_hash, payload, state, created_at, updated_at)
      VALUES (?, 'email', ?, ?, ?, 'queued', ?, ?)`, input.eventId, input.sourceId, input.bodyHash, input.payload, now, now));
    await this.scheduleIfActive(now + 1_000);
    return { eventId: input.eventId, status: "pending", duplicate: false };
  }

  getEvent(eventId: string): { eventId: string; source: string; status: StoredEventStatus; createdAt: number } | null {
    const row = this.findOutboxByEventId(eventId);
    return row ? { eventId: row.event_id, source: row.source, status: "pending", createdAt: row.created_at } : null;
  }

  async alarm(): Promise<void> {
    const state = await this.phase();
    if (state?.phase === "frozen") {
      await this.storage.deleteAlarm();
      return;
    }
    if (!state && !(await this.freshExecutionRoute())) { await this.storage.deleteAlarm(); return; }
    await this.drainOne();
  }

  async drainOne(): Promise<void> {
    const row = this.storage.sql.exec<OutboxRow>(`SELECT * FROM executor_intake_outbox
      WHERE state != 'forwarded' AND next_attempt_at <= ? ORDER BY created_at, event_id LIMIT 1`, Date.now()).toArray()[0];
    if (!row) {
      const next = this.storage.sql.exec<{ next_attempt_at: number }>("SELECT MIN(next_attempt_at) AS next_attempt_at FROM executor_intake_outbox WHERE state != 'forwarded'").toArray()[0]?.next_attempt_at;
      if (typeof next === "number") await this.scheduleOutboxAlarm(next);
      else await this.storage.deleteAlarm();
      return;
    }

    try {
      const state = await this.phase();
      const route = state?.phase === "active" ? { origin: state.origin, epoch: state.epoch } : !state ? await this.freshExecutionRoute() : null;
      if (!route) { await this.storage.deleteAlarm(); return; }
      if (configuredOrigin(this.env.EXECUTOR_ORIGIN) !== route.origin) throw new Error("Executor outbox route does not match configured origin");
      const secret = this.env.EVENT_STORAGE_SECRET;
      if (!secret) throw new Error("Event storage encryption is not configured");
      const event = await decryptEventPayload(secret, row.event_id, row.payload);
      const rawContext = await callExecutorRpc<unknown>(this.env, this.integrationId, route.epoch, "classificationContext", [], 2 * 1024 * 1024);
      const context = readNodeClassificationContext(rawContext, this.integrationId, event.source);
      let classification: AutomationPipelineResult;
      if (row.classification_payload) {
        classification = await decryptEventClassification(secret, row.event_id, row.classification_payload) as AutomationPipelineResult;
      } else {
        classification = context.allowed
          ? await classifyExecutorEvent(event, context.value, this.env.AI)
          : reviewForDisabledSource(event);
        const encrypted = await encryptEventClassification(secret, row.event_id, classification);
        if (new TextEncoder().encode(encrypted).byteLength > maxStoredClassificationBytes) throw new Error("Executor classification exceeds its storage bound");
        this.storage.transactionSync(() => this.storage.sql.exec(`UPDATE executor_intake_outbox
          SET classification_payload = ?, state = 'classified', updated_at = ? WHERE event_id = ? AND state != 'forwarded'`, encrypted, Date.now(), row.event_id));
      }
      const envelope: ItemCommandEnvelope = { integrationId: this.integrationId, sourceEventId: row.event_id,
        idempotencyKey: row.body_hash, event, classification };
      await submitExecutorItemCommand(this.env, this.integrationId, envelope);
      this.storage.transactionSync(() => this.storage.sql.exec(`UPDATE executor_intake_outbox
        SET state = 'forwarded', attempt = attempt + 1, next_attempt_at = 0, updated_at = ? WHERE event_id = ?`, Date.now(), row.event_id));
      await this.scheduleOutboxAlarm(Date.now() + 1);
    } catch (error) {
      const attempt = row.attempt + 1;
      const delay = Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(attempt, 8));
      const next = Date.now() + delay;
      this.storage.transactionSync(() => this.storage.sql.exec(`UPDATE executor_intake_outbox
        SET attempt = ?, next_attempt_at = ?, updated_at = ? WHERE event_id = ? AND state != 'forwarded'`, attempt, next, Date.now(), row.event_id));
      await this.scheduleOutboxAlarm(next);
      recordAutomationException(error, { event: "executor.intake.forward.retry", integrationId: this.integrationId,
        eventId: row.event_id, attempt, operation: "executor-intake-forward" });
      console.warn(JSON.stringify({ event: "executor.intake.forward.retry", integrationId: this.integrationId,
        eventId: row.event_id, attempt, errorType: error instanceof Error ? error.name : "unknown" }));
    }
  }

  private findOutboxByEventId(eventId: string): OutboxRow | undefined {
    return this.storage.sql.exec<OutboxRow>("SELECT * FROM executor_intake_outbox WHERE event_id = ?", eventId).toArray()[0];
  }

  private findOutboxByEventIdOrSource(source: string, eventId: string, sourceId: string): OutboxRow | undefined {
    return this.storage.sql.exec<OutboxRow>("SELECT * FROM executor_intake_outbox WHERE event_id = ? OR (source = ? AND source_id = ?)", eventId, source, sourceId).toArray()[0];
  }

  private findLegacyByEventId(eventId: string): { event_id: string; status: StoredEventStatus; body_hash: string } | undefined {
    if (!hasSqlTable(this.storage, "events")) return undefined;
    return this.storage.sql.exec<{ event_id: string; status: StoredEventStatus; body_hash: string }>(
      "SELECT event_id, status, body_hash FROM events WHERE event_id = ?", eventId).toArray()[0];
  }

  private findLegacyEmailBySource(sourceId: string): { event_id: string; status: StoredEventStatus; body_hash: string } | undefined {
    if (!hasSqlTable(this.storage, "events")) return undefined;
    return this.storage.sql.exec<{ event_id: string; status: StoredEventStatus; body_hash: string }>(
      "SELECT event_id, status, body_hash FROM events WHERE source = 'email' AND source_id = ?", sourceId).toArray()[0];
  }

  private assertOutboxCapacity(payload: string): void {
    const size = new TextEncoder().encode(payload).byteLength;
    if (size > maxStoredPayloadBytes) throw new TypeError("Executor intake payload exceeds its size limit");
    const row = this.storage.sql.exec<{ count: number; bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(length(payload) + COALESCE(length(classification_payload), ${maxStoredClassificationBytes})), 0) AS bytes
       FROM executor_intake_outbox`).one();
    if (row.count >= maxOutboxRows || row.bytes + size + maxStoredClassificationBytes > maxOutboxBytes) throw new Error("Executor intake queue is full; retry later");
  }

  private async scheduleIfActive(at: number): Promise<void> {
    const state = await this.phase();
    if (state?.phase === "active" || (!state && await this.freshExecutionRoute())) await this.scheduleOutboxAlarm(at);
  }

  private async scheduleOutboxAlarm(at: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || at < current) await this.storage.setAlarm(at);
  }

  private async verifyNodeActive(state: MigrationState): Promise<void> {
    const token = this.env.EXECUTOR_SERVICE_TOKEN;
    if (!token || new TextEncoder().encode(token).byteLength < 32) throw new Error("Executor service authentication is not configured");
    const response = await fetch(`${state.origin}/internal/integrations/${encodeURIComponent(this.integrationId)}/status`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error",
    });
    const payload = await readSmallJson(response);
    if (!response.ok || !isRecord(payload) || payload.status !== "active" || payload.epoch !== state.epoch || payload.manifestHash !== state.manifest_hash) {
      throw new Error("Executor is not active for this exact migration epoch and manifest");
    }
  }
}

export class ExecutorMigrationFencedError extends Error {
  readonly status = 503;
  constructor(message = "Legacy executor is fenced until migration is acknowledged") { super(message); this.name = "ExecutorMigrationFencedError"; }
}

export function existingOutboxResult(row: Pick<OutboxRow, "event_id" | "body_hash" | "state">, bodyHash: string): EnqueueResult {
  if (row.body_hash !== bodyHash) return { error: "idempotency-conflict" };
  return { eventId: row.event_id, status: "pending", duplicate: true };
}

function existingLegacyResult(row: { event_id: string; status: StoredEventStatus; body_hash: string }, bodyHash: string): EnqueueResult {
  if (row.body_hash !== bodyHash) return { error: "idempotency-conflict" };
  return { eventId: row.event_id, status: row.status, duplicate: true };
}

function isError(result: EnqueueResult): result is { error: "human-check-used" | "idempotency-conflict" } { return "error" in result; }

function configuredOrigin(value: string | undefined): string {
  if (!value) throw new Error("Executor origin is not configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("Executor origin must be an HTTPS origin");
  return url.origin;
}

async function readSmallJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) { await reader.cancel("Executor status response exceeds its bound"); throw new Error("Executor status response exceeds its bound"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function readNodeClassificationContext(value: unknown, integrationId: string, source: AutomationEvent["source"]): { value: ClassificationContext; allowed: boolean } {
  if (!isRecord(value) || value.integrationId !== integrationId || !["active", "paused", "deleted"].includes(String(value.control)) ||
    !isRecord(value.allowedSources) || typeof value.allowedSources.website !== "boolean" || typeof value.allowedSources.email !== "boolean") {
    throw new Error("Executor returned an invalid classification context");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) throw new Error("Executor classification context exceeds its size bound");
  if (value.control !== "active") throw new Error("Executor automation is not active; intake remains queued");
  const context: ClassificationContext = {
    ...(value.definition === undefined || value.definition === null ? {} : { definition: value.definition as ClassificationContext["definition"] }),
    ...(value.employeeProfile === undefined ? {} : { employeeProfile: value.employeeProfile as ClassificationContext["employeeProfile"] }),
    ...(value.priorityBands === undefined ? {} : { priorityBands: value.priorityBands as ClassificationContext["priorityBands"] }),
  };
  return { value: context, allowed: value.allowedSources[source] === true };
}

function reviewForDisabledSource(event: AutomationEvent): AutomationPipelineResult {
  return { status: "review", reason: "Event source is disabled for this automation",
    source: event.source === "email"
      ? { type: "email", receivedAt: event.receivedAt, messageId: event.message.messageId }
      : { type: "website", receivedAt: event.receivedAt, ...(event.submission.jobUrl ? { jobUrl: event.submission.jobUrl } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

function hasSqlTable(storage: ExecutionStoragePort, name: "consumed_challenges" | "events"): boolean {
  return storage.sql.exec<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
}
