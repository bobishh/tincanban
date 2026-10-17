import { runPipeline, type AutomationEvent, type AutomationPipelineResult } from "./pipeline";
import { parseIntegrations, type AutomationIntegration } from "./configuration";
import type { ExecutionAdapters, ExecutionContextPort, ExecutionEnvironment, ExecutionSqlTransactionPort } from "./executionPorts";
import { privateEmailRoutes } from "./emailRoutes";
import { gmailForwardingConfirmationUrl } from "./email";
import { automationTelemetry, configureAutomationTelemetry, flushAutomationTelemetryAfter, recordAutomationException, withAutomationSpan } from "./telemetry";
import type { JobPageFetcher } from "./extraction";
import { AutomationReplica, AutomationControlError, type AutomationActivationPacket, type AutomationCandidate,
  type AutomationManagementInspector, type ReplicaTransport } from "./replica";
import { runRegisteredAutomation } from "./handlers";
import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identityCrypto";
import { profileFromIdentitySeedForDevice } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import type { DeviceCertificate } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import { planApplicationMove, planBoundApplicationMove } from "./applicationMove";
import { correlateApplicationSources } from "./applicationSourceMatching";
import { parseApplicationBindingProof, type ApplicationBindingProof } from "../../../src/domain/applicationBinding";
import { appendApplicationBinding, appendApplicationBindingAppliedAudit, initializeApplicationBindingStorage,
  readApplicationBinding, readApplicationBindingById } from "./applicationBindingStore";
import { applicationBindingEventHash, decryptApplicationBindingRecord, encryptApplicationBindingRecord,
  hashApplicationBindingDecision, type ApplicationBindingRecord } from "./applicationBindingEvidence";
import { verifyApplicationReviewRequest, type ApplicationReviewRequestProof, type ApplicationReviewRequestExpected } from "../../../src/domain/applicationReviewProtocol";
import { parseApplicationReviewBody, parseApplicationReviewResponse, parseApplicationReviewReceipt, parseApplicationReviewMailbox,
  type ApplicationReviewAction, type ApplicationReviewResponse, type ApplicationReviewMailbox } from "../../../src/domain/applicationReviewData";
import { automationBodyHash, parseAutomationObservationProof, type AutomationObservationProof } from "../../../src/domain/automationProtocol";
import { readApplicationEventClassification } from "./clef";
import { emptyEmployeeProfile } from "../../../src/domain/jobPriority";
import { prepareItemCommand, validateItemCommandClassification } from "./itemCommands";
import { decryptEventClassification, decryptEventPayload, encryptEventClassification, encryptEventPayload } from "./eventPayload";
import { FreshRequestLedger } from "./freshRequestLedger";
import { verifyAutomationInstanceRequest, type AutomationInstanceAction, type AutomationInstanceRequestProof } from "../../../src/domain/automationInstanceProtocol";
import { parseAutomationInstanceBody, type AutomationInstanceActivateBody, type AutomationInstanceRefreshBody,
  type AutomationInstancePrepareHistoryBody, type AutomationInstanceActivateHistoryBody, type AutomationInstancePrepareRotationBody, type AutomationInstanceRotateStorageBody } from "../../../src/domain/automationInstanceData";
import { createAutomationInstanceIdentity, verifyAutomationInstanceIdentity, type AutomationInstanceIdentityProof } from "../../../src/domain/automationInstanceIdentity";
import { resolveSigningContext } from "../../../src/domain/signingContext";
import { parseAutomationDefinition } from "../../../src/domain/automationContract";
import { verifyRustyWriterPolicyReceipt } from "../../../src/sync/rustyScopePolicy";

/** Publish a complete encrypted generation atomically; callers encrypt before entering this sync transaction. */
export function writeReplicaChunksAtomically(storage: ExecutionSqlTransactionPort, generation: string, chunks: string[], updatedAt: number,
  afterPublish?: () => void, expectedGeneration?: string | null): void {
  storage.transactionSync(() => {
    const previous = storage.sql.exec<{ state_generation: string | null }>(
      "SELECT state_generation FROM automation_replica WHERE singleton = 1",
    ).toArray()[0]?.state_generation ?? null;
    if (expectedGeneration !== undefined && previous !== expectedGeneration) throw new Error("Stored Worker replica generation changed before publication");
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
    afterPublish?.();
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
  command_hash?: string | null;
  classification_payload?: string | null;
};

type SignedReviewMailbox = Omit<ApplicationReviewMailbox, "observation"> & { observation: AutomationObservationProof };

type OwnerRegistration = { integrationId: string; workspaceId: string; ownerPersonId: string };
type ActivationResult = { ok: true; status: "active" | "paused" | "deleted"; workspaceId: string; synced: true } |
  { ok: false; status: 422 | 503; error: string; detail?: string };
type InstanceManagementResult = AutomationInstanceIdentityProof | { integrationId: string } | ActivationResult;

const maximumAttempts = 8;
const processingLeaseMs = 2 * 60_000;
const controlPollMs = 15_000;
class ApplicationBindingReviewError extends Error {}
type ParticipantProfile = Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>;
type CachedEvidence = { serialized: string; storageSecret: string; profileFingerprint: string };
type CachedReplica = CachedEvidence & { replica: AutomationReplica };
type CachedInspector = CachedEvidence & { inspector: AutomationManagementInspector };

function participantProfileFingerprint(profile: ParticipantProfile): string {
  return canonicalizeJson([profile.identity, profile.device, profile.certificate]);
}

/** Serializes durable intake, replay protection and classification for one integration. */
export class ExecutionCoordinator {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private loadedReplica?: CachedReplica;
  private loadedInspector?: CachedInspector;
  constructor(protected readonly ctx: ExecutionContextPort, protected readonly env: ExecutionEnvironment,
    private readonly adapters: ExecutionAdapters = {}) {
    configureAutomationTelemetry(env);
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
      CREATE TABLE IF NOT EXISTS automation_storage_transition (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        transition_id TEXT NOT NULL, storage_binding TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_storage_transition_completed (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        transition_id TEXT NOT NULL, storage_binding TEXT NOT NULL, target_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_history_transition (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        transition_id TEXT NOT NULL, storage_binding TEXT NOT NULL, source_heads TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_history_transition_completed (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        transition_id TEXT NOT NULL, storage_binding TEXT NOT NULL, baseline_id TEXT NOT NULL
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
        command_hash TEXT,
        classification_payload TEXT,
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
      INSERT INTO events (event_id, source, source_id, body_hash, payload, status, attempt, claimed_at, created_at, updated_at, result)
      SELECT event_id, source, source_id, body_hash, payload, status, attempt, claimed_at, created_at, updated_at, result FROM events_legacy;
      DROP TABLE events_legacy;
      CREATE INDEX events_queue ON events(status, created_at);`);
    }
    const replicaColumns = new Set(ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(automation_replica)").toArray().map(column => column.name));
    if (!replicaColumns.has("state_generation")) ctx.storage.sql.exec("ALTER TABLE automation_replica ADD COLUMN state_generation TEXT");
    const eventColumns = new Set(ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(events)").toArray().map(column => column.name));
    if (!eventColumns.has("next_attempt_at")) ctx.storage.sql.exec("ALTER TABLE events ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
    if (!eventColumns.has("command_hash")) ctx.storage.sql.exec("ALTER TABLE events ADD COLUMN command_hash TEXT");
    if (!eventColumns.has("classification_payload")) ctx.storage.sql.exec("ALTER TABLE events ADD COLUMN classification_payload TEXT");
    initializeApplicationBindingStorage(ctx.storage);
    new FreshRequestLedger(ctx.storage, "application_review_requests").initialize();
    new FreshRequestLedger(ctx.storage, "automation_instance_requests").initialize();
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

  /** Return only admitted classifier inputs; never expose the readable workspace document. */
  classificationContext(): Promise<{
    integrationId: string;
    control: "active" | "paused" | "deleted";
    definition: ReturnType<AutomationReplica["definitionForRuntime"]>;
    employeeProfile: ReturnType<AutomationReplica["employeeProfileForRuntime"]>;
    priorityBands: ReturnType<AutomationReplica["priorityBandsForRuntime"]>;
    allowedSources: { website: boolean; email: boolean };
  } | null> {
    return this.serializeMutation(async () => {
      const integrationId = this.integrationScope();
      const replica = await this.refreshReplica();
      if (!replica) return null;
      return { integrationId, control: replica.controlForRuntime().state,
        definition: replica.definitionForRuntime(), employeeProfile: replica.employeeProfileForRuntime(),
        priorityBands: replica.priorityBandsForRuntime(),
        allowedSources: { website: replica.allowsSource("website"), email: replica.allowsSource("email") } };
    });
  }

  observeOwner(registration: OwnerRegistration, nonce: string, origin: string) {
    return this.serializeMutation(async () => {
      this.assertOwnerRegistration(registration);
      const serialized = await this.loadReplicaState(this.env.EVENT_STORAGE_SECRET!);
      if (!serialized) return null;
      const profile = await this.getIdentityProfile(registration.integrationId, this.env.IDENTITY_STORAGE_SECRET!);
      const replica = await this.restoreReplica(serialized, profile, this.env.EVENT_STORAGE_SECRET!);
      return replica.signObservationForRuntime(origin, nonce);
    });
  }

  private registration() {
    return this.ctx.storage.sql.exec<{ owner_id: string; workspace_id: string; integration_id: string }>(
      "SELECT owner_id, workspace_id, integration_id FROM automation_registration WHERE singleton = 1").toArray()[0];
  }

  /** The Durable Object name is the integration scope; optional owner enrollment must agree with it. */
  private integrationScope(): string {
    const integrationId = this.ctx.id.name;
    if (!integrationId) throw new Error("Automation instance has no integration identity");
    const registration = this.registration();
    if (registration && registration.integration_id !== integrationId) {
      throw new Error("Automation registration does not match its instance identity");
    }
    return integrationId;
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
    const profile = await this.existingIdentityProfile(integrationId, encryptionSecret);
    if (!profile) throw new Error("Automation identity could not be loaded");
    return profile;
  }

  /** Management reads must not create an identity or bind an empty instance. */
  private async existingIdentityProfile(integrationId: string, encryptionSecret: string) {
    const stored = this.ctx.storage.sql.exec<{ encrypted_seed: string }>(
      "SELECT encrypted_seed FROM automation_identities WHERE integration_id = ?", integrationId,
    ).toArray()[0];
    if (!stored) return null;
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
    this.assertStorageNotFrozen();
    const profile = await this.getIdentityProfile(integrationId, identitySecret);
    if (packet.grant?.payload?.personId !== profile.identity.personId) {
      return { ok: false, status: 422, error: "Automation grant subject does not match this integration identity" };
    }
    const persist = (serialized: string) => this.saveReplicaState(storageSecret, serialized);
    const activationPacket = this.packetWithTransport(packet);
    let replica: AutomationReplica;
    try {
      const existing = await this.loadReplicaState(storageSecret);
      if (existing) {
        const state = JSON.parse(existing) as { grant: unknown; definition?: unknown; blind: AutomationActivationPacket["blind"] };
        const priorAccess = { ...state.blind, cursor: 0, lastUploaded: "" };
        const nextAccess = { ...packet.blind, cursor: 0, lastUploaded: "" };
        if (canonicalizeJson(state.grant) !== canonicalizeJson(packet.grant) ||
          canonicalizeJson(state.definition ?? null) !== canonicalizeJson(packet.definition ?? null) ||
          canonicalizeJson(priorAccess) !== canonicalizeJson(nextAccess)) {
          if (!origin || packet.version !== 2) throw new Error("Scope renewal requires a signed enrolled owner request");
          replica = await AutomationReplica.renew(existing, { ...activationPacket, persist }, profile, origin);
        } else {
          replica = await this.restoreReplica(existing, profile, storageSecret);
          if (replica.controlForRuntime().state === "deleted") throw new Error("Deleted automation cannot be reactivated");
        }
      } else replica = await AutomationReplica.activate({ ...activationPacket, persist }, profile, origin);
      if (origin) replica.observationForRuntime(origin, crypto.randomUUID());
    }
    catch (error) {
      recordAutomationException(error, { event: "automation.activation.proof_validation_failed", operation: "activation-proof-validation", integrationId });
      return { ok: false, status: 422, error: error instanceof Error ? error.message : "Activation proof validation failed" };
    }
    await persist(replica.serialize());
    await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
    try { await replica.sync(); }
    catch (error) {
      recordAutomationException(error, { event: "automation.activation.replication_failed", operation: "activation-replication", workspaceId: packet.workspaceId });
      return { ok: false, status: 503, error: "Activation is stored but the encrypted snapshot did not sync; retry activation",
        detail: error instanceof Error ? error.message : "Rusty synchronization failed" };
    }
    await persist(replica.serialize());
    return { ok: true, status: replica.controlForRuntime().state, workspaceId: packet.workspaceId, synced: true };
  }

  async saveReplicaState(secret: string, serialized: string): Promise<void> {
    await this.persistReplicaState(secret, serialized);
  }

  private async persistReplicaState(secret: string, serialized: string, beforeCommit?: () => Promise<void>, afterPublish?: () => void,
    expectedGeneration?: string | null, source?: CachedReplica | CachedInspector): Promise<void> {
    // A failed write must not leave a mutated in-memory replica reusable under old durable evidence.
    if (!source || this.loadedReplica === source) this.loadedReplica = undefined;
    if (!source || this.loadedInspector === source) this.loadedInspector = undefined;
    const encrypted = await encryptReplicaValue(secret, this.ctx.id.name ?? "", "state", serialized);
    const generation = crypto.randomUUID();
    const chunkSize = 900_000;
    const chunks = Array.from({ length: Math.ceil(encrypted.length / chunkSize) }, (_, index) => encrypted.slice(index * chunkSize, (index + 1) * chunkSize));
    await beforeCommit?.();
    writeReplicaChunksAtomically(this.ctx.storage, generation, chunks, Date.now(), afterPublish, expectedGeneration);
    // Only the already admitted instance that produced these bytes can advance its cache after commit.
    if (source) {
      source.serialized = serialized;
      if ("replica" in source) this.loadedReplica = source;
      else this.loadedInspector = source;
    }
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

  /** Accept one authenticated producer result without opening the board or invoking classification. */
  enqueueItemCommand(value: unknown): Promise<EnqueueResult> {
    return this.serializeMutation(async () => {
      const command = await prepareItemCommand(value, this.integrationScope());
      const secret = this.env.EVENT_STORAGE_SECRET;
      if (!secret) throw new Error("Event storage encryption is not configured");
      const encryptedEvent = await encryptEventPayload(secret, command.eventId, command.event);
      const encryptedClassification = await encryptEventClassification(secret, command.eventId, command.classification);
      const existing = this.findById(command.eventId) ?? this.ctx.storage.sql.exec<EventRow>(
        "SELECT * FROM events WHERE source = ? AND source_id = ?", command.source, command.sourceId,
      ).toArray()[0];
      if (existing) {
        if (existing.command_hash) {
          if (existing.source !== command.source || existing.source_id !== command.sourceId || existing.command_hash !== command.bodyHash) {
            return { error: "idempotency-conflict" };
          }
          return { eventId: existing.event_id, status: existing.status, duplicate: true };
        }
        // Upgrade an already durable intake row in place, but only when its authenticated body digest
        // and decrypted normalized event still match the producer's original source event.
        if (existing.event_id !== command.eventId || existing.source !== command.source ||
          existing.body_hash !== command.idempotencyKey) return { error: "idempotency-conflict" };
        const storedEvent = await decryptEventPayload(secret, existing.event_id, existing.payload);
        if (canonicalizeJson(storedEvent) !== canonicalizeJson(command.event)) return { error: "idempotency-conflict" };
        this.ctx.storage.sql.exec(
          "UPDATE events SET command_hash = ?, classification_payload = ? WHERE event_id = ? AND command_hash IS NULL",
          command.bodyHash, encryptedClassification, existing.event_id,
        );
        await this.scheduleEarlierAlarm(Date.now() + 1_000);
        return { eventId: existing.event_id, status: existing.status, duplicate: true };
      }
      const now = Date.now();
      this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec(
        `INSERT INTO events (event_id, source, source_id, body_hash, command_hash, payload, classification_payload,
          status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        command.eventId, command.source, command.sourceId, command.idempotencyKey, command.bodyHash,
        encryptedEvent, encryptedClassification, now, now,
      ));
      await this.scheduleEarlierAlarm(now + 1_000);
      return { eventId: command.eventId, status: "pending", duplicate: false };
    });
  }

  getItemCommandResult(commandId: string, integrationId: string) {
    try { if (this.integrationScope() !== integrationId) return null; }
    catch { return null; }
    if (!this.findById(commandId)?.command_hash) return null;
    const command = this.getEvent(commandId);
    return command ? { ...command, commandId: command.eventId } : null;
  }

  retryEmail(owner: OwnerRegistration, eventId: string): Promise<EnqueueSuccess> {
    return this.serializeMutation(async () => {
      this.assertOwnerRegistration(owner);
      return this.retryEmailNow(eventId);
    });
  }

  private async retryEmailNow(eventId: string, guard?: () => Promise<void>): Promise<EnqueueSuccess> {
    const row = this.findById(eventId);
    if (!row || row.source !== "email") throw new Error("Saved email event was not found");
    if (readApplicationBinding(this.ctx.storage, eventId)) throw new Error("Bound email requires its signed application-binding retry");
    await guard?.();
    if (row.status === "applied" || row.status === "processing" || row.status === "pending") {
      return { eventId, status: row.status, duplicate: true };
    }
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE events SET status = 'pending', attempt = 0, claimed_at = NULL, next_attempt_at = ?, updated_at = ? WHERE event_id = ?", now, now, eventId);
    await this.scheduleEarlierAlarm(now + 1_000);
    return { eventId, status: "pending", duplicate: false };
  }

  /** Persist explicit owner intent without scheduling an action. Public callers also require fresh owner-request authorization. */
  bindEmailApplication(value: ApplicationBindingProof, origin: string): Promise<{ bindingId: string; duplicate: boolean }> {
    const proof = parseApplicationBindingProof(value);
    return this.serializeMutation(() => this.bindEmailApplicationNow(proof, origin));
  }

  private async bindEmailApplicationNow(proof: ApplicationBindingProof, origin: string, guard?: () => Promise<void>) {
      const p = proof.signed.payload;
      this.assertBindingRoute(proof, origin);
      const row = this.findById(p.eventId);
      if (!row || row.source !== "email") throw new Error("Saved email event was not found");
      const replica = await this.refreshReplica();
      if (!replica) throw new Error("No admitted workspace is available to bind this email");
      const proofHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(proof)));
      const previous = readApplicationBindingById(this.ctx.storage, p.bindingId);
      if (previous) {
        await replica.verifyApplicationBindingOwnerForRuntime(proof);
        if (previous.eventId !== p.eventId || previous.previousBindingId !== p.previousBindingId || previous.proofHash !== proofHash) {
          throw new Error("Application binding ID was already used for different evidence");
        }
        if (readApplicationBinding(this.ctx.storage, p.eventId)?.bindingId !== p.bindingId) {
          throw new Error("Application binding was superseded; reload its current selection");
        }
        return { bindingId: p.bindingId, duplicate: true };
      }
      if (p.issuedAt > Date.now() + 5_000 || Date.now() - p.issuedAt > 60_000) throw new Error("New application binding signature is stale");
      if (row.status !== "review" && row.status !== "failed") throw new Error("Only retained emails needing review can receive a new binding");
      if (replica.controlForRuntime().state === "deleted") throw new Error("Deleted automation cannot receive a new binding");
      const retained = row.result ? JSON.parse(row.result) as { decision?: unknown } : null;
      const { decision, decisionHash } = await hashApplicationBindingDecision(retained?.decision);
      const event = await decryptEventPayload(this.env.EVENT_STORAGE_SECRET!, row.event_id, row.payload);
      if (event.source !== "email") throw new Error("Application binding requires retained email evidence");
      const eventHash = await applicationBindingEventHash(p.integrationId, p.workspaceId,
        { eventId: row.event_id, sourceId: row.source_id, bodyHash: row.body_hash }, event);
      await replica.verifyApplicationBindingForRuntime(proof, { origin, integrationId: p.integrationId, eventId: row.event_id, eventHash, decisionHash });
      const encryptedRecord = await encryptApplicationBindingRecord(this.env.EVENT_STORAGE_SECRET!,
        { integrationId: p.integrationId, eventId: p.eventId, bindingId: p.bindingId }, { proof, decision });
      await replica.verifyApplicationBindingForRuntime(proof, { origin, integrationId: p.integrationId, eventId: row.event_id, eventHash, decisionHash });
      if (Date.now() - p.issuedAt > 60_000) throw new Error("New application binding signature expired before persistence");
      await guard?.();
      const result = await appendApplicationBinding(this.ctx.storage, { bindingId: p.bindingId, eventId: p.eventId,
        previousBindingId: p.previousBindingId, proofHash, encryptedRecord, createdAt: Date.now() });
      return { bindingId: p.bindingId, ...result };
  }

  /** Retry exactly the stored current binding; this never changes classification or silently selects another card. */
  retryBoundEmailApplication(value: ApplicationBindingProof, origin: string): Promise<EnqueueSuccess> {
    const proof = parseApplicationBindingProof(value);
    return this.serializeMutation(() => this.retryBoundEmailApplicationNow(proof, origin));
  }

  private async retryBoundEmailApplicationNow(proof: ApplicationBindingProof, origin: string, guard?: () => Promise<void>): Promise<EnqueueSuccess> {
      this.assertBindingRoute(proof, origin);
      const p = proof.signed.payload;
      const row = this.findById(p.eventId);
      const head = readApplicationBinding(this.ctx.storage, p.eventId);
      if (!row || row.source !== "email" || head?.bindingId !== p.bindingId ||
        head.proofHash !== await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(proof)))) {
        throw new Error("Application binding changed; reload before retrying");
      }
      const replica = await this.refreshReplica();
      if (!replica) throw new Error("No admitted workspace is available to retry this email");
      await replica.verifyApplicationBindingOwnerForRuntime(proof);
      if (row.status === "applied") return { eventId: row.event_id, status: row.status, duplicate: true };
      const event = await decryptEventPayload(this.env.EVENT_STORAGE_SECRET!, row.event_id, row.payload);
      if (event.source !== "email") throw new Error("Application binding requires retained email evidence");
      await this.boundEmailEvidence(row, event, replica);
      if (replica.controlForRuntime().state === "deleted") throw new Error("Deleted automation cannot retry a binding");
      const duplicate = row.status === "pending" || row.status === "processing";
      await guard?.();
      const now = Date.now();
      if (!duplicate) this.ctx.storage.sql.exec("UPDATE events SET status = 'pending', attempt = 0, claimed_at = NULL, next_attempt_at = ?, updated_at = ? WHERE event_id = ?", now, now, row.event_id);
      await this.scheduleEarlierAlarm(now + 1_000);
      return { eventId: row.event_id, status: duplicate ? row.status : "pending", duplicate };
  }

  /** Existing-instance management never provisions a replacement executor or relies on bootstrap allowlists. */
  manageInstance(value: AutomationInstanceRequestProof, action: AutomationInstanceAction, bodyValue: unknown, origin: string): Promise<InstanceManagementResult | null> {
    const proof = structuredClone(value);
    const rawBody = structuredClone(bodyValue);
    const body = parseAutomationInstanceBody(action, rawBody);
    const operation = this.serializeMutation(() => withAutomationSpan(automationTelemetry(), "automation.instance.manage", {
      "integration.id": this.ctx.id.name ?? "unknown", "automation.action": action,
    }, async () => {
      const expected = { action, origin, workspaceId: body.workspaceId, definitionId: body.definitionId,
        integrationId: "integrationId" in body ? body.integrationId : null, executorPersonId: body.executorPersonId,
        bodyHash: await automationBodyHash(rawBody) };
      const payload = await verifyAutomationInstanceRequest(proof, expected);
      if (action !== "discover" && expected.integrationId !== this.ctx.id.name) throw new Error("Instance request targets another integration");
      const existing = await this.managementInspectorNow();
      if (!existing) return null;
      const { profile } = existing;
      let inspector = existing.inspector;
      if (profile.identity.personId !== body.executorPersonId) {
        if (action === "discover") return null;
        throw new Error("Existing executor identity does not match the requested instance");
      }
      const owner = { personId: payload.personId, publicKey: proof.publicKey, certificates: proof.certificates };
      const guard = async () => {
        await verifyAutomationInstanceRequest(proof, expected);
        inspector.assertOwner(owner, payload.deviceId);
      };
      try {
        await guard();
        inspector.describe(origin, body.workspaceId, body.definitionId);
      } catch (error) {
        if (action === "discover" && error instanceof Error && /currently authorized owner|definition does not match/.test(error.message)) return null;
        throw error;
      }
      const frozen = this.storageTransition();
      const rotationAction = action === "prepare-storage-rotation" || action === "rotate-storage";
      const historyAction = action === "prepare-history-baseline" || action === "activate-history-baseline";
      const historyFrozen = this.historyTransition();
      if (historyFrozen && !historyAction && action !== "identity" && action !== "discover") throw new Error("History transition is frozen; resume that transition first");
      if (frozen && historyAction) throw new Error("Resume storage credential transition before history maintenance");
      if (historyFrozen && rotationAction) throw new Error("Resume history transition before storage credential maintenance");
      if (frozen && !rotationAction && action !== "identity" && action !== "discover") throw new Error("Storage credential transition is frozen; resume that transition first");
      if (!frozen && !historyFrozen && !historyAction) await inspector.pull(guard);
      await guard();
      inspector.describe(origin, body.workspaceId, body.definitionId);
      if (action === "discover") return { integrationId: this.ctx.id.name! };

      const ledger = new FreshRequestLedger(this.ctx.storage, "automation_instance_requests");
      const requestHash = await automationBodyHash(proof);
      const cached = ledger.read(payload.nonce, requestHash);
      if (cached) {
        const response: unknown = JSON.parse(await decryptReplicaValue(this.env.EVENT_STORAGE_SECRET!, this.ctx.id.name!, `instance-response:${payload.nonce}`, cached));
        await guard();
        if (action === "identity" || action === "refresh-access" || rotationAction || historyAction) {
          await verifyAutomationInstanceIdentity(response, { origin, workspaceId: body.workspaceId, definitionId: body.definitionId,
            integrationId: this.ctx.id.name!, executorPersonId: body.executorPersonId, requestNonce: payload.nonce });
          return response as AutomationInstanceIdentityProof;
        }
        return response as ActivationResult;
      }
      ledger.claim(payload.nonce, requestHash, payload.expiresAt);
      let response: AutomationInstanceIdentityProof | ActivationResult;
      const publishGuard = async (serialized: string) => {
        await guard();
        const candidate = await AutomationReplica.inspectForManagement(serialized, profile, async () => {});
        candidate.assertOwner(owner, payload.deviceId);
        await verifyAutomationInstanceRequest(proof, expected);
      };
      if (action === "refresh-access" && "receipt" in body && !("credentials" in body)) {
        inspector = await this.refreshManagedInstanceAccess(inspector.serialize(), profile, body, payload.personId, guard, publishGuard);
        await guard();
      }
      if (action === "prepare-storage-rotation" && "transitionId" in body && !("credentials" in body)) {
        inspector = await this.prepareManagedStorageRotation(inspector, body, guard);
        await guard();
      }
      if (action === "rotate-storage" && "credentials" in body) {
        inspector = await this.rotateManagedStorage(inspector, profile, body, payload.personId, guard, publishGuard, next => { inspector = next; });
        await guard();
      }
      if (action === "prepare-history-baseline" && "scopeAuthoritySnapshot" in body) {
        inspector = await this.prepareManagedHistory(inspector, body, guard);
        await guard();
      }
      if (action === "activate-history-baseline" && "baselineId" in body) {
        inspector = await this.activateManagedHistory(inspector, profile, body, guard, publishGuard, next => { inspector = next; });
        await guard();
      }
      if (action === "identity" || action === "refresh-access" || rotationAction || historyAction) {
        const context = await resolveSigningContext({ profile, certificates: [profile.certificate],
          purpose: "automation-instance-identity", authorityRevision: requestHash, expiresAt: payload.expiresAt,
          binding: { origin, workspaceId: body.workspaceId, definitionId: body.definitionId, integrationId: this.ctx.id.name!, requestNonce: payload.nonce },
          current: async () => {
            await guard();
            return { personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: requestHash };
          } });
        response = await createAutomationInstanceIdentity(context, { origin, workspaceId: body.workspaceId,
          definitionId: body.definitionId, integrationId: this.ctx.id.name!, requestNonce: payload.nonce,
          description: { ...inspector.describe(origin, body.workspaceId, body.definitionId),
            ...(inspector.historyBaselineId() ? { historyBaselineId: inspector.historyBaselineId() } : {}),
            ...(this.historyTransition() ? { historyTransition: { transitionId: this.historyTransition()!.transition_id,
              state: "frozen" as const, sourceHeads: JSON.parse(this.historyTransition()!.source_heads) as string[] } } : {}),
            ...(this.storageTransition() ? { storageTransition: { transitionId: this.storageTransition()!.transition_id, state: "frozen" as const } } : {}) } });
      } else if ("packet" in body) {
        response = await this.activateManagedInstanceNow(inspector.serialize(), profile, body, origin,
          guard, publishGuard, next => { inspector = next; });
      } else throw new TypeError("Instance action does not match its body");
      const encrypted = await encryptReplicaValue(this.env.EVENT_STORAGE_SECRET!, this.ctx.id.name!, `instance-response:${payload.nonce}`, JSON.stringify(response));
      await guard();
      ledger.complete(payload.nonce, requestHash, encrypted);
      return response;
    }));
    flushAutomationTelemetryAfter(this.ctx, operation);
    return operation;
  }

  private historyTransition(): { transition_id: string; storage_binding: string; source_heads: string } | undefined {
    return this.ctx.storage.sql.exec<{ transition_id: string; storage_binding: string; source_heads: string }>(
      "SELECT transition_id, storage_binding, source_heads FROM automation_history_transition WHERE singleton = 1").toArray()[0];
  }

  private historyStorageBinding(inspector: AutomationManagementInspector, storage: AutomationInstancePrepareHistoryBody["storage"]): string {
    const { blind } = JSON.parse(inspector.serialize()) as { blind: AutomationActivationPacket["blind"] };
    const binding = canonicalizeJson({ origin: blind.origin, scopeId: blind.scopeId, keyEpoch: blind.keyEpoch, servicePublicKey: blind.servicePublicKey });
    if (binding !== canonicalizeJson(storage)) throw new Error("History maintenance targets another pinned storage scope");
    return binding;
  }

  private async prepareManagedHistory(inspector: AutomationManagementInspector, body: AutomationInstancePrepareHistoryBody,
    guard: () => Promise<void>): Promise<AutomationManagementInspector> {
    const binding = this.historyStorageBinding(inspector, body.storage), frozen = this.historyTransition();
    if (frozen) {
      if (frozen.transition_id !== body.transitionId || frozen.storage_binding !== binding) throw new Error("Another history transition is pending");
      await guard(); return inspector;
    }
    const completed = this.ctx.storage.sql.exec<{ transition_id: string }>(
      "SELECT transition_id FROM automation_history_transition_completed WHERE singleton = 1").toArray()[0];
    if (completed?.transition_id === body.transitionId) throw new Error("History transition already completed; use its exact activation acknowledgement");
    const heads = await inspector.prepareHistory(body.scopeAuthoritySnapshot, guard);
    await guard();
    this.ctx.storage.sql.exec("INSERT INTO automation_history_transition (singleton, transition_id, storage_binding, source_heads) VALUES (1, ?, ?, ?)",
      body.transitionId, binding, JSON.stringify(heads));
    this.loadedReplica = undefined;
    this.loadedInspector = undefined;
    return inspector;
  }

  private async activateManagedHistory(inspector: AutomationManagementInspector,
    profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>, body: AutomationInstanceActivateHistoryBody,
    guard: () => Promise<void>, publishGuard: (next: string) => Promise<void>,
    observe: (next: AutomationManagementInspector) => void): Promise<AutomationManagementInspector> {
    const binding = this.historyStorageBinding(inspector, body.storage), frozen = this.historyTransition();
    if (!frozen) {
      const completed = this.ctx.storage.sql.exec<{ transition_id: string; storage_binding: string; baseline_id: string }>(
        "SELECT transition_id, storage_binding, baseline_id FROM automation_history_transition_completed WHERE singleton = 1").toArray()[0];
      if (completed?.transition_id !== body.transitionId || completed.storage_binding !== binding || completed.baseline_id !== body.baselineId ||
        inspector.historyBaselineId() !== body.baselineId) throw new Error("History activation requires its exact prepared transition");
      await guard(); return inspector;
    }
    if (frozen.transition_id !== body.transitionId || frozen.storage_binding !== binding) throw new Error("History activation requires its exact prepared transition");
    const original = inspector.serialize(), secret = this.env.EVENT_STORAGE_SECRET!;
    const generation = this.ctx.storage.sql.exec<{ state_generation: string | null }>(
      "SELECT state_generation FROM automation_replica WHERE singleton = 1").one().state_generation;
    let candidateBytes = original;
    let candidate = await AutomationReplica.inspectForManagement(original, profile, async value => { candidateBytes = value; });
    observe(candidate);
    await candidate.drainPending(guard);
    await candidate.pull(guard);
    await candidate.verifyHistory(body.baselineId, JSON.parse(frozen.source_heads) as string[], guard);
    candidateBytes = candidate.serialize();
    await publishGuard(candidateBytes); await guard();
    if (await this.loadReplicaState(secret) !== original) throw new Error("Stored Worker source changed during history activation");
    await this.persistReplicaState(secret, candidateBytes, async () => { await publishGuard(candidateBytes); await guard(); }, () => {
      const current = this.historyTransition();
      if (current?.transition_id !== body.transitionId || current.storage_binding !== frozen.storage_binding || current.source_heads !== frozen.source_heads) throw new Error("History freeze changed before activation");
      this.ctx.storage.sql.exec(`INSERT INTO automation_history_transition_completed (singleton, transition_id, storage_binding, baseline_id)
        VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET transition_id = excluded.transition_id,
        storage_binding = excluded.storage_binding, baseline_id = excluded.baseline_id`, body.transitionId, binding, body.baselineId);
      this.ctx.storage.sql.exec("DELETE FROM automation_history_transition WHERE singleton = 1");
    }, generation);
    this.loadedReplica = undefined;
    this.loadedInspector = undefined;
    candidate = await AutomationReplica.inspectForManagement(candidateBytes, profile, value => this.saveReplicaState(secret, value));
    observe(candidate);
    await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
    return candidate;
  }

  private storageTransition(): { transition_id: string; storage_binding: string } | undefined {
    return this.ctx.storage.sql.exec<{ transition_id: string; storage_binding: string }>(
      "SELECT transition_id, storage_binding FROM automation_storage_transition WHERE singleton = 1").toArray()[0];
  }

  private assertStorageNotFrozen(): void {
    if (this.historyTransition()) throw new Error("History transition is frozen; queued events stay available");
    if (this.storageTransition()) throw new Error("Storage credential transition is frozen; queued events stay available");
  }

  private async prepareManagedStorageRotation(inspector: AutomationManagementInspector, body: AutomationInstancePrepareRotationBody,
    guard: () => Promise<void>): Promise<AutomationManagementInspector> {
    const prior = JSON.parse(inspector.serialize()) as { blind: AutomationActivationPacket["blind"] };
    const binding = canonicalizeJson({ origin: prior.blind.origin, scopeId: prior.blind.scopeId,
      keyEpoch: prior.blind.keyEpoch, servicePublicKey: prior.blind.servicePublicKey });
    if (binding !== canonicalizeJson(body.storage)) throw new Error("Storage rotation targets another Rusty scope or epoch");
    const frozen = this.storageTransition();
    if (frozen) {
      if (frozen.transition_id !== body.transitionId || frozen.storage_binding !== binding) throw new Error("Another storage credential transition is pending");
      await guard();
      return inspector;
    }
    await inspector.drainPending(guard);
    await guard();
    this.ctx.storage.sql.exec("INSERT INTO automation_storage_transition (singleton, transition_id, storage_binding) VALUES (1, ?, ?)",
      body.transitionId, binding);
    this.loadedReplica = undefined;
    this.loadedInspector = undefined;
    // All execution and management share mutationQueue; no event can enter between the drain and durable freeze.
    return inspector;
  }

  private async rotateManagedStorage(inspector: AutomationManagementInspector,
    profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>, body: AutomationInstanceRotateStorageBody,
    ownerPersonId: string, guard: () => Promise<void>, publishGuard: (next: string) => Promise<void>,
    observeInspector: (next: AutomationManagementInspector) => void): Promise<AutomationManagementInspector> {
    const next = body.credentials;
    if (next.workspaceId !== body.workspaceId || next.origin !== body.storage.origin || next.scopeId !== body.storage.scopeId ||
      next.servicePublicKey !== body.storage.servicePublicKey || next.keyEpoch <= body.storage.keyEpoch) throw new Error("Replacement storage changed scope, service or epoch");
    const receipt = await verifyRustyWriterPolicyReceipt(body.receipt, next, ownerPersonId, next.policyRevision);
    if (receipt.payload.revision !== next.policyRevision) throw new Error("Replacement storage policy differs from its confirmation");
    await guard();
    const targetHash = async (blind: AutomationActivationPacket["blind"]) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson([
      blind.workspaceId, blind.origin, blind.scopeId, blind.servicePublicKey, blind.policyRevision, blind.keyEpoch,
      blind.contentKey, blind.historicalContentKeys ?? null, blind.historicalContentKeyVariants ?? null,
      blind.readToken, blind.writeToken, blind.minimumWriterVersion ?? null,
    ])));
    const requestedTarget = await targetHash(next);
    const frozen = this.storageTransition();
    if (!frozen) {
      const completed = this.ctx.storage.sql.exec<{ transition_id: string; storage_binding: string; target_hash: string }>(
        "SELECT transition_id, storage_binding, target_hash FROM automation_storage_transition_completed WHERE singleton = 1").toArray()[0];
      const current = JSON.parse(inspector.serialize()) as { blind: AutomationActivationPacket["blind"] };
      if (completed?.transition_id !== body.transitionId || completed.storage_binding !== canonicalizeJson(body.storage) ||
        completed.target_hash !== requestedTarget || await targetHash(current.blind) !== requestedTarget) {
        throw new Error("Storage rotation requires its exact durable prepared transition");
      }
      await guard();
      return inspector;
    }
    if (frozen.transition_id !== body.transitionId || frozen.storage_binding !== canonicalizeJson(body.storage)) {
      throw new Error("Storage rotation requires its exact durable prepared transition");
    }
    const original = inspector.serialize();
    const secret = this.env.EVENT_STORAGE_SECRET!;
    const generation = this.ctx.storage.sql.exec<{ state_generation: string | null }>(
      "SELECT state_generation FROM automation_replica WHERE singleton = 1").one().state_generation;
    let candidateBytes: string | undefined;
    let candidate = await inspector.rotateStorageCredentials(next,
      async value => { candidateBytes = value; }, guard);
    observeInspector(candidate);
    // Reacquire current admitted Owner/control with the new access. Never depend on invalidated old tokens.
    await candidate.pull(guard);
    candidateBytes = candidate.serialize();
    await publishGuard(candidateBytes);
    await guard();
    if (await this.loadReplicaState(secret) !== original) throw new Error("Stored Worker replica changed during credential rotation");
    const beforeCommit = async () => { await publishGuard(candidateBytes!); await guard(); };
    await this.persistReplicaState(secret, candidateBytes, beforeCommit, () => {
      const current = this.storageTransition();
      if (current?.transition_id !== body.transitionId || current.storage_binding !== frozen.storage_binding) throw new Error("Storage transition changed before publication");
      this.ctx.storage.sql.exec(`INSERT INTO automation_storage_transition_completed (singleton, transition_id, storage_binding, target_hash)
        VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET transition_id = excluded.transition_id,
        storage_binding = excluded.storage_binding, target_hash = excluded.target_hash`, body.transitionId, frozen.storage_binding, requestedTarget);
      this.ctx.storage.sql.exec("DELETE FROM automation_storage_transition WHERE singleton = 1");
    }, generation);
    this.loadedReplica = undefined;
    this.loadedInspector = undefined;
    candidate = await AutomationReplica.inspectForManagement(candidateBytes, profile, value => this.saveReplicaState(secret, value));
    observeInspector(candidate);
    await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
    return candidate;
  }

  private async refreshManagedInstanceAccess(serialized: string, profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>,
    body: AutomationInstanceRefreshBody, owner: string, guard: () => Promise<void>, publishGuard: (next: string) => Promise<void>): Promise<AutomationManagementInspector> {
    const prior = JSON.parse(serialized) as { blind: AutomationActivationPacket["blind"] };
    const storage = { origin: prior.blind.origin, scopeId: prior.blind.scopeId, keyEpoch: prior.blind.keyEpoch,
      servicePublicKey: prior.blind.servicePublicKey };
    if (canonicalizeJson(storage) !== canonicalizeJson(body.storage)) throw new Error("Storage maintenance targets another Rusty scope or key");
    const receipt = await verifyRustyWriterPolicyReceipt(body.receipt, storage, owner, prior.blind.policyRevision);
    await guard();
    const secret = this.env.EVENT_STORAGE_SECRET!;
    const original = await this.loadReplicaState(secret);
    const generation = this.ctx.storage.sql.exec<{ state_generation: string | null }>(
      "SELECT state_generation FROM automation_replica WHERE singleton = 1").one().state_generation;
    const persist = async (next: string) => {
      const beforeCommit = async () => {
        await publishGuard(next);
        if (await this.loadReplicaState(secret) !== original) throw new Error("Stored Worker replica changed during access maintenance");
      };
      await this.persistReplicaState(secret, next, beforeCommit, undefined, generation);
    };
    return AutomationReplica.refreshStoragePolicy(serialized, profile, receipt.payload.revision, persist, guard);
  }

  private async managementInspectorNow(): Promise<{ profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>; inspector: AutomationManagementInspector } | null> {
    if (!this.ctx.storage.sql.exec("SELECT singleton FROM automation_replica WHERE singleton = 1").toArray().length) return null;
    if (!this.env.EVENT_STORAGE_SECRET || !this.env.IDENTITY_STORAGE_SECRET) throw new Error("Automation storage is not configured");
    const storageSecret = this.env.EVENT_STORAGE_SECRET;
    const serialized = await this.loadReplicaState(storageSecret);
    if (!serialized) return null;
    const profile = await this.existingIdentityProfile(this.ctx.id.name!, this.env.IDENTITY_STORAGE_SECRET);
    if (!profile) throw new Error("Stored replica has no existing executor identity");
    const profileFingerprint = participantProfileFingerprint(profile);
    const active = this.loadedReplica;
    if (active?.serialized === serialized && active.storageSecret === storageSecret &&
      active.profileFingerprint === profileFingerprint) return { profile, inspector: active.replica.managementInspector() };
    const cached = this.loadedInspector;
    if (cached?.serialized === serialized && cached.storageSecret === storageSecret &&
      cached.profileFingerprint === profileFingerprint) return { profile, inspector: cached.inspector };
    this.loadedInspector = undefined;
    let owned: CachedInspector | undefined;
    const inspector = await AutomationReplica.inspectForManagement(serialized, profile,
      value => this.persistReplicaState(storageSecret, value, undefined, undefined, undefined, owned),
      this.replicaTransport());
    owned = { serialized, storageSecret, profileFingerprint, inspector };
    this.loadedInspector = owned;
    return { profile, inspector };
  }

  private async activateManagedInstanceNow(serialized: string, profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>,
    body: AutomationInstanceActivateBody, origin: string, guard: () => Promise<void>,
    publishGuard: (serialized: string) => Promise<void>, observeInspector: (inspector: AutomationManagementInspector) => void): Promise<ActivationResult> {
    const packet = body.packet as AutomationActivationPacket;
    const definition = parseAutomationDefinition(packet?.definition?.payload);
    if (packet.version !== 2 || packet.workspaceId !== body.workspaceId || definition.id !== body.definitionId ||
      packet.grant?.payload?.personId !== body.executorPersonId) throw new Error("Activation differs from this existing executor and definition");
    const storageSecret = this.env.EVENT_STORAGE_SECRET!;
    const prior = await AutomationReplica.inspectForManagement(serialized, profile, async () => {});
    const description = prior.describe(origin, body.workspaceId, body.definitionId);
    if (description.state === "deleted") throw new Error("Deleted automation cannot be renewed or adopted");
    if (description.adoptionRequired !== body.adoptLegacy) throw new Error("Confirm approval before connecting this existing Worker");
    const configured = await this.getRegisteredIntegration() ?? parseIntegrations(this.env).find(value => value.id === body.integrationId);
    const routing: AutomationIntegration = { ...(configured ?? { allowedForwarders: [] }), id: body.integrationId,
      workspaceId: body.workspaceId, scope: { version: 1, ...packet.bindings,
        expiresAt: new Date(packet.grant.payload.automation!.expiresAt).toISOString() } };
    const persist = async (next: string) => {
      await publishGuard(next);
      const ownerPersonId = JSON.parse(next).authority.currentOwner.personId as string;
      await this.persistReplicaState(storageSecret, next, () => publishGuard(next), () => {
        this.ctx.storage.sql.exec(`INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id, routing)
          VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id,
          workspace_id = excluded.workspace_id, integration_id = excluded.integration_id, routing = excluded.routing`,
        ownerPersonId, body.workspaceId, body.integrationId, JSON.stringify(routing));
      });
    };
    await guard();
    const activationPacket = this.packetWithTransport(packet);
    const replica = body.adoptLegacy
      ? await AutomationReplica.adoptLegacy(serialized, { ...activationPacket, persist }, profile, origin)
      : await AutomationReplica.renew(serialized, { ...activationPacket, persist }, profile, origin);
    observeInspector(await AutomationReplica.inspectForManagement(replica.serialize(), profile, value => this.saveReplicaState(storageSecret, value)));
    await guard();
    await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
    try { await replica.sync(); }
    catch {
      return { ok: false, status: 503, error: "Approval saved; Rusty has not confirmed synchronization. Retry this instance." };
    }
    observeInspector(await AutomationReplica.inspectForManagement(replica.serialize(), profile, value => this.saveReplicaState(storageSecret, value)));
    await guard();
    return { ok: true, status: replica.controlForRuntime().state, workspaceId: body.workspaceId, synced: true };
  }

  /** Authenticated HTTP requests enter the same serialized queue as activation, controls and event processing. */
  applicationReview(value: ApplicationReviewRequestProof, action: ApplicationReviewAction, bodyValue: unknown, origin: string):
    Promise<ApplicationReviewResponse | SignedReviewMailbox | { integrationId: string; personId: string } | { bindingId: string; duplicate: boolean } | EnqueueSuccess | null> {
    const proof = structuredClone(value);
    const rawBody = structuredClone(bodyValue);
    const body = parseApplicationReviewBody(action, rawBody);
    return this.serializeMutation(async () => {
      const integrationId = "integrationId" in body ? body.integrationId : null;
      const expected: ApplicationReviewRequestExpected = { action, origin, workspaceId: body.workspaceId,
        definitionId: body.definitionId, integrationId, bodyHash: await automationBodyHash(rawBody) };
      const payload = await verifyApplicationReviewRequest(proof, expected);
      if (action !== "discover" && integrationId !== this.ctx.id.name) throw new Error("Application review targets a different integration");
      const replica = await this.refreshReplica();
      if (!replica) {
        if (action === "discover") return null;
        throw new Error("No admitted workspace is available for application review");
      }
      const guard = async () => {
        await verifyApplicationReviewRequest(proof, expected);
        replica.assertOwnerDeviceForRuntime({ personId: payload.personId, publicKey: proof.publicKey, certificates: proof.certificates }, payload.deviceId);
        if (payload.expiresAt <= Date.now()) throw new Error("Application review request expired before persistence");
      };
      await guard();
      const identity = replica.reviewIdentityForRuntime(origin, body.workspaceId, body.definitionId);
      if (!identity) {
        if (action === "discover") return null;
        throw new Error("Signed automation definition does not match application review");
      }
      if (action === "discover") return { integrationId: this.ctx.id.name!, personId: identity.personId };

      const ledger = new FreshRequestLedger(this.ctx.storage, "application_review_requests");
      const requestHash = await automationBodyHash(proof);
      const cachedResponse = ledger.read(payload.nonce, requestHash);
      if (cachedResponse) {
        const cached: unknown = JSON.parse(await decryptReplicaValue(this.env.EVENT_STORAGE_SECRET!,
          this.ctx.id.name!, `review-response:${payload.nonce}`, cachedResponse));
        if (action === "list") return this.parseSignedReviewMailbox(cached);
        return action === "review" ? parseApplicationReviewResponse(cached) : parseApplicationReviewReceipt(action === "retry-unbound" ? "retry" : action, cached);
      }
      ledger.claim(payload.nonce, requestHash, payload.expiresAt);
      let response: ApplicationReviewResponse | SignedReviewMailbox | { bindingId: string; duplicate: boolean } | EnqueueSuccess;
      if (action === "list") response = await this.readApplicationReviewMailboxNow(replica, origin, body.workspaceId, body.definitionId, payload.nonce);
      else if (action === "review" && "eventId" in body && "offset" in body) response = await this.readApplicationReviewNow(replica, body.eventId, body.offset, origin, body.workspaceId, body.definitionId);
      else if (action === "retry-unbound" && "eventId" in body) response = await this.retryEmailNow(body.eventId, guard);
      else if ("proof" in body) {
        const binding = body.proof.signed.payload;
        if (binding.personId !== payload.personId || binding.workspaceId !== body.workspaceId || binding.definitionId !== body.definitionId || binding.integrationId !== integrationId) {
          throw new Error("Application binding does not match its fresh owner request");
        }
        response = action === "bind" ? await this.bindEmailApplicationNow(body.proof, origin, guard)
          : await this.retryBoundEmailApplicationNow(body.proof, origin, guard);
      } else throw new TypeError("Application review body does not match its action");
      const encrypted = await encryptReplicaValue(this.env.EVENT_STORAGE_SECRET!, this.ctx.id.name!,
        `review-response:${payload.nonce}`, JSON.stringify(response));
      await guard();
      ledger.complete(payload.nonce, requestHash, encrypted);
      return response;
    });
  }

  private parseSignedReviewMailbox(value: unknown): SignedReviewMailbox {
    const mailbox = parseApplicationReviewMailbox(value);
    return { ...mailbox, observation: parseAutomationObservationProof(mailbox.observation) };
  }

  private async readApplicationReviewMailboxNow(replica: AutomationReplica, origin: string,
    workspaceId: string, definitionId: string, nonce: string): Promise<SignedReviewMailbox> {
    const id = this.ctx.id.name!;
    const privateRoute = await this.resolvePrivateEmailRoute(id);
    const configured = (await this.getRegisteredIntegration()) ?? parseIntegrations(this.env).find(value => value.id === id);
    const route = privateRoute ? { address: privateRoute.address, mailbox: privateRoute.mailbox }
      : configured?.emailAddress && configured.allowedForwarders?.length === 1
        ? { address: configured.emailAddress, mailbox: configured.allowedForwarders[0]! } : null;
    const setup = await this.emailSetup();
    const events = setup.events.map(event => {
      const result = event.result && typeof event.result === "object" && "reason" in event.result
        && typeof event.result.reason === "string" ? { reason: event.result.reason.slice(0, 2048) } : undefined;
      const binding = readApplicationBinding(this.ctx.storage, event.eventId);
      return { eventId: event.eventId, status: event.status, createdAt: event.createdAt, subject: event.subject.slice(0, 512),
        ...(result ? { result } : {}), ...(binding ? { bindingId: binding.bindingId } : {}) };
    });
    const observation = await replica.signObservationForRuntime(origin, nonce);
    return this.parseSignedReviewMailbox({ origin, workspaceId, definitionId, integrationId: id,
      route, receipt: { confirmation: setup.confirmation, events }, observation });
  }

  /** Resolve the private recipient through the current deployment configuration. */
  protected async resolvePrivateEmailRoute(id: string): Promise<ReturnType<typeof privateEmailRoutes>[number] | undefined> {
    return this.adapters.resolvePrivateEmailRoute ? this.adapters.resolvePrivateEmailRoute(id)
      : privateEmailRoutes(this.env).find(value => value.id === id);
  }

  private async readApplicationReviewNow(replica: AutomationReplica, eventId: string, offset: number, origin: string, workspaceId: string, definitionId: string) {
    const row = this.findById(eventId);
    if (!row || row.source !== "email") throw new Error("Saved email event was not found");
    const event = await decryptEventPayload(this.env.EVENT_STORAGE_SECRET!, eventId, row.payload);
    if (event.source !== "email") throw new Error("Application review requires retained email evidence");
    const eventHash = await applicationBindingEventHash(this.ctx.id.name!, workspaceId,
      { eventId, sourceId: row.source_id, bodyHash: row.body_hash }, event);
    const head = readApplicationBinding(this.ctx.storage, eventId);
    const record = head ? await decryptApplicationBindingRecord(this.env.EVENT_STORAGE_SECRET!,
      { integrationId: this.ctx.id.name!, eventId, bindingId: head.bindingId }, head.encryptedRecord) : null;
    if (record && head?.proofHash !== await automationBodyHash(record.proof)) throw new Error("Stored application binding evidence is inconsistent");
    const result = row.result ? JSON.parse(row.result) as { decision?: unknown } : null;
    let decisionEvent: "unclassified" | "uncertain" | "applied" | "interview" | "rejection" = "unclassified";
    let decisionHash: string | null = null;
    try {
      const decision = readApplicationEventClassification(result?.decision ?? record?.decision);
      decisionEvent = decision.event;
      if (decision.event !== "uncertain") decisionHash = (await hashApplicationBindingDecision(decision)).decisionHash;
    } catch { /* A retained event without valid classifier evidence remains inspectable but cannot be bound. */ }
    return parseApplicationReviewResponse({ kind: "automation-application-review", version: 1, origin,
      integrationId: this.ctx.id.name!, definitionId, workspaceId, eventId, eventHash, decisionEvent, decisionHash,
      status: row.status, subject: event.message.subject.slice(0, 512), text: event.message.text.slice(0, 48_000),
      sentAt: event.message.date?.slice(0, 256) ?? null, binding: record?.proof ?? null,
      ...await replica.reviewPageForRuntime(offset) });
  }

  private assertBindingRoute(proof: ApplicationBindingProof, origin: string): void {
    if (proof.signed.payload.origin !== origin || proof.signed.payload.integrationId !== this.ctx.id.name) {
      throw new Error("Application binding targets a different Worker origin or integration");
    }
  }

  private async boundEmailEvidence(row: EventRow, event: Extract<AutomationEvent, { source: "email" }>,
    replica: AutomationReplica): Promise<ApplicationBindingRecord | undefined> {
    const head = readApplicationBinding(this.ctx.storage, row.event_id);
    if (!head) return undefined;
    try {
      const record = await decryptApplicationBindingRecord(this.env.EVENT_STORAGE_SECRET!,
        { integrationId: this.ctx.id.name!, eventId: row.event_id, bindingId: head.bindingId }, head.encryptedRecord);
      const p = record.proof.signed.payload;
      this.assertBindingRoute(record.proof, p.origin);
      if (head.proofHash !== await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(record.proof)))) {
        throw new Error("Stored application binding proof differs from its durable identity");
      }
      const eventHash = await applicationBindingEventHash(p.integrationId, p.workspaceId,
        { eventId: row.event_id, sourceId: row.source_id, bodyHash: row.body_hash }, event);
      if (eventHash !== p.eventHash) throw new Error("Original email evidence differs from its application binding");
      if (replica.appliedForRuntime(row.event_id)) await replica.verifyApplicationBindingOwnerForRuntime(record.proof);
      else await replica.verifyApplicationBindingForRuntime(record.proof, { origin: p.origin, integrationId: p.integrationId,
        eventId: row.event_id, eventHash, decisionHash: p.decisionHash });
      return record;
    } catch (error) {
      throw new ApplicationBindingReviewError(error instanceof Error ? error.message : "Stored application binding needs review");
    }
  }

  async emailSetup() {
    const rows = this.ctx.storage.sql.exec<EventRow>("SELECT * FROM events WHERE source = 'email' ORDER BY created_at DESC LIMIT 10").toArray();
    let confirmation: { eventId: string; url: string } | null = null;
    const events = [];
    for (const row of rows) {
      const event = await decryptEventPayload(this.env.EVENT_STORAGE_SECRET!, row.event_id, row.payload);
      if (event.source !== "email") continue;
      events.push({ ...this.getEvent(row.event_id)!, subject: event.message.subject });
      const url = gmailForwardingConfirmationUrl(event.message);
      if (url && !confirmation) confirmation = { eventId: row.event_id, url };
    }
    return { confirmation, events };
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
              ...(typeof action.bindingId === "string" ? { bindingId: action.bindingId } : {}),
              ...(typeof action.changeHash === "string" ? { changeHash: action.changeHash } : {}),
            },
          } : {}),
        },
      } : {}),
    };
  }

  alarm(): Promise<void> {
    const operation = this.serializeMutation(() => this.processAlarm());
    flushAutomationTelemetryAfter(this.ctx, operation);
    return operation;
  }

  private async processAlarm(): Promise<void> {
    if (this.storageTransition() || this.historyTransition()) { await this.ctx.storage.deleteAlarm(); return; }
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
      this.ctx.storage.sql.exec(`UPDATE events SET status = 'review', claimed_at = NULL, updated_at = ?,
        result = json_set(COALESCE(result, '{}'), '$.reason', ?, '$.retryable', json('false'))
        WHERE status IN ('pending', 'processing')`, Date.now(), "Automation was deleted; queued event was not executed");
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
      const retained = row.result ? JSON.parse(row.result) as Record<string, unknown> : {};
      this.saveResult(row.event_id, "review", row.attempt, { ...retained, reason: "Event source is disabled for this automation", retryable: false });
      await this.scheduleNextWork(!!replica.definitionForRuntime());
      return;
    }

    const attempt = row.attempt + 1;
    this.ctx.storage.sql.exec(
      `UPDATE events SET status = 'processing', attempt = ?, claimed_at = ?, updated_at = ? WHERE event_id = ?`,
      attempt, now, now, row.event_id,
    );

    let classification: AutomationPipelineResult | undefined;
    try {
      if (!this.env.EVENT_STORAGE_SECRET) throw new Error("Event storage encryption is not configured");
      const event = await decryptEventPayload(this.env.EVENT_STORAGE_SECRET, row.event_id, row.payload);
      const emailCandidates = event.source === "email" ? replica?.candidates() : undefined;
      const definition = replica?.definitionForRuntime();
      const employeeProfile = replica?.employeeProfileForRuntime() ?? emptyEmployeeProfile();
      const priorityBands = replica?.priorityBandsForRuntime();
      const binding = event.source === "email" && replica ? await this.boundEmailEvidence(row, event, replica) : undefined;
      const frozen = row.classification_payload
        ? await decryptEventClassification(this.env.EVENT_STORAGE_SECRET, row.event_id, row.classification_payload)
        : undefined;
      const rawResult: unknown = binding && event.source === "email"
        ? { status: "review", reason: "Owner-bound retained email", source: { type: "email", receivedAt: event.receivedAt,
          messageId: event.message.messageId }, decision: binding.decision }
        : row.classification_payload ? frozen
          : this.adapters.classify
            ? await this.adapters.classify(event, definition, employeeProfile, priorityBands)
            : await (definition ? runRegisteredAutomation(definition, event, this.env.AI, employeeProfile, priorityBands, this.jobPageFetcher())
              : runPipeline(event, this.env.AI, this.jobPageFetcher(), employeeProfile, priorityBands));
      const result = validateItemCommandClassification(rawResult, event, priorityBands, replica?.employeeProfileForRuntime());
      classification = result;
      this.ctx.storage.sql.exec("UPDATE events SET result = ? WHERE event_id = ? AND attempt = ?", JSON.stringify(result), row.event_id, attempt);
      const action = await this.applyScopedDecision(row.event_id, event, result, emailCandidates, replica, binding);
      const applied = action && action.kind !== "review";
      this.ctx.storage.transactionSync(() => {
        if (binding && applied && replica) {
          const changeHash = replica.appliedForRuntime(row.event_id)?.changeHash;
          if (!changeHash) throw new Error("Bound application action lacks its signed change hash");
          appendApplicationBindingAppliedAudit(this.ctx.storage, { bindingId: binding.proof.signed.payload.bindingId,
            eventId: row.event_id, changeHash, createdAt: Date.now() });
        }
        this.saveResult(row.event_id, applied ? "applied" : "review", attempt,
          applied ? { ...result, status: "applied", reason: action.message, action }
            : action?.kind === "review" ? { ...result, reason: action.reason } : result);
      });
    } catch (error) {
      const retained = classification ?? (row.result ? JSON.parse(row.result) as Record<string, unknown> : {});
      if (error instanceof ApplicationBindingReviewError) {
        this.saveResult(row.event_id, "review", attempt, { ...retained, reason: error.message, retryable: false });
        await this.scheduleNextWork(!!replica?.definitionForRuntime());
        return;
      }
      if (error instanceof AutomationControlError) {
        this.ctx.storage.sql.exec("UPDATE events SET status = ?, attempt = ?, claimed_at = NULL, updated_at = ?, result = ? WHERE event_id = ?",
          error.state === "paused" ? "pending" : "review", row.attempt, Date.now(),
          JSON.stringify({ ...retained, reason: error.message, retryable: error.state === "paused" }), row.event_id);
        if (error.state === "paused") await this.scheduleEarlierAlarm(Date.now() + controlPollMs);
        else await this.scheduleNextWork(true);
        return;
      }
      const message = error instanceof Error ? error.message : "Automation processing failed";
      if (attempt >= maximumAttempts) {
        this.ctx.storage.sql.exec(
          "UPDATE events SET status = 'failed', claimed_at = NULL, updated_at = ?, result = ? WHERE event_id = ?",
          Date.now(), JSON.stringify({ ...retained, reason: message, retryable: false }), row.event_id,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE events SET status = 'pending', claimed_at = NULL, updated_at = ?, next_attempt_at = ?, result = ? WHERE event_id = ?",
          Date.now(), Date.now() + backoffMs(attempt), JSON.stringify({ ...retained, reason: message, retryable: true }), row.event_id,
        );
      }
      await this.scheduleNextWork(!!replica?.definitionForRuntime());
      return;
    }
    await this.scheduleNextWork(!!replica?.definitionForRuntime());
  }

  /** Runtime-owned handoff shares the same lane as signed management and event authoring. */
  withExclusiveState<T>(action: () => Promise<T>): Promise<T> {
    return this.serializeMutation(action);
  }

  /** Revalidate imported authority without authoring, draining or uploading before cutover. */
  validateMigrationState(): Promise<{ executorPersonId: string; hasReplica: boolean }> {
    return this.serializeMutation(async () => {
      const state = await this.managementInspectorNow();
      if (!state) throw new Error("Migrated executor has no retained identity and replica authority");
      return { executorPersonId: state.profile.identity.personId, hasReplica: true };
    });
  }

  private serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(action, action);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async scheduleEarlierAlarm(time: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    // Exhausted platform retries can leave an overdue alarm which new intake must rearm.
    if (existing === null || existing <= Date.now() || time < existing) {
      await this.ctx.storage.setAlarm(time);
      if (existing !== null && existing <= Date.now()) console.warn(JSON.stringify({
        event: "automation.alarm-rearmed", integrationId: this.ctx.id.name, previousScheduledAt: existing, scheduledAt: time,
      }));
    }
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
    const integrationId = this.ctx.id.name ?? "unknown";
    const stageAttributes = (phase: string) => ({ "integration.id": integrationId, "automation.phase": phase });
    const serialized = await withAutomationSpan(automationTelemetry(), "automation.control.load-replica-state",
      stageAttributes("load-replica-state"), () => this.loadReplicaState(secret));
    if (!serialized) return null;
    const profile = await withAutomationSpan(automationTelemetry(), "automation.control.load-identity-profile",
      stageAttributes("load-identity-profile"), () => this.getIdentityProfile(integrationId, identitySecret));
    const replica = await withAutomationSpan(automationTelemetry(), "automation.control.restore-replica",
      stageAttributes("restore-replica"), () => this.restoreReplica(serialized, profile, secret));
    await replica.sync();
    return replica;
  }

  private async restoreReplica(serialized: string, profile: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>,
    storageSecret: string): Promise<AutomationReplica> {
    this.assertStorageNotFrozen();
    // Always read and decrypt durable evidence first. Only an exact match may reuse its verification.
    const cached = this.loadedReplica;
    const profileFingerprint = participantProfileFingerprint(profile);
    if (cached?.serialized === serialized && cached.storageSecret === storageSecret &&
      cached.profileFingerprint === profileFingerprint) return cached.replica;
    this.loadedReplica = undefined;
    let owned: CachedReplica | undefined;
    const replica = await AutomationReplica.restore(serialized, profile,
      value => this.persistReplicaState(storageSecret, value, undefined, undefined, undefined, owned), this.replicaTransport());
    owned = { serialized, storageSecret, profileFingerprint, replica };
    this.loadedReplica = owned;
    return replica;
  }

  private packetWithTransport(packet: AutomationActivationPacket): AutomationActivationPacket {
    const transport = this.replicaTransport();
    return transport ? { ...packet, transport } : packet;
  }

  private replicaTransport(): ReplicaTransport | undefined {
    return this.adapters.replicaTransport ?? Reflect.get(this, "__tincanban_test_replica_transport__") as ReplicaTransport | undefined;
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
    emailCandidates: AutomationCandidate[] | undefined, replica: AutomationReplica | null, binding?: ApplicationBindingRecord): Promise<{
    kind: "created-lead" | "moved-application"; cardId: string; columnId?: string; message: string; bindingId?: string; changeHash?: string;
  } | { kind: "review"; reason: string } | null> {
    const recorded = replica?.appliedForRuntime(eventId);
    if (recorded && replica) {
      if (binding && (recorded.kind !== "move" || recorded.cardId !== binding.proof.signed.payload.cardId)) {
        throw new ApplicationBindingReviewError("Recorded application action differs from its owner binding");
      }
      await replica.sync();
      if (replica.controlForRuntime().state !== "active" || !replica.allowsSource(event.source)) return null;
      return { kind: recorded.kind === "lead" ? "created-lead" : "moved-application", cardId: recorded.cardId,
        ...(recorded.kind === "move" ? { columnId: recorded.columnId } : {}), message: "Previously recorded application change uploaded",
        ...(binding ? { bindingId: binding.proof.signed.payload.bindingId, changeHash: recorded.changeHash } : {}) };
    }
    const leadDecision = event.source === "website" && result.decision && "relevance" in result.decision ? result.decision : result.opportunity;
    const mailDecision = event.source === "email" && result.decision && "event" in result.decision ? result.decision : undefined;
    const isLeadProposal = leadDecision?.relevance === "yes";
    const isApplicationMove = mailDecision?.event === "applied" || mailDecision?.event === "interview" || mailDecision?.event === "rejection";
    if (!isLeadProposal && !isApplicationMove) return null;
    if (isApplicationMove && !emailCandidates) return { kind: "review", reason: "No admitted workspace is available to match this email" };
    if (isLeadProposal) {
      const opportunity = leadDecision!.distributions.job_opportunity;
      const sorted = Object.values(opportunity.probabilities).sort((left, right) => right - left);
      if (sorted[0]! < 0.7 || sorted[0]! - sorted[1]! < 0.2) return null;
      if (!(event.source === "website" ? event.submission.company || result.extraction?.company : result.extraction?.company)?.trim() ||
        !(event.source === "website" ? event.submission.role || result.extraction?.role : result.extraction?.role)?.trim()) return null;
    }
    if (!replica) return null;
    const boundCandidate = binding ? emailCandidates?.find(candidate => candidate.cardId === binding.proof.signed.payload.cardId) : undefined;
    if (binding && !boundCandidate) throw new ApplicationBindingReviewError("Bound application is no longer available");
    const applicationMovePlan = event.source === "email" && isApplicationMove && mailDecision
      ? boundCandidate ? planBoundApplicationMove(event.message, boundCandidate, replica.bindingsForRuntime(), mailDecision.event as "applied" | "interview" | "rejection")
        : await planApplicationMove(event.message, emailCandidates!, replica.bindingsForRuntime(),
          mailDecision.event as "applied" | "interview" | "rejection", this.jobPageFetcher()) : undefined;
    // Refresh after the external page lookup so changed URLs and workflows cannot use stale evidence.
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
        source: { origin: "website", page: result.extraction },
      }, leadDecision);
      await replica.sync();
      return { kind: "created-lead", cardId: created.cardId, message: created.duplicate ? "Lead was already applied" : "Lead created in the authorized Lead column" };
    }

    if (event.source === "email" && isLeadProposal && leadDecision && result.extraction) {
      const incoming = { ...event.message, urls: [...event.message.urls, result.extraction.finalUrl] };
      const candidates = replica.candidates();
      const correlation = correlateApplicationSources(incoming,
        candidates.map(candidate => ({ ...candidate, sources: candidate.sources ?? [] })));
      if (correlation.kind === "review" && correlation.reason === "No existing application matched") {
        const columns = replica.bindingsForRuntime();
        const columnId = mailDecision?.event === "applied" ? columns.applied : columns.lead;
        if (!columnId) return null;
        const created = await replica.createLead(eventId, { company: result.extraction.company, role: result.extraction.role,
          jobUrl: result.extraction.finalUrl, sourceText: event.message.text, message: event.message.text,
          receivedAt: event.receivedAt, messageIds: [event.message.messageId, event.message.inReplyTo, ...event.message.references].filter((value): value is string => !!value), roleType: leadDecision.roleType, seniority: leadDecision.seniority,
          source: { origin: "email", page: result.extraction } }, leadDecision, columnId);
        await replica.sync();
        return { kind: "created-lead", cardId: created.cardId, columnId,
          message: created.duplicate ? "Application was already recorded" : `Application created in ${columnId === columns.applied ? "Applied" : "Lead"}` };
      }
    }

    if (event.source === "email" && isApplicationMove && mailDecision) {
      if (binding) {
        const p = binding.proof.signed.payload;
        try { await replica.verifyApplicationBindingForRuntime(binding.proof, { origin: p.origin, integrationId: p.integrationId,
          eventId, eventHash: p.eventHash, decisionHash: p.decisionHash }); }
        catch (error) { throw new ApplicationBindingReviewError(error instanceof Error ? error.message : "Application binding changed before execution"); }
      }
      if (applicationMovePlan?.kind === "review") return applicationMovePlan;
      if (applicationMovePlan?.kind !== "move") return null;
      const { candidate, columnId } = applicationMovePlan;
      const current = replica.candidates().find(current => current.cardId === candidate.cardId);
      if (candidate.sources && originalSourceIds(current) !== originalSourceIds(candidate)) {
        return { kind: "review", reason: "Original posting evidence changed while processing this email" };
      }
      if (!candidate.sources && current?.jobUrl !== candidate.jobUrl) {
        return { kind: "review", reason: "Vacancy URL changed while processing this email" };
      }
      const moved = await replica.moveCard(eventId, candidate.cardId, columnId,
        { columnId: candidate.columnId, ...(candidate.workflow ? { changedAt: candidate.workflow.changedAt } : {}) });
      await replica.sync();
      return { kind: "moved-application", cardId: moved.cardId, columnId,
        ...(binding ? { bindingId: binding.proof.signed.payload.bindingId, changeHash: replica.appliedForRuntime(eventId)?.changeHash } : {}),
        message: moved.duplicate ? "Application status was already applied" : `Application moved to ${mailDecision.event === "applied" ? "Applied" : mailDecision.event === "interview" ? "Interview" : "Rejected"}` };
    }
    return null;
  }

  protected jobPageFetcher(): JobPageFetcher { return this.adapters.jobPageFetcher?.() ?? fetch; }
}

function originalSourceIds(candidate: AutomationCandidate | undefined): string {
  return (candidate?.sources ?? []).filter(source => source.observation.phase === "original")
    .map(source => source.recordId).sort().join("\0");
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

async function encryptReplicaValue(secret: string, integrationId: string, kind: "packet" | "state" | `review-response:${string}` | `instance-response:${string}`, value: string): Promise<string> {
  const key = await replicaStorageKey(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
    additionalData: new TextEncoder().encode(`TIN/automation-replica/v1/${integrationId}/${kind}`), tagLength: 128 },
  key, new TextEncoder().encode(value));
  return `${encodeBytes(nonce)}.${encodeBytes(new Uint8Array(ciphertext))}`;
}

async function decryptReplicaValue(secret: string, integrationId: string, kind: "packet" | "state" | `review-response:${string}` | `instance-response:${string}`, value: string): Promise<string> {
  const [nonceValue, ciphertextValue, extra] = value.split(".");
  if (!nonceValue || !ciphertextValue || extra !== undefined) throw new Error("Stored automation replica is invalid");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBytes(nonceValue),
    additionalData: new TextEncoder().encode(`TIN/automation-replica/v1/${integrationId}/${kind}`), tagLength: 128 },
  await replicaStorageKey(secret), decodeBytes(ciphertextValue));
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

/** Decode the existing encrypted participant state for read-only operator inventory tools. */
export function decryptParticipantReplicaState(secret: string, integrationId: string, value: string): Promise<string> {
  return decryptReplicaValue(secret, integrationId, "state", value);
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

