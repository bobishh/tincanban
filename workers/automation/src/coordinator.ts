import { DurableObject } from "cloudflare:workers";
import { runPipeline, type AutomationEvent, type AutomationPipelineResult } from "./pipeline";
import type { WorkerEnv, AutomationIntegration } from "./index";
import { correlateApplication } from "./email";
import { AutomationReplica, AutomationControlError, type AutomationActivationPacket, type AutomationCandidate } from "./replica";
import { runRegisteredAutomation } from "./handlers";
import { canonicalizeJson, signEnvelope } from "../../../src/domain/identity";
import { profileFromIdentitySeedForDevice } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import type { DeviceCertificate } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";

/** Publish a complete encrypted generation atomically; callers encrypt before entering this sync transaction. */
export function writeReplicaChunksAtomically(storage: DurableObjectStorage, generation: string, chunks: string[], updatedAt: number): void {
  storage.transactionSync(() => {
    const previous = storage.sql.exec<{ state_generation: string | null }>(
      "SELECT state_generation FROM automation_replica WHERE singleton = 1",
    ).toArray()[0]?.state_generation ?? null;
    for (let index = 0; index < chunks.length; index += 1) {
      storage.sql.exec(
        "INSERT INTO automation_replica_chunks (kind, generation, chunk_index, total_chunks, data) VALUES ('state', ?, ?, ?, ?)",
        generation, index, chunks.length, chunks[index]!,
      );
    }
    storage.sql.exec(
      `INSERT INTO automation_replica (singleton, encrypted_packet, encrypted_state, state_generation, updated_at)
       VALUES (1, NULL, NULL, ?, ?) ON CONFLICT(singleton) DO UPDATE SET encrypted_state = NULL,
       state_generation = excluded.state_generation, updated_at = excluded.updated_at`, generation, updatedAt,
    );
    if (previous && previous !== generation) storage.sql.exec(
      "DELETE FROM automation_replica_chunks WHERE kind = 'state' AND generation = ?", previous,
    );
  });
}

export type StoredEventStatus = "pending" | "processing" | "review" | "failed" | "applied";
export type EnqueueSuccess = { eventId: string; status: StoredEventStatus; duplicate: boolean };
export type EnqueueResult = EnqueueSuccess | { error: "human-check-used" | "idempotency-conflict" };

type EventRow = {
  event_id: string;
  source: "website" | "email";
  source_id: string;
  body_hash: string;
  payload: string;
  status: StoredEventStatus;
  attempt: number;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
  result: string | null;
};

type OwnerRegistration = { integrationId: string; workspaceId: string; ownerPersonId: string };

const maximumAttempts = 8;
const processingLeaseMs = 2 * 60_000;
const controlPollMs = 15_000;

/** Serializes durable intake, replay protection and classification for one integration. */
export class AutomationCoordinator extends DurableObject<WorkerEnv> {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS automation_registration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, integration_id TEXT NOT NULL, routing TEXT
      );
      CREATE TABLE IF NOT EXISTS consumed_challenges (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        event_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_identities (
        integration_id TEXT PRIMARY KEY,
        encrypted_seed TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_replica (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        encrypted_packet TEXT,
        encrypted_state TEXT,
        state_generation TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_replica_chunks (
        kind TEXT NOT NULL CHECK (kind = 'state'),
        generation TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (kind, generation, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('website', 'email')),
        source_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'review', 'failed', 'applied')),
        attempt INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        result TEXT,
        UNIQUE (source, source_id)
      );
      CREATE INDEX IF NOT EXISTS events_queue ON events(status, created_at);
    `);
    const eventSchema = ctx.storage.sql.exec<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'",
    ).toArray()[0]?.sql ?? "";
    if (eventSchema && !eventSchema.includes("'applied'")) {
      ctx.storage.sql.exec("DROP INDEX IF EXISTS events_queue; ALTER TABLE events RENAME TO events_legacy;");
      ctx.storage.sql.exec(`CREATE TABLE events (
        event_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('website', 'email')), source_id TEXT NOT NULL,
        body_hash TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'review', 'failed', 'applied')),
        attempt INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        result TEXT, UNIQUE (source, source_id)
      );
      INSERT INTO events SELECT * FROM events_legacy;
      DROP TABLE events_legacy;
      CREATE INDEX events_queue ON events(status, created_at);`);
    }
    const replicaColumns = new Set(ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(automation_replica)").toArray().map(column => column.name));
    if (!replicaColumns.has("state_generation")) ctx.storage.sql.exec("ALTER TABLE automation_replica ADD COLUMN state_generation TEXT");
    const eventColumns = new Set(ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(events)").toArray().map(column => column.name));
    if (!eventColumns.has("next_attempt_at")) ctx.storage.sql.exec("ALTER TABLE events ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
  }

  enrollOwner(registration: OwnerRegistration, secret: string) {
    return this.serializeMutation(async () => {
      const existing = this.registration();
      if (existing) this.assertOwnerRegistration(registration);
      else this.ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, ?, ?, ?)",
        registration.ownerPersonId, registration.workspaceId, registration.integrationId);
      return this.provisionIdentity(registration.integrationId, secret);
    });
  }

  activateOwner(registration: OwnerRegistration, packet: AutomationActivationPacket, integration: AutomationIntegration, origin: string) {
    return this.serializeMutation(async () => {
      this.assertOwnerRegistration(registration);
      const secret = this.env.EVENT_STORAGE_SECRET!;
      // Activation revalidates the grant and the entire causal document before routing can become public.
      const result = await this.activateReplicaNow(registration.integrationId, this.env.IDENTITY_STORAGE_SECRET!, secret, packet, origin);
      if (result.ok || result.status === 503) this.ctx.storage.sql.exec("UPDATE automation_registration SET routing = ? WHERE singleton = 1", JSON.stringify(integration));
      return result;
    });
  }

  async getRegisteredIntegration(): Promise<AutomationIntegration | null> {
    const row = this.ctx.storage.sql.exec<{ routing: string | null }>("SELECT routing FROM automation_registration WHERE singleton = 1").toArray()[0];
    return row?.routing ? JSON.parse(row.routing) as AutomationIntegration : null;
  }

  observeOwner(registration: OwnerRegistration, nonce: string, origin: string) {
    return this.serializeMutation(async () => {
      this.assertOwnerRegistration(registration);
      const serialized = await this.loadReplicaState(this.env.EVENT_STORAGE_SECRET!);
      if (!serialized) return null;
      const profile = await this.getIdentityProfile(registration.integrationId, this.env.IDENTITY_STORAGE_SECRET!);
      const replica = await AutomationReplica.restore(serialized, profile, value => this.saveReplicaState(this.env.EVENT_STORAGE_SECRET!, value));
      const payload = replica.observationForRuntime(origin, nonce);
      return { publicKey: profile.identity.publicKey, certificates: [profile.certificate],
        signed: await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId) };
    });
  }

  private registration() {
    return this.ctx.storage.sql.exec<{ owner_id: string; workspace_id: string; integration_id: string }>(
      "SELECT owner_id, workspace_id, integration_id FROM automation_registration WHERE singleton = 1").toArray()[0];
  }

  private assertOwnerRegistration(value: OwnerRegistration): void {
    const stored = this.registration();
    if (!stored || stored.owner_id !== value.ownerPersonId || stored.workspace_id !== value.workspaceId || stored.integration_id !== value.integrationId) {
      throw new Error("Automation is not enrolled for this owner and workspace, or already bound elsewhere");
    }
  }

  async provisionIdentity(integrationId: string, encryptionSecret: string): Promise<{
    identity: { personId: string; publicKey: string; displayName: string };
    device: { deviceId: string; publicKey: string; displayName: string };
    deviceCertificate: DeviceCertificate;
  }> {
    if (new TextEncoder().encode(encryptionSecret).byteLength < 32) throw new Error("Identity storage secret must contain at least 32 bytes");
    const stored = this.ctx.storage.sql.exec<{ encrypted_seed: string }>(
      "SELECT encrypted_seed FROM automation_identities WHERE integration_id = ?", integrationId,
    ).toArray()[0];
    if (!stored) {
      const seeds = { identitySeed: crypto.getRandomValues(new Uint8Array(32)), deviceEntropy: crypto.getRandomValues(new Uint8Array(32)) };
      const encrypted = await encryptIdentitySeeds(encryptionSecret, integrationId, seeds);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO automation_identities (integration_id, encrypted_seed, created_at) VALUES (?, ?, ?)",
        integrationId, encrypted, Date.now(),
      );
    }
    const durable = stored ?? this.ctx.storage.sql.exec<{ encrypted_seed: string }>(
      "SELECT encrypted_seed FROM automation_identities WHERE integration_id = ?", integrationId,
    ).toArray()[0];
    if (!durable) throw new Error("Automation identity could not be persisted");
    const seeds = await decryptIdentitySeeds(encryptionSecret, integrationId, durable.encrypted_seed);
    const profile = await profileFromIdentitySeedForDevice(seeds.identitySeed, "Tincanban automation", seeds.deviceEntropy);
    return {
      identity: profile.identity,
      device: profile.device,
      deviceCertificate: profile.certificate,
    };
  }

  private async getIdentityProfile(integrationId: string, encryptionSecret: string) {
    await this.provisionIdentity(integrationId, encryptionSecret);
    const stored = this.ctx.storage.sql.exec<{ encrypted_seed: string }>(
      "SELECT encrypted_seed FROM automation_identities WHERE integration_id = ?", integrationId,
    ).toArray()[0];
    if (!stored) throw new Error("Automation identity could not be loaded");
    const seeds = await decryptIdentitySeeds(encryptionSecret, integrationId, stored.encrypted_seed);
    return profileFromIdentitySeedForDevice(seeds.identitySeed, "Tincanban automation", seeds.deviceEntropy);
  }

  activateReplica(integrationId: string, identitySecret: string, storageSecret: string,
    packet: AutomationActivationPacket) {
    return this.serializeMutation(() => this.activateReplicaNow(integrationId, identitySecret, storageSecret, packet));
  }

  private async activateReplicaNow(integrationId: string, identitySecret: string, storageSecret: string,
    packet: AutomationActivationPacket, origin?: string): Promise<
      | { ok: true; status: "active" | "paused" | "deleted"; workspaceId: string; synced: true }
      | { ok: false; status: 422 | 503; error: string; detail?: string }
    > {
    const profile = await this.getIdentityProfile(integrationId, identitySecret);
    if (packet.grant?.payload?.personId !== profile.identity.personId) {
      return { ok: false, status: 422, error: "Automation grant subject does not match this integration identity" };
    }
    const persist = (serialized: string) => this.saveReplicaState(storageSecret, serialized);
    let replica: AutomationReplica;
    try {
      const existing = await this.loadReplicaState(storageSecret);
      if (existing) {
        const state = JSON.parse(existing) as { grant: unknown; definition?: unknown };
        if (canonicalizeJson(state.grant) !== canonicalizeJson(packet.grant) ||
          canonicalizeJson(state.definition ?? null) !== canonicalizeJson(packet.definition ?? null)) {
          throw new Error("Existing automation identity cannot be rebound; create a new instance");
        }
        replica = await AutomationReplica.restore(existing, profile, persist);
        if (replica.controlForRuntime().state === "deleted") throw new Error("Deleted automation cannot be reactivated");
      } else replica = await AutomationReplica.activate({ ...packet, persist }, profile, origin);
      if (origin) replica.observationForRuntime(origin, crypto.randomUUID());
    }
    catch (error) {
      return { ok: false, status: 422, error: error instanceof Error ? error.message : "Activation proof validation failed" };
    }
    await persist(replica.serialize());
    await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
    try { await replica.sync(); }
    catch (error) {
      return { ok: false, status: 503, error: "Activation is stored but the encrypted snapshot did not sync; retry activation",
        detail: error instanceof Error ? error.message : "Rusty synchronization failed" };
    }
    await persist(replica.serialize());
    return { ok: true, status: replica.controlForRuntime().state, workspaceId: packet.workspaceId, synced: true };
  }

  async saveReplicaState(secret: string, serialized: string): Promise<void> {
    const encrypted = await encryptReplicaValue(secret, this.ctx.id.name ?? "", "state", serialized);
    const generation = crypto.randomUUID();
    const chunkSize = 900_000;
    const chunks = Array.from({ length: Math.ceil(encrypted.length / chunkSize) }, (_, index) => encrypted.slice(index * chunkSize, (index + 1) * chunkSize));
    writeReplicaChunksAtomically(this.ctx.storage, generation, chunks, Date.now());
  }

  async loadReplicaState(secret: string): Promise<string | null> {
    const row = this.ctx.storage.sql.exec<{ encrypted_state: string | null; state_generation: string | null }>(
      "SELECT encrypted_state, state_generation FROM automation_replica WHERE singleton = 1",
    ).toArray()[0];
    if (!row) return null;
    if (!row.state_generation) return row.encrypted_state ? decryptReplicaValue(secret, this.ctx.id.name ?? "", "state", row.encrypted_state) : null;
    const chunks = this.ctx.storage.sql.exec<{ chunk_index: number; total_chunks: number; data: string }>(
      "SELECT chunk_index, total_chunks, data FROM automation_replica_chunks WHERE kind = 'state' AND generation = ? ORDER BY chunk_index",
      row.state_generation,
    ).toArray();
    if (!chunks.length || chunks.some((chunk, index) => chunk.chunk_index !== index || chunk.total_chunks !== chunks.length)) {
      throw new Error("Stored automation replica chunks are incomplete");
    }
    return decryptReplicaValue(secret, this.ctx.id.name ?? "", "state", chunks.map(chunk => chunk.data).join(""));
  }

  async enqueueWebsite(input: {
    eventId: string;
    sourceId: string;
    bodyHash: string;
    nonce: string;
    challengeExpiresAt: number;
    payload: string;
  }): Promise<EnqueueResult> {
    const now = Date.now();
    if (input.challengeExpiresAt <= now) return { error: "human-check-used" };
    const used = this.ctx.storage.sql.exec<{ nonce: string; event_id: string }>(
      "SELECT nonce, event_id FROM consumed_challenges WHERE nonce = ?", input.nonce,
    ).toArray()[0];
    if (used) {
      const repeated = used.event_id === input.eventId ? this.findById(input.eventId) : undefined;
      if (repeated) return this.existingResult(repeated, input.bodyHash);
      return { error: "human-check-used" };
    }

    const existing = this.findById(input.eventId);
    if (existing) {
      const duplicate = this.existingResult(existing, input.bodyHash);
      if ("error" in duplicate) return duplicate;
      this.ctx.storage.sql.exec(
        "INSERT INTO consumed_challenges (nonce, expires_at, event_id) VALUES (?, ?, ?)",
        input.nonce, input.challengeExpiresAt, input.eventId,
      );
      return duplicate;
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO consumed_challenges (nonce, expires_at, event_id) VALUES (?, ?, ?)",
      input.nonce, input.challengeExpiresAt, input.eventId,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO events (event_id, source, source_id, body_hash, payload, status, created_at, updated_at)
       VALUES (?, 'website', ?, ?, ?, 'pending', ?, ?)`,
      input.eventId, input.sourceId, input.bodyHash, input.payload, now, now,
    );
    await this.scheduleEarlierAlarm(now + 1_000);
    return { eventId: input.eventId, status: "pending", duplicate: false };
  }

  async enqueueEmail(input: {
    eventId: string;
    sourceId: string;
    bodyHash: string;
    payload: string;
  }): Promise<EnqueueResult> {
    const existing = this.findById(input.eventId);
    if (existing) return this.existingResult(existing, input.bodyHash);
    const duplicateSource = this.ctx.storage.sql.exec<EventRow>(
      "SELECT * FROM events WHERE source = 'email' AND source_id = ?", input.sourceId,
    ).toArray()[0];
    if (duplicateSource) return this.existingResult(duplicateSource, input.bodyHash);

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO events (event_id, source, source_id, body_hash, payload, status, created_at, updated_at)
       VALUES (?, 'email', ?, ?, ?, 'pending', ?, ?)`,
      input.eventId, input.sourceId, input.bodyHash, input.payload, now, now,
    );
    await this.scheduleEarlierAlarm(now + 1_000);
    return { eventId: input.eventId, status: "pending", duplicate: false };
  }

  getEvent(eventId: string): { eventId: string; source: string; status: StoredEventStatus; createdAt: number; result?: unknown } | null {
    const row = this.findById(eventId);
    if (!row) return null;
    const result = row.result ? JSON.parse(row.result) as Record<string, unknown> : undefined;
    const decision = result?.decision;
    const rawAction = result?.action;
    const action = rawAction && typeof rawAction === "object" && !Array.isArray(rawAction)
      ? rawAction as Record<string, unknown> : undefined;
    return {
      eventId: row.event_id,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      ...(result ? {
        result: {
          reason: typeof result.reason === "string" ? result.reason : undefined,
          decision,
          ...(action && typeof action.kind === "string" && typeof action.cardId === "string" ? {
            action: {
              kind: action.kind,
              cardId: action.cardId,
              ...(typeof action.columnId === "string" ? { columnId: action.columnId } : {}),
              ...(typeof action.message === "string" ? { message: action.message } : {}),
            },
          } : {}),
        },
      } : {}),
    };
  }

  alarm(): Promise<void> { return this.serializeMutation(() => this.processAlarm()); }

  private async processAlarm(): Promise<void> {
    let replica: AutomationReplica | null;
    try { replica = await this.refreshReplica(); }
    catch (error) {
      console.error(JSON.stringify({ event: "automation.control-sync-failed", integrationId: this.ctx.id.name,
        error: error instanceof Error ? error.message : "Control synchronization failed" }));
      await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
      return;
    }
    const control = replica?.controlForRuntime();
    if (control?.state === "paused") { await this.scheduleEarlierAlarm(Date.now() + controlPollMs); return; }
    if (control?.state === "deleted") {
      this.ctx.storage.sql.exec("UPDATE events SET status = 'review', claimed_at = NULL, updated_at = ?, result = ? WHERE status IN ('pending', 'processing')",
        Date.now(), JSON.stringify({ reason: "Automation was deleted; queued event was not executed", retryable: false }));
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<EventRow>(
      `SELECT * FROM events
       WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND claimed_at <= ?)
       ORDER BY created_at LIMIT 1`,
      now, now - processingLeaseMs,
    ).toArray()[0];
    if (!row) { await this.scheduleNextWork(!!replica?.definitionForRuntime()); return; }

    if (replica && !replica.allowsSource(row.source)) {
      this.saveResult(row.event_id, "review", row.attempt, { reason: "Event source is disabled for this automation", retryable: false });
      await this.scheduleNextWork(!!replica.definitionForRuntime());
      return;
    }

    const attempt = row.attempt + 1;
    this.ctx.storage.sql.exec(
      `UPDATE events SET status = 'processing', attempt = ?, claimed_at = ?, updated_at = ? WHERE event_id = ?`,
      attempt, now, now, row.event_id,
    );

    try {
      if (!this.env.EVENT_STORAGE_SECRET) throw new Error("Event storage encryption is not configured");
      const event = await decryptEventPayload(this.env.EVENT_STORAGE_SECRET, row.event_id, row.payload);
      const emailCandidates = event.source === "email" ? replica?.candidates() : undefined;
      const definition = replica?.definitionForRuntime();
      const result = await (definition ? runRegisteredAutomation(definition, event, this.env.AI, replica?.employeeProfileForRuntime(), replica?.priorityBandsForRuntime()) : runPipeline(event, this.env.AI, undefined, replica?.employeeProfileForRuntime(), replica?.priorityBandsForRuntime()));
      const action = await this.applyScopedDecision(row.event_id, event, result, emailCandidates, replica);
      this.saveResult(row.event_id, action ? "applied" : "review", attempt,
        action ? { ...result, status: "applied", reason: action.message, action } : result);
    } catch (error) {
      if (error instanceof AutomationControlError) {
        this.ctx.storage.sql.exec("UPDATE events SET status = ?, attempt = ?, claimed_at = NULL, updated_at = ?, result = ? WHERE event_id = ?",
          error.state === "paused" ? "pending" : "review", row.attempt, Date.now(),
          JSON.stringify({ reason: error.message, retryable: error.state === "paused" }), row.event_id);
        if (error.state === "paused") await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
        else await this.scheduleNextWork(true);
        return;
      }
      const message = error instanceof Error ? error.message : "Automation processing failed";
      if (attempt >= maximumAttempts) {
        this.ctx.storage.sql.exec(
          "UPDATE events SET status = 'failed', claimed_at = NULL, updated_at = ?, result = ? WHERE event_id = ?",
          Date.now(), JSON.stringify({ reason: message, retryable: false }), row.event_id,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE events SET status = 'pending', claimed_at = NULL, updated_at = ?, next_attempt_at = ?, result = ? WHERE event_id = ?",
          Date.now(), Date.now() + backoffMs(attempt), JSON.stringify({ reason: message, retryable: true }), row.event_id,
        );
      }
      await this.scheduleNextWork(!!replica?.definitionForRuntime());
      return;
    }
    await this.scheduleNextWork(!!replica?.definitionForRuntime());
  }

  private serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(action, action);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async scheduleEarlierAlarm(time: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || time < existing) await this.ctx.storage.setAlarm(time);
  }

  private async scheduleNextWork(pollControls: boolean): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ next_at: number | null }>(
      `SELECT MIN(CASE WHEN status = 'pending' THEN next_attempt_at WHEN status = 'processing' THEN claimed_at + ? END) AS next_at
       FROM events WHERE status IN ('pending', 'processing')`, processingLeaseMs,
    ).one().next_at;
    const times = [pollControls ? Date.now() + controlPollMs : null, next].filter((time): time is number => time !== null);
    if (times.length) await this.scheduleEarlierAlarm(Math.max(Date.now() + 1, Math.min(...times)));
  }

  private async refreshReplica(): Promise<AutomationReplica | null> {
    const secret = this.env.EVENT_STORAGE_SECRET;
    const identitySecret = this.env.IDENTITY_STORAGE_SECRET;
    if (!secret || !identitySecret) return null;
    const serialized = await this.loadReplicaState(secret);
    if (!serialized) return null;
    const profile = await this.getIdentityProfile(this.ctx.id.name ?? "", identitySecret);
    const replica = await AutomationReplica.restore(serialized, profile, next => this.saveReplicaState(secret, next));
    await replica.sync();
    return replica;
  }

  private findById(eventId: string): EventRow | undefined {
    return this.ctx.storage.sql.exec<EventRow>("SELECT * FROM events WHERE event_id = ?", eventId).toArray()[0];
  }

  private existingResult(row: EventRow, bodyHash: string): EnqueueResult {
    if (row.body_hash !== bodyHash) return { error: "idempotency-conflict" };
    return { eventId: row.event_id, status: row.status, duplicate: true };
  }

  private saveResult(eventId: string, status: StoredEventStatus, attempt: number, result: unknown): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE events SET status = ?, claimed_at = NULL, updated_at = ?, result = ? WHERE event_id = ? AND attempt = ?",
      status, now, JSON.stringify(result), eventId, attempt,
    );
  }

  private async applyScopedDecision(eventId: string, event: AutomationEvent, result: AutomationPipelineResult,
    emailCandidates: AutomationCandidate[] | undefined, replica: AutomationReplica | null): Promise<{
    kind: "created-lead" | "moved-application"; cardId: string; columnId?: string; message: string;
  } | null> {
    const leadDecision = event.source === "website" && result.decision && "relevance" in result.decision ? result.decision : undefined;
    const mailDecision = event.source === "email" && result.decision && "event" in result.decision ? result.decision : undefined;
    const isLeadProposal = leadDecision?.relevance === "yes";
    const isApplicationMove = mailDecision?.event === "interview" || mailDecision?.event === "rejection";
    if (!isLeadProposal && !isApplicationMove) return null;
    if (isApplicationMove && !emailCandidates) return null;
    if (isLeadProposal) {
      const opportunity = leadDecision!.distributions.job_opportunity;
      const sorted = Object.values(opportunity.probabilities).sort((left, right) => right - left);
      if (sorted[0]! < 0.7 || sorted[0]! - sorted[1]! < 0.2) return null;
      if (!(event.source === "website") || !(event.submission.company || result.extraction?.company)?.trim() ||
        !(event.submission.role || result.extraction?.role)?.trim()) return null;
    }
    if (!replica) return null;
    await replica.sync();
    const control = replica.controlForRuntime();
    if (control.state !== "active") throw new AutomationControlError(control.state);
    if (!replica.allowsSource(event.source)) return null;

    if (event.source === "website" && isLeadProposal && leadDecision) {
      const company = event.submission.company || result.extraction?.company || "";
      const role = event.submission.role || result.extraction?.role || "";
      if (!company.trim() || !role.trim()) return null;
      const created = await replica.createLead(eventId, {
        company, role, jobUrl: result.extraction?.finalUrl ?? event.submission.jobUrl,
        message: event.submission.message, contact: event.submission.contact,
        roleType: leadDecision.roleType, seniority: leadDecision.seniority,
        sourceText: event.submission.message, receivedAt: event.receivedAt,
      }, leadDecision);
      await replica.sync();
      return { kind: "created-lead", cardId: created.cardId, message: created.duplicate ? "Lead was already applied" : "Lead created in the authorized Lead column" };
    }

    if (event.source === "email" && isApplicationMove && mailDecision) {
      const correlation = correlateApplication(event.message, emailCandidates!);
      if (correlation.kind !== "matched") return null;
      const candidate = emailCandidates!.find((item) => item.cardId === correlation.cardId);
      if (!candidate) return null;
      const messageTime = event.message.date ? Date.parse(event.message.date) : Number.NaN;
      const changedTime = candidate.workflow ? Date.parse(candidate.workflow.changedAt) : Number.NaN;
      if (!Number.isFinite(messageTime) || !Number.isFinite(changedTime) || messageTime < changedTime) return null;
      const columnId = mailDecision.event === "interview" ? replica.bindingsForRuntime().interview : replica.bindingsForRuntime().rejected;
      const columns = replica.bindingsForRuntime();
      const canAdvance = candidate.columnId === columns.lead && (columnId === columns.interview || columnId === columns.rejected) ||
        candidate.columnId === columns.interview && columnId === columns.rejected;
      if (!canAdvance) return null;
      const moved = await replica.moveCard(eventId, candidate.cardId, columnId,
        { columnId: candidate.columnId, ...(candidate.workflow ? { changedAt: candidate.workflow.changedAt } : {}) });
      await replica.sync();
      return { kind: "moved-application", cardId: moved.cardId, columnId,
        message: moved.duplicate ? "Application status was already applied" : `Application moved to ${mailDecision.event === "interview" ? "Interview" : "Rejected"}` };
    }
    return null;
  }

}

function backoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

type IdentitySeeds = { identitySeed: Uint8Array; deviceEntropy: Uint8Array };

async function encryptIdentitySeeds(secret: string, integrationId: string, seeds: IdentitySeeds): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await identityStorageKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    identitySeed: encodeBytes(seeds.identitySeed),
    deviceEntropy: encodeBytes(seeds.deviceEntropy),
  }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
    additionalData: new TextEncoder().encode(`TIN/automation-identity/v1/${integrationId}`), tagLength: 128 }, key, plaintext);
  return `${encodeBytes(nonce)}.${encodeBytes(new Uint8Array(ciphertext))}`;
}

async function decryptIdentitySeeds(secret: string, integrationId: string, value: string): Promise<IdentitySeeds> {
  const [nonceValue, ciphertextValue, extra] = value.split(".");
  if (!nonceValue || !ciphertextValue || extra !== undefined) throw new Error("Stored automation identity is invalid");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBytes(nonceValue),
    additionalData: new TextEncoder().encode(`TIN/automation-identity/v1/${integrationId}`), tagLength: 128 },
  await identityStorageKey(secret), decodeBytes(ciphertextValue));
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as Record<string, unknown>;
  const identitySeed = decodeBytes(String(parsed.identitySeed ?? ""));
  const deviceEntropy = decodeBytes(String(parsed.deviceEntropy ?? ""));
  if (identitySeed.byteLength !== 32 || deviceEntropy.byteLength !== 32) throw new Error("Stored automation identity is invalid");
  return { identitySeed, deviceEntropy };
}

async function identityStorageKey(secret: string): Promise<CryptoKey> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/identity-key/v1/${secret}`));
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function encryptReplicaValue(secret: string, integrationId: string, kind: "packet" | "state", value: string): Promise<string> {
  const key = await replicaStorageKey(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
    additionalData: new TextEncoder().encode(`TIN/automation-replica/v1/${integrationId}/${kind}`), tagLength: 128 },
  key, new TextEncoder().encode(value));
  return `${encodeBytes(nonce)}.${encodeBytes(new Uint8Array(ciphertext))}`;
}

async function decryptReplicaValue(secret: string, integrationId: string, kind: "packet" | "state", value: string): Promise<string> {
  const [nonceValue, ciphertextValue, extra] = value.split(".");
  if (!nonceValue || !ciphertextValue || extra !== undefined) throw new Error("Stored automation replica is invalid");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBytes(nonceValue),
    additionalData: new TextEncoder().encode(`TIN/automation-replica/v1/${integrationId}/${kind}`), tagLength: 128 },
  await replicaStorageKey(secret), decodeBytes(ciphertextValue));
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

async function replicaStorageKey(secret: string): Promise<CryptoKey> {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Event storage secret must contain at least 32 bytes");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/event-key/v1/${secret}`));
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function decodeBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Stored automation identity is invalid");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptEventPayload(secret: string, eventId: string, value: string): Promise<AutomationEvent> {
  const [nonceValue, ciphertextValue, extra] = value.split(".");
  if (!nonceValue || !ciphertextValue || extra !== undefined) throw new Error("Stored event payload is invalid");
  const key = await eventStorageKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBytes(nonceValue),
    additionalData: new TextEncoder().encode(`TIN/event-payload/v1/${eventId}`), tagLength: 128 }, key, decodeBytes(ciphertextValue));
  const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as AutomationEvent;
  if (event.source !== "website" && event.source !== "email") throw new Error("Stored event payload is invalid");
  return event;
}

async function eventStorageKey(secret: string): Promise<CryptoKey> {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Event storage secret must contain at least 32 bytes");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/event-key/v1/${secret}`));
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt"]);
}
