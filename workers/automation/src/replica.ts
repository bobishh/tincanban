import { emptyEmployeeProfile, type EmployeeProfile } from "../../../src/domain/jobPriority";
import * as Automerge from "@automerge/automerge/slim";
import automergeWasm from "@automerge/automerge/automerge.wasm";
import wasmModule from "../../../vendor/meta-mesh/packages/mesh-transport/wasm/policy/meta_mesh_policy_bg.wasm";
import { initSync, WasmStateCore } from "@meta-uber/mesh-transport/wasm";
import { computeWorkspaceAdmission, type IncomingAuthorizationBundle, type WorkspaceWriteAuthorityEvidence } from "../../../src/sync/workspaceAdmissionCore";
import { executeCommand } from "../../../src/domain/commands";
import { canonicalizeJson, publicKeyId, sha256Base64Url, signEnvelope, type LocalProfile } from "../../../src/domain/identity";
import type { SignedEnvelope } from "../../../src/domain/identity";
import { parseAutomationDefinition, type AutomationDefinition } from "../../../src/domain/automationContract";
import { verifyAutomationDefinition } from "../../../src/domain/automationDefinitionProof";
import { automationEntityId, automationLifecycle, type AutomationDesiredState } from "../../../src/domain/automationLifecycle";
import { parseAutomationApproval } from "../../../src/domain/automationApproval";
import { itemWorkflow, workflowColumnId } from "../../../src/domain/archive";
import { hasEntityKind, isItem, type AutomationGrantScope, type WorkspaceDocumentV2, type WorkspaceGrant } from "../../../src/domain/model";
import type { WorkspaceChangeAuthorization } from "../../../src/sync/workspaceChangeProofStore";
import { mergeAuthorizationRecords } from "../../../src/sync/workspaceChangeProofStore";
import { blindHash, blindObjectId, downloadBlindObject, inventoryBlindObjects, uploadBlindObject, verifyBlindReceipt, type BlindAccess, type BlindReceipt } from "../../../src/sync/blindClient";
import { decodeBlindBytes, decryptBlindObject, encodeBlindBytes, encryptBlindObject, type BlindObject } from "../../../src/sync/blindEnvelope";
import type { BlindReplicaConfig } from "../../../src/sync/blindReplication";

initSync({ module: wasmModule });

let automergeReady: Promise<void> | undefined;

function initializeAutomerge(): Promise<void> {
  return (automergeReady ??= Automerge.initializeWasm(automergeWasm as unknown as Uint8Array));
}


const maximumSnapshotBytes = 16 * 1024 * 1024 - 16;
const maximumPages = 8;

export class AutomationControlError extends Error {
  constructor(readonly state: "paused" | "deleted") { super(`Automation is ${state}`); }
}

export type AutomationFieldBindings = {
  company: string;
  role: string;
  jobUrl: string;
  notes?: string;
  sourceText?: string;
  roleType?: string;
  seniority?: string;
};

export type AutomationReplicaBindings = {
  boardId: string;
  columns: AutomationGrantScope["columns"];
  fieldIds: AutomationFieldBindings;
};

export type AutomationInitialSnapshot = {
  document: string;
  authorization: IncomingAuthorizationBundle;
  chat?: unknown;
};

export type ReplicaTransport = {
  inventory: typeof inventoryBlindObjects;
  download: typeof downloadBlindObject;
  upload: (access: BlindAccess, object: BlindObject) => Promise<BlindReceipt>;
};

export type AutomationActivationPacket = {
  version: 1 | 2;
  definition?: SignedEnvelope<AutomationDefinition>;
  workspaceId: string;
  blind: BlindReplicaConfig;
  grant: WorkspaceGrant;
  bindings: AutomationReplicaBindings;
  initial: AutomationInitialSnapshot;
  /** Durable Object callback; awaited before any outbound network upload. */
  persist?: (serialized: string) => Promise<void>;
  /** Injectable only for local acceptance tests. Receipt validation remains in this adapter. */
  transport?: ReplicaTransport;
};

export type NormalizedLead = {
  company: string;
  role: string;
  jobUrl?: string;
  message?: string;
  contact?: string;
  roleType?: string;
  seniority?: string;
  sourceText?: string;
  receivedAt?: string;
};

export type ExpectedWorkflow = { columnId: string; changedAt?: string };

export type AutomationCandidate = {
  cardId: string;
  company: string;
  role: string;
  jobUrl?: string;
  columnId: string;
  workflow?: { columnId: string; changedAt: string };
  messageIds: string[];
};

type AppliedEvent = { kind: "lead"; cardId: string } | { kind: "move"; cardId: string; columnId: string };
type PendingUpload = { hash: string; object: BlindObject };
type OpaqueChatBatch = { version: 1 | 2; capabilities?: string[]; upgradeRequired?: boolean; messages: unknown[]; profiles: unknown[]; typing: unknown[] };
type SerializedReplica = {
  version: 1 | 2;
  workspaceId: string;
  blind: BlindReplicaConfig;
  grant: WorkspaceGrant;
  definition?: SignedEnvelope<AutomationDefinition>;
  tombstoned?: true;
  bindings: AutomationReplicaBindings;
  authority: WorkspaceWriteAuthorityEvidence;
  rawDocument: string;
  authorizations: WorkspaceChangeAuthorization[];
  chat: OpaqueChatBatch | null;
  pending?: PendingUpload;
  applied: Record<string, AppliedEvent>;
};
type WireSnapshot = { version: 1; workspaceId: string; document: string; authorization: IncomingAuthorizationBundle; chat: OpaqueChatBatch | null };

const defaultTransport: ReplicaTransport = {
  inventory: inventoryBlindObjects,
  download: downloadBlindObject,
  upload: uploadBlindObject,
};

/** Owner-approved, bounded Automerge writer for one existing workspace. */
export class AutomationReplica {
  private rawDocument: string;
  private authorizations: WorkspaceChangeAuthorization[];
  private chat: OpaqueChatBatch | null;
  private pending?: PendingUpload;
  private applied: Record<string, AppliedEvent>;
  private definition?: SignedEnvelope<AutomationDefinition>;
  private tombstoned: boolean;
  private running: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly profile: LocalProfile,
    private readonly workspaceId: string,
    private readonly blind: BlindReplicaConfig,
    private readonly grant: WorkspaceGrant,
    private readonly bindings: AutomationReplicaBindings,
    private authority: WorkspaceWriteAuthorityEvidence,
    private cursor: number,
    private lastUploaded: string,
    private readonly persistHook?: (serialized: string) => Promise<void>,
    private readonly transport: ReplicaTransport = defaultTransport,
    serialized?: SerializedReplica,
    initialChat: OpaqueChatBatch | null = null,
  ) {
    this.rawDocument = serialized?.rawDocument ?? "";
    this.authorizations = serialized?.authorizations ?? [];
    this.chat = serialized ? parseOpaqueChat(serialized.chat) : initialChat;
    this.pending = serialized?.pending;
    this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, serialized?.applied ?? {});
    this.definition = serialized?.definition;
    this.tombstoned = serialized?.tombstoned === true;
  }

  static async activate(packet: AutomationActivationPacket, profile: LocalProfile, expectedOrigin?: string): Promise<AutomationReplica> {
    await initializeAutomerge();
    if (!packet.persist) throw new Error("Automation activation requires durable replica persistence");
    const authority = await validateActivation(packet, profile);
    const sourceBytes = decodeBlindBytes(packet.initial.document);
    if (sourceBytes.length > maximumSnapshotBytes) throw new Error("Initial workspace snapshot exceeds the size limit");
    const admission = computeWorkspaceAdmission({ workspaceId: packet.workspaceId, remote: sourceBytes,
      authorization: packet.initial.authorization, knownAuthority: null, now: Date.now() }, WasmStateCore as never);
    assertFullyAdmitted(admission, sourceBytes);
    const authorityFromAdmission = mergeAuthority(packet.initial.authorization.authority, null, admission);
    const replica = new AutomationReplica(profile, packet.workspaceId, { ...packet.blind }, packet.grant,
      packet.bindings, authorityFromAdmission, packet.blind.cursor, packet.blind.lastUploaded,
      packet.persist, packet.transport, undefined, parseOpaqueChat(packet.initial.chat));
    replica.rawDocument = encodeBlindBytes(sourceBytes);
    replica.definition = packet.definition;
    replica.authorizations = mergeAuthorizationRecords([], admission.verifiedAuthorizations);
    const control = replica.controlForRuntime();
    replica.tombstoned = control.state === "deleted";
    if (expectedOrigin) replica.observationForRuntime(expectedOrigin, crypto.randomUUID());
    await replica.persistState();
    return replica;
  }

  static async restore(serialized: string, profile: LocalProfile,
    persist?: (serialized: string) => Promise<void>, transport: ReplicaTransport = defaultTransport): Promise<AutomationReplica> {
    await initializeAutomerge();
    if (!persist) throw new Error("Automation restore requires durable replica persistence");
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) throw new Error("Serialized automation replica is too large");
    const value = JSON.parse(serialized) as SerializedReplica;
    await validateSerialized(value, profile);
    const replica = new AutomationReplica(profile, value.workspaceId, { ...value.blind }, value.grant,
      value.bindings, value.authority, value.blind.cursor, value.blind.lastUploaded,
      persist, transport, value);
    assertFullyAdmitted(await replica.revalidate(), decodeBlindBytes(replica.rawDocument));
    replica.controlForRuntime();
    return replica;
  }

  sync(): Promise<void> {
    return this.enqueue(async () => {
      this.assertActive();
      this.assertPersistence();
      await this.pull();
      if (!this.tombstoned && this.controlForRuntime().state === "deleted") {
        this.tombstoned = true;
        await this.persistState();
      }
      await this.push();
    });
  }

  createLead(eventId: string, normalized: NormalizedLead, decision: unknown): Promise<{ cardId: string; duplicate: boolean }> {
    return this.enqueue(async () => {
      this.assertActive();
      this.assertPersistence();
      await this.revalidate();
      this.assertExecuting();
      const cardId = await deterministicCardId(eventId);
      const previous = Object.hasOwn(this.applied, eventId) ? this.applied[eventId] : undefined;
      if (previous) {
        if (previous.kind !== "lead" || previous.cardId !== cardId) throw new Error("Automation event was already applied differently");
        return { cardId, duplicate: true };
      }
      const document = this.admittedDocument();
      try {
        if (isItem(document.entities[cardId])) {
          const previousApplied = this.applied;
          this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, previousApplied);
          this.applied[eventId] = { kind: "lead", cardId };
          try { await this.persistState(); }
          catch (error) { this.applied = previousApplied; delete this.applied[eventId]; throw error; }
          return { cardId, duplicate: true };
        }
        const values = this.leadValues(normalized, decision, eventId);
        const result = await executeCommand(document, { kind: "createItem", id: cardId,
          parentId: this.bindings.columns.lead, title: `${requiredText(normalized.company, "company")} — ${requiredText(normalized.role, "role")}`,
          body: normalized.message?.slice(0, 8_000) ?? "", values }, this.profile, actorIdForProfile(this.profile), await this.grantHash());
        if (!result.ok) throw new Error(`Lead creation rejected: ${result.error.message}`);
        const previousRaw = this.rawDocument;
        const previousAuthorizations = this.authorizations;
        const previousApplied = this.applied;
        this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, previousApplied);
        try { await this.acceptAuthoredDocument(result.value.newDoc, result.value.receipt.changeHash); }
        finally { Automerge.free(result.value.newDoc); }
        this.applied[eventId] = { kind: "lead", cardId };
        try { await this.persistState(); }
        catch (error) {
          this.rawDocument = previousRaw;
          this.authorizations = previousAuthorizations;
          this.applied = previousApplied;
          throw error;
        }
        return { cardId, duplicate: false };
      } finally { Automerge.free(document); }
    });
  }

  moveCard(eventId: string, cardId: string, columnId: string, expectedWorkflow: ExpectedWorkflow): Promise<{ cardId: string; duplicate: boolean }> {
    return this.enqueue(async () => {
      this.assertActive();
      this.assertPersistence();
      await this.revalidate();
      this.assertExecuting();
      if (columnId !== this.bindings.columns.interview && columnId !== this.bindings.columns.rejected) {
        throw new Error("Automation may move cards only to Interview or Rejected");
      }
      const previous = Object.hasOwn(this.applied, eventId) ? this.applied[eventId] : undefined;
      if (previous) {
        if (previous.kind !== "move" || previous.cardId !== cardId || previous.columnId !== columnId) {
          throw new Error("Automation event was already applied differently");
        }
        return { cardId, duplicate: true };
      }
      const document = this.admittedDocument();
      try {
        const item = document.entities[cardId];
        if (!isItem(item) || item.archivedAt) throw new Error("Application card is unavailable or archived");
        const currentWorkflow = itemWorkflow(item);
        if (workflowColumnId(document.entities, cardId) !== expectedWorkflow.columnId ||
          !currentWorkflow || !expectedWorkflow.changedAt || currentWorkflow.changedAt !== expectedWorkflow.changedAt ||
          currentWorkflow.columnId !== expectedWorkflow.columnId) {
          throw new Error("Application workflow changed; event requires review");
        }
        const result = await executeCommand(document, { kind: "moveEntity", entityId: cardId, parentId: columnId },
          this.profile, actorIdForProfile(this.profile), await this.grantHash());
        if (!result.ok) throw new Error(`Application move rejected: ${result.error.message}`);
        const previousRaw = this.rawDocument;
        const previousAuthorizations = this.authorizations;
        const previousApplied = this.applied;
        this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, previousApplied);
        try { await this.acceptAuthoredDocument(result.value.newDoc, result.value.receipt.changeHash); }
        finally { Automerge.free(result.value.newDoc); }
        this.applied[eventId] = { kind: "move", cardId, columnId };
        try { await this.persistState(); }
        catch (error) {
          this.rawDocument = previousRaw;
          this.authorizations = previousAuthorizations;
          this.applied = previousApplied;
          throw error;
        }
        return { cardId, duplicate: false };
      } finally { Automerge.free(document); }
    });
  }

  candidates(): AutomationCandidate[] {
    this.assertActive();
    const document = this.admittedDocument();
    try {
      return Object.values(document.entities).filter((entity): entity is Extract<WorkspaceDocumentV2["entities"][string], { body: string }> =>
        isItem(entity) && !entity.archivedAt && belongsToBoard(document, entity.id, this.bindings.boardId))
        .map(item => ({ cardId: item.id, company: stringValue(item.values[this.bindings.fieldIds.company]),
          role: stringValue(item.values[this.bindings.fieldIds.role]),
          ...(this.bindings.fieldIds.jobUrl && stringValue(item.values[this.bindings.fieldIds.jobUrl])
            ? { jobUrl: stringValue(item.values[this.bindings.fieldIds.jobUrl]) } : {}),
          columnId: workflowColumnId(document.entities, item.id) ?? item.placement.parentId ?? "",
          ...(itemWorkflow(item) ? { workflow: itemWorkflow(item) } : {}), messageIds: [],
        }));
    } finally { Automerge.free(document); }
  }

  employeeProfileForRuntime(): EmployeeProfile {
    const document = this.admittedDocument();
    try {
      const board = document.entities[this.bindings.boardId];
      return hasEntityKind(board, "board") && board.employee_profile ? { ...board.employee_profile } : emptyEmployeeProfile();
    } finally { Automerge.free(document); }
  }

  priorityBandsForRuntime(): Array<{ optionId: string; minScore: number }> | undefined {
    const document = this.admittedDocument();
    try {
      const board = document.entities[this.bindings.boardId];
      return hasEntityKind(board, "board") && board.priorityPolicy?.evaluator === "job-fit-v1"
        ? board.priorityPolicy.bands.map(band => ({ ...band })) : undefined;
    } finally { Automerge.free(document); }
  }

  bindingsForRuntime(): AutomationGrantScope["columns"] { return { ...this.bindings.columns }; }

  definitionForRuntime(): AutomationDefinition | undefined {
    return this.definition ? parseAutomationDefinition(this.definition.payload) : undefined;
  }

  controlForRuntime(): { state: AutomationDesiredState; heads: string[] } {
    if (!this.definition) return { state: "active", heads: [] };
    const definition = this.definitionForRuntime()!;
    const document = this.admittedDocument();
    try {
      const entity = document.entities[automationEntityId(definition.id)];
      if (!hasEntityKind(entity, "automation") || entity.executor.personId !== this.profile.identity.personId ||
        canonicalizeJson(parseAutomationDefinition(JSON.parse(entity.definition))) !== canonicalizeJson(definition) ||
        entity.placement.parentId !== this.bindings.boardId) throw new Error("Automation CRDT definition does not match its signed activation");
      const approval = parseAutomationApproval(entity.approval);
      if (canonicalizeJson(approval.definition) !== canonicalizeJson(this.definition) || canonicalizeJson(approval.grant) !== canonicalizeJson(this.grant)) {
        throw new Error("Automation CRDT approval differs from its activated grant");
      }
      const control = automationLifecycle(entity);
      return this.tombstoned ? { ...control, state: "deleted" } : control;
    } finally { Automerge.free(document); }
  }

  observationForRuntime(origin: string, nonce: string) {
    const definition = this.definitionForRuntime();
    if (!definition) throw new Error("Legacy automation has no confirmed control contract");
    const document = this.admittedDocument();
    try {
      const entity = document.entities[automationEntityId(definition.id)];
      if (!hasEntityKind(entity, "automation") || entity.executor.origin !== origin) throw new Error("Automation executor origin differs from this Worker");
    } finally { Automerge.free(document); }
    return { kind: "automation-observation" as const, version: 1 as const, origin, integrationId: definition.id,
      workspaceId: this.workspaceId, grantId: this.grant.payload.grantId, nonce, issuedAt: Date.now(), ...this.controlForRuntime() };
  }

  allowsSource(source: "website" | "email"): boolean {
    return this.controlForRuntime().state === "active" && (this.definitionForRuntime()?.parameters.sources.includes(source) ?? true);
  }

  serialize(): string {
    return JSON.stringify({ version: this.definition ? 2 : 1, workspaceId: this.workspaceId, blind: { ...this.blind, cursor: this.cursor, lastUploaded: this.lastUploaded },
      grant: this.grant, ...(this.definition ? { definition: this.definition } : {}), bindings: this.bindings, authority: this.authority, rawDocument: this.rawDocument,
      authorizations: this.authorizations, chat: this.chat, ...(this.tombstoned ? { tombstoned: true as const } : {}),
      ...(this.pending ? { pending: this.pending } : {}), applied: this.applied } satisfies SerializedReplica);
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.running.then(action, action);
    this.running = next.then(() => undefined, () => undefined);
    return next;
  }

  private async pull(): Promise<void> {
    for (let page = 0; page < maximumPages; page += 1) {
      const inventory = await this.transport.inventory(this.blind, this.cursor);
      for (const entry of inventory.objects) {
        const object = await this.transport.download(this.blind, entry.objectId);
        const plaintext = await decryptBlindObject(object, this.blind.scopeId, this.blind.keyEpoch, decodeBlindBytes(this.blind.contentKey));
        if (plaintext.length > maximumSnapshotBytes) throw new Error("Encrypted automation snapshot exceeds the size limit");
        const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as WireSnapshot;
        if (snapshot.version !== 1 || snapshot.workspaceId !== this.workspaceId || typeof snapshot.document !== "string" ||
          !snapshot.authorization) throw new Error("Encrypted snapshot is invalid");
        const nextChat = mergeOpaqueChat(this.chat, parseOpaqueChat(snapshot.chat));
        const incoming = decodeBlindBytes(snapshot.document);
        const local = decodeBlindBytes(this.rawDocument);
        const merged = mergeDocuments(local, incoming, actorIdForProfile(this.profile));
        const bundle = normalizeBundle(snapshot.authorization, this.authorizations);
        const authority = prepareAuthority(bundle.authority, this.authority, merged, this.workspaceId);
        const admission = computeWorkspaceAdmission({ workspaceId: this.workspaceId, remote: merged,
          authorization: { ...bundle, authority }, knownAuthority: this.authority, now: Date.now() }, WasmStateCore as never);
        const previous = { authority: this.authority, authorizations: this.authorizations, rawDocument: this.rawDocument, chat: this.chat, cursor: this.cursor };
        this.authority = authority;
        this.authorizations = mergeAuthorizationRecords(this.authorizations, admission.verifiedAuthorizations);
        this.rawDocument = encodeBlindBytes(merged);
        this.chat = nextChat;
        const nextCursor = entry.sequence;
        const previousCursor = this.cursor;
        this.cursor = nextCursor;
        try { await this.persistState(); }
        catch (error) {
          this.authority = previous.authority;
          this.authorizations = previous.authorizations;
          this.rawDocument = previous.rawDocument;
          this.chat = previous.chat;
          this.cursor = previousCursor;
          throw error;
        }
      }
      if (!inventory.hasMore) break;
    }
  }

  private async push(): Promise<void> {
    const access = this.blind;
    const bundle = { version: 1 as const, records: this.authorizations, authority: this.authority };
    const admission = await this.revalidate();
    if (admission.quarantinedHashes.length || admission.pendingHashes.length) throw new Error("Unadmitted workspace changes prevent replica upload");
    const snapshot: WireSnapshot = { version: 1, workspaceId: this.workspaceId, document: this.rawDocument,
      authorization: bundle, chat: this.chat };
    const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
    if (plaintext.length > maximumSnapshotBytes) throw new Error("Automation snapshot exceeds the Rusty object limit");
    const hash = await blindHash(plaintext);
    if (hash === this.lastUploaded && !this.pending) return;
    if (!this.pending || this.pending.hash !== hash) {
      this.pending = { hash, object: await encryptBlindObject(access.scopeId, access.keyEpoch,
        decodeBlindBytes(access.contentKey), plaintext) };
      await this.persistState();
    }
    const object = this.pending.object;
    const receipt = await this.transport.upload(access, object);
    await verifyBlindReceipt(receipt, access, object, receipt.payload.requestId);
    const previousUploaded = this.lastUploaded;
    this.lastUploaded = hash;
    this.pending = undefined;
    try { await this.persistState(); }
    catch (error) { this.lastUploaded = previousUploaded; this.pending = { hash, object }; throw error; }
  }

  private async revalidate() {
    this.assertActive();
    const bytes = decodeBlindBytes(this.rawDocument);
    const admission = computeWorkspaceAdmission({ workspaceId: this.workspaceId, remote: bytes,
      authorization: { version: 1, records: this.authorizations, authority: this.authority },
      knownAuthority: this.authority, now: Date.now() }, WasmStateCore as never);
    return admission;
  }

  private admittedDocument(): Automerge.Doc<WorkspaceDocumentV2> {
    const bytes = decodeBlindBytes(this.rawDocument);
    const admission = computeWorkspaceAdmission({ workspaceId: this.workspaceId, remote: bytes,
      authorization: { version: 1, records: this.authorizations, authority: this.authority },
      knownAuthority: this.authority, now: Date.now() }, WasmStateCore as never);
    if (admission.quarantinedHashes.length || admission.pendingHashes.length) throw new Error("Workspace is not fully admitted");
    return Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument, { actor: actorIdForProfile(this.profile) });
  }

  private async acceptAuthoredDocument(document: Automerge.Doc<WorkspaceDocumentV2>, changeHash: string): Promise<void> {
    const current = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(this.rawDocument));
    try {
      const newChanges = Automerge.getChanges(current, document);
      if (newChanges.length !== 1 || Automerge.decodeChange(newChanges[0]!).hash !== changeHash) {
        throw new Error("Automation authoring produced unexpected Automerge history");
      }
      const signed = await signEnvelope(this.profile.privateKeys.devicePrivateKey, {
        kind: "workspace-changes" as const, version: 1 as const, workspaceId: this.workspaceId,
        hashes: [changeHash], personId: this.profile.identity.personId, deviceId: this.profile.device.deviceId,
      }, this.profile.device.deviceId);
      const nextAuthorizations = mergeAuthorizationRecords(this.authorizations, [{ signed,
        publicKey: this.profile.identity.publicKey, certificates: [this.profile.certificate], grant: this.grant,
        ownerPublicKey: this.authority.currentOwner.publicKey,
        ownerCertificates: this.authority.currentOwner.certificates }]);
      const merged = Automerge.merge(current, document);
      const candidateRaw = encodeBlindBytes(Automerge.save(merged));
      const result = computeWorkspaceAdmission({ workspaceId: this.workspaceId, remote: decodeBlindBytes(candidateRaw),
        authorization: { version: 1, records: nextAuthorizations, authority: this.authority },
        knownAuthority: this.authority, now: Date.now() }, WasmStateCore as never);
      if (result.quarantinedHashes.includes(changeHash) || result.pendingHashes.includes(changeHash) || !result.admittedHashes.includes(changeHash)) {
        const decision = result.decisions.find(value => value.hash === changeHash);
        throw new Error(`Rust rejected the scoped automation change: ${JSON.stringify(decision?.status ?? "missing-admission")}`);
      }
      this.authorizations = nextAuthorizations;
      this.rawDocument = candidateRaw;
    } finally { Automerge.free(current); }
  }

  private leadValues(normalized: NormalizedLead, decision: unknown, eventId: string): Record<string, string> {
    const scope = this.grant.payload.automation!;
    const values: Record<string, string> = {
      [this.bindings.fieldIds.company]: requiredText(normalized.company, "company"),
      [this.bindings.fieldIds.role]: requiredText(normalized.role, "role"),
    };
    if (normalized.jobUrl) values[this.bindings.fieldIds.jobUrl] = normalized.jobUrl.slice(0, 2048);
    if (this.bindings.fieldIds.roleType && normalized.roleType) values[this.bindings.fieldIds.roleType] = normalized.roleType.slice(0, 256);
    if (this.bindings.fieldIds.seniority && normalized.seniority) values[this.bindings.fieldIds.seniority] = normalized.seniority.slice(0, 256);
    const source = JSON.stringify({ eventId, receivedAt: normalized.receivedAt, contact: normalized.contact,
      message: normalized.message?.slice(0, 2000), sourceText: normalized.sourceText?.slice(0, 2000), decision });
    if (this.bindings.fieldIds.notes && normalized.message) values[this.bindings.fieldIds.notes] = normalized.message.slice(0, 8_000);
    if (this.bindings.fieldIds.sourceText) values[this.bindings.fieldIds.sourceText] = source;
    for (const fieldId of Object.keys(values)) {
      if (!scope.fieldIds.includes(fieldId)) throw new Error("Automation field binding exceeds the signed grant scope");
    }
    return values;
  }

  private async grantHash(): Promise<string> {
    return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(this.grant)));
  }

  private assertActive(): void {
    if (Date.now() >= this.grant.payload.automation!.expiresAt) throw new Error("Automation grant has expired");
  }

  private assertExecuting(): void {
    const control = this.controlForRuntime();
    if (control.state !== "active") throw new AutomationControlError(control.state);
  }

  private assertPersistence(): void {
    if (!this.persistHook) throw new Error("Durable replica persistence is required before automation actions");
  }

  private async persistState(): Promise<void> {
    if (!this.persistHook) return;
    await this.persistHook(this.serialize());
  }
}

async function validateActivation(packet: AutomationActivationPacket, profile: LocalProfile): Promise<WorkspaceWriteAuthorityEvidence> {
  if (!packet || ![1, 2].includes(packet.version) || packet.workspaceId !== packet.blind.workspaceId ||
    !packet.workspaceId || !packet.grant?.payload || packet.grant.payload.role !== "automation" ||
    packet.grant.payload.workspaceId !== packet.workspaceId || packet.grant.payload.personId !== profile.identity.personId) {
    throw new Error("Automation activation packet is invalid");
  }
  validateBindings(packet.bindings, packet.grant.payload.automation);
  parseOpaqueChat(packet.initial.chat);
  if (packet.blind.cursor < 0 || !Number.isSafeInteger(packet.blind.cursor) || packet.blind.lastUploaded && !/^[A-Za-z0-9_-]{43}$/.test(packet.blind.lastUploaded)) {
    throw new Error("Blind replica cursor is invalid");
  }
  if (packet.blind.scopeId.length < 1 || packet.blind.workspaceId !== packet.workspaceId || packet.blind.keyEpoch < 1) {
    throw new Error("Blind replica scope is invalid");
  }
  const authority = packet.initial.authorization.authority;
  const owner = authority.currentOwner;
  if (!owner?.personId || !owner.publicKey || await publicKeyId(owner.publicKey) !== owner.personId) {
    throw new Error("Current workspace owner is not bound to its public key");
  }
  const grant = packet.grant;
  if (grant.payload.accessEpoch !== authority.currentEpoch || grant.payload.automation!.expiresAt <= Date.now()) {
    throw new Error("Automation grant epoch or expiry is invalid");
  }
  const role = WasmStateCore.verifyWorkspaceGrant(grant, packet.workspaceId, profile.identity.personId, {
    personId: owner.personId, publicKey: owner.publicKey, certificates: owner.certificates,
  });
  if (role !== "automation") throw new Error("Owner did not authorize this automation identity");
  if (packet.version === 2 && !packet.definition || packet.version === 1 && packet.definition) {
    throw new Error("Automation activation version does not match its type contract");
  }
  if (packet.definition) await validateDefinitionProof(packet.definition, packet.workspaceId, grant, owner);
  return prepareAuthority(authority, null, decodeBlindBytes(packet.initial.document), packet.workspaceId);
}

function validateBindings(bindings: AutomationReplicaBindings, scope?: AutomationGrantScope): void {
  if (!scope || bindings.boardId !== scope.boardId || canonicalizeJson(bindings.columns) !== canonicalizeJson(scope.columns)) {
    throw new Error("Automation field and board bindings differ from the signed scope");
  }
  const fieldIds = Object.values(bindings.fieldIds);
  if (fieldIds.some(field => typeof field !== "string" || !field) || new Set(fieldIds).size !== fieldIds.length ||
    canonicalizeJson([...fieldIds].sort()) !== canonicalizeJson([...scope.fieldIds].sort())) {
    throw new Error("Automation fields differ from the signed scope");
  }
}

async function validateSerialized(value: SerializedReplica, profile: LocalProfile): Promise<void> {
  if (!value || ![1, 2].includes(value.version) || value.workspaceId !== value.blind?.workspaceId ||
    value.grant?.payload?.role !== "automation" || value.grant.payload.personId !== profile.identity.personId ||
    !value.rawDocument || !Array.isArray(value.authorizations) || !value.authority || !value.applied || typeof value.applied !== "object") {
    throw new Error("Serialized automation replica is invalid");
  }
  if (value.version === 2 && !value.definition || value.version === 1 && value.definition ||
    value.tombstoned !== undefined && value.tombstoned !== true) throw new Error("Serialized automation contract version is invalid");
  validateBindings(value.bindings, value.grant.payload.automation);
  if (value.blind.cursor < 0 || !Number.isSafeInteger(value.blind.cursor) ||
    (value.blind.lastUploaded !== "" && !/^[A-Za-z0-9_-]{43}$/.test(value.blind.lastUploaded)) ||
    value.blind.workspaceId !== value.workspaceId || value.blind.keyEpoch < 1) {
    throw new Error("Serialized blind replica configuration is invalid");
  }
  const owner = value.authority.currentOwner;
  if (!owner?.personId || !owner.publicKey || await publicKeyId(owner.publicKey) !== owner.personId ||
    value.grant.payload.accessEpoch !== value.authority.currentEpoch || value.grant.payload.automation!.expiresAt <= Date.now()) {
    throw new Error("Serialized automation authority is invalid or expired");
  }
  const role = WasmStateCore.verifyWorkspaceGrant(value.grant, value.workspaceId, profile.identity.personId, {
    personId: owner.personId, publicKey: owner.publicKey, certificates: owner.certificates,
  });
  if (role !== "automation") throw new Error("Serialized automation grant is not owner-authorized");
  if (value.definition) await validateDefinitionProof(value.definition, value.workspaceId, value.grant, owner);
}

async function validateDefinitionProof(definition: SignedEnvelope<AutomationDefinition>, workspaceId: string,
  grant: WorkspaceGrant, owner: WorkspaceWriteAuthorityEvidence["currentOwner"]): Promise<void> {
  await verifyAutomationDefinition(definition, { workspaceId, boardId: grant.payload.automation!.boardId,
    grantId: grant.payload.grantId, signerKeyId: grant.signerKeyId }, owner);
}

function prepareAuthority(incoming: WorkspaceWriteAuthorityEvidence, known: WorkspaceWriteAuthorityEvidence | null,
  documentBytes: Uint8Array, workspaceId: string): WorkspaceWriteAuthorityEvidence {
  const document = Automerge.load<WorkspaceDocumentV2>(documentBytes);
  try {
    if (document.id !== workspaceId) throw new Error("Automation snapshot workspace mismatch");
    return WasmStateCore.prepareWriteEvidence({ incoming, known, records: [], genesisPersonId: document.ownerPersonId,
      remoteOwnerPersonId: document.ownerPersonId }) as WorkspaceWriteAuthorityEvidence;
  } finally { Automerge.free(document); }
}

function mergeAuthority(incoming: WorkspaceWriteAuthorityEvidence, known: WorkspaceWriteAuthorityEvidence | null,
  _admission: { decisions: unknown[] }): WorkspaceWriteAuthorityEvidence {
  return WasmStateCore.prepareWriteEvidence({ incoming, known, records: [], genesisPersonId: incoming.genesisOwner.personId,
    remoteOwnerPersonId: incoming.currentOwner.personId }) as WorkspaceWriteAuthorityEvidence;
}

function normalizeBundle(bundle: IncomingAuthorizationBundle, records: WorkspaceChangeAuthorization[]): IncomingAuthorizationBundle {
  const flattened = bundle.version === 1 ? bundle.records : bundle.pages.flat();
  return { version: 1, records: mergeAuthorizationRecords(records, flattened as WorkspaceChangeAuthorization[]), authority: bundle.authority };
}

function parseOpaqueChat(value: unknown): OpaqueChatBatch | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat snapshot is invalid");
  const chat = value as Partial<OpaqueChatBatch>;
  if ((chat.version !== 1 && chat.version !== 2) || !Array.isArray(chat.messages) || !Array.isArray(chat.profiles) ||
    (chat.typing !== undefined && !Array.isArray(chat.typing)) || chat.messages.length > 2_000 || chat.profiles.length > 512 ||
    (chat.typing?.length ?? 0) > 512 ||
    (chat.capabilities !== undefined && (!Array.isArray(chat.capabilities) || chat.capabilities.length > 16 ||
      chat.capabilities.some(capability => typeof capability !== "string" || capability.length > 64))) ||
    (chat.upgradeRequired !== undefined && typeof chat.upgradeRequired !== "boolean")) {
    throw new Error("Chat snapshot is invalid");
  }
  const normalized: OpaqueChatBatch = { version: chat.version, messages: [...chat.messages], profiles: [...chat.profiles],
    typing: [...(chat.typing ?? [])], ...(chat.capabilities ? { capabilities: [...chat.capabilities] } : {}),
    ...(chat.upgradeRequired === undefined ? {} : { upgradeRequired: chat.upgradeRequired }) };
  for (const records of [normalized.messages, normalized.profiles, normalized.typing]) {
    for (const record of records) {
      const signature = opaqueChatSignature(record);
      if (!signature) throw new Error("Chat snapshot contains an unsigned record");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 8 * 1024 * 1024) {
    throw new Error("Chat snapshot exceeds the size limit");
  }
  return normalized;
}

function mergeOpaqueChat(leftInput: unknown, rightInput: unknown): OpaqueChatBatch | null {
  const left = parseOpaqueChat(leftInput);
  const right = parseOpaqueChat(rightInput);
  if (!left) return right;
  if (!right) return left;
  const mergeRecords = (a: unknown[], b: unknown[]) => {
    const records = new Map<string, unknown>();
    for (const record of [...a, ...b]) records.set(opaqueChatSignature(record), record);
    return [...records.values()];
  };
  return parseOpaqueChat({ version: left.version === 2 || right.version === 2 ? 2 : 1,
    capabilities: [...new Set([...(left.capabilities ?? []), ...(right.capabilities ?? [])])],
    upgradeRequired: left.upgradeRequired === true || right.upgradeRequired === true,
    messages: mergeRecords(left.messages, right.messages), profiles: mergeRecords(left.profiles, right.profiles),
    typing: mergeRecords(left.typing, right.typing) });
}

function opaqueChatSignature(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as { signed?: { signature?: unknown; signerKeyId?: unknown; payload?: unknown };
    publicKey?: unknown; certificates?: unknown; authority?: unknown };
  const payload = record.signed?.payload;
  return typeof record.signed?.signature === "string" && record.signed.signature.length > 0 &&
    record.signed.signature.length <= 512 && typeof record.signed.signerKeyId === "string" &&
    record.signed.signerKeyId.length > 0 && record.signed.signerKeyId.length <= 256 &&
    typeof record.publicKey === "string" && Array.isArray(record.certificates) &&
    Boolean(record.authority && typeof record.authority === "object") && Boolean(payload && typeof payload === "object")
    ? record.signed.signature : "";
}

function mergeDocuments(leftBytes: Uint8Array, rightBytes: Uint8Array, actorId: string): Uint8Array {
  const left = Automerge.load<WorkspaceDocumentV2>(leftBytes, { actor: actorId });
  const right = Automerge.load<WorkspaceDocumentV2>(rightBytes, { actor: actorId });
  const merged = Automerge.merge(left, right);
  try { return Automerge.save(merged); }
  finally {
    // merge returns a view over left's handle, so release the handle only once.
    Automerge.free(left);
    if (right !== left) Automerge.free(right);
  }
}

function assertFullyAdmitted(admission: ReturnType<typeof computeWorkspaceAdmission>, source: Uint8Array): void {
  if (admission.pendingHashes.length || admission.quarantinedHashes.length || admission.admittedHashes.length !== admission.neededHashes.length) {
    throw new Error("Initial snapshot contains changes that are not fully authorized");
  }
  if (!admission.neededHashes.length && source.length === 0) throw new Error("Initial workspace snapshot is empty");
}

function belongsToBoard(document: WorkspaceDocumentV2, itemId: string, boardId: string): boolean {
  const seen = new Set<string>();
  let current: string | null = itemId;
  while (current && !seen.has(current)) {
    if (current === boardId) return true;
    seen.add(current);
    current = document.entities[current]?.placement.parentId ?? null;
  }
  return false;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function actorIdForProfile(profile: LocalProfile): string {
  return [...decodeBlindBytes(profile.device.deviceId)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > 8_000) {
    throw new TypeError(`${field} is required and must be bounded text`);
  }
  return value.trim();
}

async function deterministicCardId(eventId: string): Promise<string> {
  if (typeof eventId !== "string" || !eventId.trim() || eventId.length > 256) throw new TypeError("Automation event ID is invalid");
  return `automation-${(await sha256Base64Url(new TextEncoder().encode(eventId))).slice(0, 32)}`;
}
