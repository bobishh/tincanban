import { emptyEmployeeProfile, type EmployeeProfile } from "./jobPriority";
import * as Automerge from "@automerge/automerge/slim";
import type { Context } from "@opentelemetry/api";
import automergeWasm from "@automerge/automerge/automerge.wasm";
import wasmModule from "../../../vendor/meta-mesh/packages/mesh-transport/wasm/policy/meta_mesh_policy_bg.wasm";
import { initSync, WasmStateCore, type WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm";
import { computeWorkspaceAdmission, computeWorkspaceDocumentAdmission, type IncomingAuthorizationBundle, type WorkspaceAdmissionResult, type WorkspaceWriteAuthorityEvidence,
  admitHistoricalAutomationAuthority, mergeAttachmentLocators, parseAttachmentLocators,
  parseWireHistoryBaseline, type AttachmentLocator, type HistoryBaselineFetchPort, type WireHistoryBaseline,
  type WorkspaceChangeAuthorization } from "../../../src/product-replica";
import { mergeAuthorizationRecords } from "../../../src/product-replica/workspaceAuthorizationRecords";
import { executeOwnedCommand } from "../../../src/domain/commands";
import { canonicalizeJson, publicKeyId, sha256Base64Url, type SignedEnvelope } from "../../../src/domain/identityCrypto";
import type { LocalProfile } from "../../../src/domain/identity";
import { parseAutomationDefinition, type AutomationDefinition } from "../../../src/domain/automationContract";
import { verifyAutomationDefinition } from "../../../src/domain/automationDefinitionProof";
import { automationEntityId, automationLifecycle, type AutomationDesiredState } from "../../../src/domain/automationLifecycle";
import { parseAutomationApproval } from "../../../src/domain/automationApproval";
import { itemWorkflow, workflowColumnId } from "../../../src/domain/archive";
import { hasEntityKind, isItem, type AutomationGrantScope, type WorkspaceDocumentV2, type WorkspaceGrant } from "../../../src/domain/model";
import { rustyHash as blindHash, downloadRustyObject as downloadBlindObject, inventoryRustyObjects as inventoryBlindObjects,
  uploadRustyObject as uploadBlindObject, verifyRustyStorageReceipt as verifyBlindReceipt,
  decodeBlindBytes, decryptBlindObject, encodeBlindBytes, encryptBlindObject,
  type RustyReplicaAccess as BlindAccess, type RustyStorageReceipt as BlindReceipt, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica";
import type { BlindReplicaConfig } from "../../../src/product-replica";
import { ReplicaEngine, emptyReplicaState, parseReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine";
import { captureApplicationSource } from "./applicationSourceCapture";
import type { JobPageResult } from "./extraction";
import { readApplicationSourceData, type ApplicationSourceData } from "../../../src/domain/applicationSourceData";
import { parseApplicationBindingProof, verifyApplicationBinding, type ApplicationBindingExpected,
  type ApplicationBindingPayload, type ApplicationBindingProof } from "../../../src/domain/applicationBinding";
import { resolveSigningContext, signingEvidence, signWithContext } from "../../../src/domain/signingContext";
import { parseAutomationObservationProof, type AutomationObservationProof } from "../../../src/domain/automationProtocol";
import type { ApplicationReviewOption } from "../../../src/domain/applicationReviewData";
import { assertRetainsReplicaContentKeys, openWithReplicaContentKeys, parseReplicaContentKeys } from "../../../src/domain/replicaContentKeys";
import { parseReplicaConfig } from "../../../src/domain/replicaConfig";
import { createArchiveRemote } from "@meta-uber/mesh-replication/history-archive-remote";
import { assertWorkerHistoryCoversHeads, receiveWorkerHistoryBasis, restoreWorkerHistoryBasis, validateWorkerHistoryAuthority,
  type StoredWorkerHistoryBasis } from "./historyBaseline";
import { deliverPublicBoard } from "../../../src/public/publicDelivery";
import { automationPublicProjection } from "./publicBoardDelivery";
import { automationDiagnosticContext, automationPublicDeliveryHttp, automationTelemetry, recordAutomationException, withAutomationSpan } from "./telemetry";

initSync({ module: wasmModule });

let automergeReady: Promise<void> | undefined;

function initializeAutomerge(): Promise<void> {
  return (automergeReady ??= Automerge.initializeWasm(automergeWasm as unknown as Uint8Array));
}


const maximumSnapshotBytes = 16 * 1024 * 1024 - 16;

function automationStorageBinding(workspaceId: string, blind: BlindReplicaConfig): string {
  const keys = parseReplicaContentKeys(blind);
  const fields: unknown[] = [workspaceId, blind.origin, blind.scopeId, keys.keyEpoch, blind.policyRevision,
    blind.servicePublicKey, blind.readToken, blind.writeToken, keys.contentKey];
  if (keys.historicalContentKeys) fields.push({ historicalContentKeys: keys.historicalContentKeys });
  if (keys.historicalContentKeyVariants) fields.push({ historicalContentKeyVariants: keys.historicalContentKeyVariants });
  return canonicalizeJson(fields);
}

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
  history?: WireHistoryBaseline;
  scopeAuthoritySnapshot?: unknown;
  authorization: IncomingAuthorizationBundle;
  chat?: unknown;
  attachments?: unknown;
};

export type ReplicaTransport = {
  inventory: typeof inventoryBlindObjects;
  download: typeof downloadBlindObject;
  upload: (access: BlindAccess, object: BlindObject, requestId?: string, observedSequence?: number) => Promise<BlindReceipt>;
  archive?: (access: BlindAccess, guard: () => void | Promise<void>) => HistoryBaselineFetchPort;
  publicDelivery?: typeof deliverPublicBoard;
  receiptVerified?: (receipt: BlindReceipt, object: BlindObject, requestId: string,
    includedEvents: Readonly<Record<string, { changeHash?: string }>>) => Promise<void>;
};

export type AutomationManagementInspector = {
  pull: (guard: () => Promise<void>) => Promise<void>;
  drainPending: (guard: () => Promise<void>) => Promise<void>;
  rotateStorageCredentials: (nextBlind: BlindReplicaConfig, persist: (serialized: string) => Promise<void>,
    guard: () => void | Promise<void>) => Promise<AutomationManagementInspector>;
  prepareHistory: (snapshot: unknown, guard: () => Promise<void>) => Promise<string[]>;
  verifyHistory: (baselineId: string, sourceHeads: string[], guard: () => Promise<void>) => Promise<void>;
  historyBaselineId: () => string | undefined;
  assertOwner: (identity: WorkspaceWriteAuthorityEvidence["currentOwner"], deviceId: string) => void;
  describe: (origin: string, workspaceId: string, definitionId: string) => {
    workspaceId: string; boardId: string; definitionId: string | null; executorPersonId: string;
    grantId: string; expiresAt: number; state: AutomationDesiredState; adoptionRequired: boolean;
    historyUsage: ActiveHistoryUsage & { archiveRequired: boolean };
    storage: { origin: string; scopeId: string; keyEpoch: number; servicePublicKey: string;
      policyRevision: number; minimumWriterVersion?: 2 };
  };
  serialize: () => string;
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
  messageIds?: string[];
  source?: { origin: "website" | "email"; page?: JobPageResult };
};

export type ExpectedWorkflow = { columnId: string; changedAt?: string };

export type AutomationCandidate = {
  cardId: string;
  title?: string;
  company: string;
  role: string;
  jobUrl?: string;
  columnId: string;
  workflow?: { columnId: string; changedAt: string };
  messageIds?: string[];
  sources?: ApplicationSourceData[];
};

type AppliedEvent = ({ kind: "lead"; cardId: string } | { kind: "move"; cardId: string; columnId: string }) & { changeHash?: string; messageIds?: string[] };
type PendingUpload = { hash: string; object: BlindObject; requestId?: string; observedSequence?: number; bytes?: number; revision?: string; identity?: string };
type ActiveHistoryUsage = { baselineId: string | null; admittedChanges: number; encodedBytes: number };
const activeHistoryChangeLimit = 512;
const activeHistoryByteLimit = 4 * 1024 * 1024;
function historyBaselineId(wire: WireHistoryBaseline): string {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBlindBytes(wire.signedJson))) as { payload?: { baselineId?: unknown } };
  if (typeof value.payload?.baselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.payload.baselineId)) {
    throw new Error("Worker history baseline identifier is invalid");
  }
  return value.payload.baselineId;
}
function parseActiveHistoryUsage(value: unknown, baselineId: string | null): ActiveHistoryUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !["baselineId", "admittedChanges", "encodedBytes"].every(key => Object.hasOwn(row, key)) ||
      row.baselineId !== baselineId || !(row.baselineId === null || typeof row.baselineId === "string" && /^[A-Za-z0-9_-]{43}$/.test(row.baselineId)) ||
      !Number.isSafeInteger(row.admittedChanges) || (row.admittedChanges as number) < 0 || (row.admittedChanges as number) > activeHistoryChangeLimit ||
      !Number.isSafeInteger(row.encodedBytes) || (row.encodedBytes as number) < 0 || (row.encodedBytes as number) > activeHistoryByteLimit) return undefined;
  return { baselineId, admittedChanges: row.admittedChanges as number, encodedBytes: row.encodedBytes as number };
}
function countChanges(changes: Uint8Array[], baselineId: string | null): ActiveHistoryUsage {
  return { baselineId, admittedChanges: Math.min(activeHistoryChangeLimit, changes.length),
    encodedBytes: Math.min(activeHistoryByteLimit, changes.reduce((total, change) => total + change.byteLength, 0)) };
}
function historyBudgetExceeded(value: ActiveHistoryUsage): boolean {
  return value.admittedChanges >= activeHistoryChangeLimit || value.encodedBytes >= activeHistoryByteLimit;
}
function receivedHistoryUsage(current: ActiveHistoryUsage, changes: Uint8Array[]): ActiveHistoryUsage {
  return { baselineId: current.baselineId,
    admittedChanges: Math.min(activeHistoryChangeLimit, current.admittedChanges + changes.length),
    encodedBytes: Math.min(activeHistoryByteLimit, current.encodedBytes + changes.reduce((total, change) => total + change.byteLength, 0)) };
}
function ensureHistoryBudget(current: ActiveHistoryUsage, changes: Uint8Array[]): ActiveHistoryUsage {
  const addedBytes = changes.reduce((total, change) => total + change.byteLength, 0);
  const admittedChanges = current.admittedChanges + changes.length;
  const encodedBytes = current.encodedBytes + addedBytes;
  if (admittedChanges > activeHistoryChangeLimit || encodedBytes > activeHistoryByteLimit) {
    throw new Error("Archive older history before this automation can add more changes");
  }
  return { baselineId: current.baselineId, admittedChanges, encodedBytes };
}
function measureInitialHistoryUsage(documentBytes: Uint8Array, baselineBytes?: Uint8Array, baselineId: string | null = null): ActiveHistoryUsage {
  const document = Automerge.load<WorkspaceDocumentV2>(documentBytes);
  try {
    if (!baselineBytes) return countChanges(Automerge.getAllChanges(document), null);
    const baseline = Automerge.load<WorkspaceDocumentV2>(baselineBytes);
    try { return countChanges(Automerge.getChanges(baseline, document), baselineId); }
    finally { Automerge.free(baseline); }
  } finally { Automerge.free(document); }
}
type ReplicaMetadata = Omit<ReplicaState<BlindObject>, "cursor" | "lastUploaded" | "pending"> & { contentRevision: string };
type OpaqueChatBatch = { version: 1 | 2; capabilities?: string[]; upgradeRequired?: boolean; messages: unknown[]; profiles: unknown[]; typing: unknown[] };
type SerializedReplica = {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  history?: StoredWorkerHistoryBasis;
  historyUsage?: ActiveHistoryUsage;
  scopeAuthoritySnapshot?: unknown;
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
  attachments?: AttachmentLocator[];
  pending?: PendingUpload;
  replication?: ReplicaMetadata;
  applied: Record<string, AppliedEvent>;
  publicDelivery?: { pending: boolean; sourceHeads: string[]; error?: string };
};
type WireSnapshot = { version: 1 | 2; history?: WireHistoryBaseline; workspaceId: string; document: string; authorization: IncomingAuthorizationBundle;
  chat: OpaqueChatBatch | null; attachments?: AttachmentLocator[] };

const defaultTransport: ReplicaTransport = {
  publicDelivery: input => deliverPublicBoard({ ...input, client: "automation", http: automationPublicDeliveryHttp }),
  inventory: (access, after) => inventoryBlindObjects({ ...access, client: "automation", clientBuild: undefined }, after,
    automationPublicDeliveryHttp.request),
  download: (access, id) => downloadBlindObject({ ...access, client: "automation", clientBuild: undefined }, id,
    automationPublicDeliveryHttp.request),
  upload: (access, object, requestId = crypto.randomUUID(), observedSequence) => uploadBlindObject({ ...access, client: "automation", clientBuild: undefined }, object, requestId, observedSequence,
    automationPublicDeliveryHttp.request),
};

/** Hosts may journal a storage acknowledgement only after the shared verifier accepts it. */
export function observeReplicaReceipts(observer: NonNullable<ReplicaTransport["receiptVerified"]>): ReplicaTransport {
  return { ...defaultTransport, receiptVerified: observer };
}

/** Owner-approved, bounded Automerge writer for one existing workspace. */
export class AutomationReplica {
  private publicDelivery?: SerializedReplica["publicDelivery"];
  private history?: StoredWorkerHistoryBasis;
  private historyBasis?: WasmVerifiedReceivedHistoryBaseline;
  private historyUsage: ActiveHistoryUsage = { baselineId: null, admittedChanges: 0, encodedBytes: 0 };
  private scopeAuthoritySnapshot?: unknown;
  private rawDocument: string;
  private authorizations: WorkspaceChangeAuthorization[];
  private chat: OpaqueChatBatch | null;
  private attachments: AttachmentLocator[];
  private progress: ReplicaState<BlindObject>;
  private contentRevision: string;
  private engine: ReplicaEngine<Uint8Array, BlindObject, BlindReceipt>;
  private applied: Record<string, AppliedEvent>;
  private definition?: SignedEnvelope<AutomationDefinition>;
  private tombstoned: boolean;
  private running: Promise<unknown> = Promise.resolve();
  private deviceAccessCache = new Map<string, { raw: string; authority: WorkspaceWriteAuthorityEvidence;
    grant: WorkspaceGrant | undefined; checkedAt: number; role: ReturnType<typeof WasmStateCore.decideWorkspaceAccess> }>();
  private admissionCache?: { rawDocument: string; authorizations: WorkspaceChangeAuthorization[];
    authority: WorkspaceWriteAuthorityEvidence; result: WorkspaceAdmissionResult };

  private constructor(
    private readonly profile: LocalProfile,
    private readonly workspaceId: string,
    private readonly blind: BlindReplicaConfig,
    private readonly grant: WorkspaceGrant,
    private readonly bindings: AutomationReplicaBindings,
    private authority: WorkspaceWriteAuthorityEvidence,
    cursor: number,
    lastUploaded: string,
    private readonly persistHook?: (serialized: string) => Promise<void>,
    private readonly transport: ReplicaTransport = defaultTransport,
    serialized?: SerializedReplica,
    initialChat: OpaqueChatBatch | null = null,
  ) {
    this.blind = structuredClone(blind);
    this.grant = structuredClone(grant);
    this.bindings = structuredClone(bindings);
    this.authority = structuredClone(authority);
    this.profile = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
      certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } };
    this.rawDocument = serialized?.rawDocument ?? "";
    this.history = structuredClone(serialized?.history);
    const baselineId = this.history?.wire ? historyBaselineId(this.history.wire) : null;
    this.historyUsage = parseActiveHistoryUsage(serialized?.historyUsage, baselineId) ?? {
      baselineId, admittedChanges: activeHistoryChangeLimit, encodedBytes: activeHistoryByteLimit,
    };
    this.scopeAuthoritySnapshot = structuredClone(serialized?.scopeAuthoritySnapshot);
    this.authorizations = structuredClone(serialized?.authorizations ?? []);
    this.chat = structuredClone(serialized ? parseOpaqueChat(serialized.chat) : initialChat);
    this.attachments = parseAttachmentLocators(serialized?.attachments);
    const binding = this.storageBinding();
    this.contentRevision = serialized?.replication?.contentRevision ?? crypto.randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(this.contentRevision)) throw new Error("Invalid replica content revision");
    this.progress = parseReplicaState({ ...emptyReplicaState<BlindObject>(binding, cursor, lastUploaded),
      ...serialized?.replication, cursor, lastUploaded }, binding);
    this.pending = serialized?.pending;
    this.engine = this.createEngine();
    this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, serialized?.applied ?? {});
    this.definition = serialized?.definition;
    this.tombstoned = serialized?.tombstoned === true;
    this.publicDelivery = structuredClone(serialized?.publicDelivery);
  }

  static async activate(packet: AutomationActivationPacket, profile: LocalProfile, expectedOrigin?: string): Promise<AutomationReplica> {
    await initializeAutomerge();
    if (!packet.persist) throw new Error("Automation activation requires durable replica persistence");
    const sourceBytes = decodeBlindBytes(packet.initial.document);
    if (sourceBytes.length > maximumSnapshotBytes) throw new Error("Initial workspace snapshot exceeds the size limit");
    const authorityFromAdmission = await validateActivation(packet, profile);
    const replica = new AutomationReplica(profile, packet.workspaceId, { ...packet.blind }, packet.grant,
      packet.bindings, authorityFromAdmission, packet.blind.cursor, packet.blind.lastUploaded,
      packet.persist, packet.transport, undefined, parseOpaqueChat(packet.initial.chat));
    if (packet.initial.scopeAuthoritySnapshot) replica.scopeAuthoritySnapshot = validateWorkerHistoryAuthority(packet.initial.scopeAuthoritySnapshot,
      packet.workspaceId, authorityFromAdmission.currentOwner);
    if (packet.initial.history) {
      if (!replica.scopeAuthoritySnapshot) throw new Error("Worker history requires an admitted signed scope authority");
      const guard = async () => { replica.assertActive(); };
      const received = await receiveWorkerHistoryBasis({ wire: packet.initial.history, workspaceId: packet.workspaceId,
        config: replica.blind, trustedScopeAuthority: replica.scopeAuthoritySnapshot,
        fetch: replica.archiveReader(guard), guard, ensureCurrent: () => replica.assertActive() });
      replica.history = received.stored; replica.historyBasis = received.basis;
    }
    try {
      const admission = computeWorkspaceAdmission({ workspaceId: packet.workspaceId, remote: sourceBytes,
        authorization: packet.initial.authorization, knownAuthority: null, receivedBasis: replica.historyBasis, now: Date.now() }, WasmStateCore as never);
      assertFullyAdmitted(admission, sourceBytes);
      replica.rawDocument = encodeBlindBytes(sourceBytes);
      replica.definition = packet.definition;
      replica.authorizations = mergeAuthorizationRecords([], admission.verifiedAuthorizations);
      replica.attachments = mergeAttachmentLocators(packet.initial.attachments);
      replica.historyUsage = measureInitialHistoryUsage(sourceBytes, replica.historyBasis?.document(),
        replica.history ? historyBaselineId(replica.history.wire) : null);
      const control = replica.controlForRuntime();
      replica.tombstoned = control.state === "deleted";
      if (expectedOrigin) replica.observationForRuntime(expectedOrigin, crypto.randomUUID());
      await replica.persistState();
      return replica;
    } catch (error) { replica.historyBasis?.free(); throw error; }
  }

  static async renew(serialized: string, packet: AutomationActivationPacket, profile: LocalProfile, expectedOrigin: string): Promise<AutomationReplica> {
    return AutomationReplica.renewExisting(serialized, packet, profile, expectedOrigin, false);
  }

  /** Explicit owner adoption attaches a typed contract to the same durable legacy executor. */
  static async adoptLegacy(serialized: string, packet: AutomationActivationPacket, profile: LocalProfile, expectedOrigin: string): Promise<AutomationReplica> {
    return AutomationReplica.renewExisting(serialized, packet, profile, expectedOrigin, true);
  }

  private static async renewExisting(serialized: string, packet: AutomationActivationPacket, profile: LocalProfile,
    expectedOrigin: string, adoptLegacy: boolean): Promise<AutomationReplica> {
    await initializeAutomerge();
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) throw new Error("Serialized automation replica is too large");
    const prior = JSON.parse(serialized) as SerializedReplica;
    const priorBasis = await restoreSerializedHistory(prior, () => {});
    await validateSerialized(prior, profile, "renewal", priorBasis);
    priorBasis?.free();
    if (canonicalizeJson(prior.history?.wire ?? null) !== canonicalizeJson(packet.initial.history ?? null)) {
      throw new Error("Synchronize the verified history basis before renewing automation approval");
    }
    if (adoptLegacy && (prior.definition || packet.version !== 2 || !packet.definition)) {
      throw new Error("Explicit adoption requires an untyped replica and a new signed definition");
    }
    if (prior.tombstoned || prior.workspaceId !== packet.workspaceId || prior.bindings.boardId !== packet.bindings.boardId ||
      !adoptLegacy && prior.definition?.payload.id !== packet.definition?.payload.id) throw new Error("Automation renewal must preserve its executor and workspace");
    if (prior.blind.origin !== packet.blind.origin) throw new Error(`Automation renewal storage origin mismatch: expected ${prior.blind.origin}, received ${packet.blind.origin}`);
    const rotatedStorage = prior.blind.contentKey !== packet.blind.contentKey ||
      prior.blind.scopeId !== packet.blind.scopeId || prior.blind.keyEpoch !== packet.blind.keyEpoch;
    const combined = mergeDocuments(decodeBlindBytes(prior.rawDocument), decodeBlindBytes(packet.initial.document), actorIdForProfile(profile));
    let publish = false;
    const replica = await AutomationReplica.activate({ ...packet, persist: async value => {
      if (publish) await packet.persist!(value);
    }, initial: { ...packet.initial, document: encodeBlindBytes(combined),
      authorization: normalizeBundle(packet.initial.authorization, prior.authorizations),
      chat: mergeOpaqueChat(prior.chat, packet.initial.chat),
      attachments: mergeAttachmentLocators(prior.attachments, packet.initial.attachments),
    } }, profile, expectedOrigin);
    if (replica.controlForRuntime().state === "deleted") throw new Error("Deleted automation cannot be renewed");
    replica.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, prior.applied);
    replica.historyUsage = structuredClone(prior.historyUsage ?? { baselineId: prior.history ? historyBaselineId(prior.history.wire) : null,
      admittedChanges: activeHistoryChangeLimit, encodedBytes: activeHistoryByteLimit });
    if (prior.pending && rotatedStorage) throw new Error("Drain the exact pending upload before renewing approval with different storage credentials");
    replica.pending = prior.pending;
    replica.cursor = rotatedStorage ? packet.blind.cursor : prior.blind.cursor;
    replica.lastUploaded = rotatedStorage ? "" : prior.blind.lastUploaded;
    publish = true;
    await replica.persistState();
    return replica;
  }

  static async restore(serialized: string, profile: LocalProfile,
    persist?: (serialized: string) => Promise<void>, transport: ReplicaTransport = defaultTransport): Promise<AutomationReplica> {
    await initializeAutomerge();
    if (!persist) throw new Error("Automation restore requires durable replica persistence");
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) throw new Error("Serialized automation replica is too large");
    const value = JSON.parse(serialized) as SerializedReplica;
    const basis = await restoreSerializedHistory(value, () => { if (Date.now() >= value.grant.payload.automation!.expiresAt) throw new Error("Automation grant has expired"); });
    await validateSerialized(value, profile, "restore", basis);
    const replica = new AutomationReplica(profile, value.workspaceId, { ...value.blind }, value.grant,
      value.bindings, value.authority, value.blind.cursor, value.blind.lastUploaded,
      persist, transport, value);
    replica.historyBasis = basis;
    assertFullyAdmitted(await replica.revalidate(), decodeBlindBytes(replica.rawDocument));
    // Legacy fallback counters are not evidence of actual active history size.
    replica.historyUsage = measureInitialHistoryUsage(decodeBlindBytes(replica.rawDocument), basis?.document(),
      replica.history ? historyBaselineId(replica.history.wire) : null);
    replica.controlForRuntime();
    await replica.validateStoredProgress();
    return replica;
  }

  /** Historical contracts permit owner inspection only. Never expose an expired writer to callers. */
  static async inspectForManagement(serialized: string, profile: LocalProfile,
    persist: (serialized: string) => Promise<void>, transport: ReplicaTransport = defaultTransport): Promise<AutomationManagementInspector> {
    await initializeAutomerge();
    if (!persist) throw new Error("Automation management requires durable replica persistence");
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) throw new Error("Serialized automation replica is too large");
    const value = JSON.parse(serialized) as SerializedReplica;
    const basis = await restoreSerializedHistory(value, () => {});
    const admission = await validateSerialized(value, profile, "management", basis);
    const replica = new AutomationReplica(profile, value.workspaceId, value.blind, value.grant,
      value.bindings, value.authority, value.blind.cursor, value.blind.lastUploaded, persist, transport, value);
    replica.historyBasis = basis;
    replica.admissionCache = { rawDocument: replica.rawDocument, authorizations: replica.authorizations,
      authority: replica.authority, result: admission! };
    replica.historyUsage = measureInitialHistoryUsage(decodeBlindBytes(replica.rawDocument), basis?.document(),
      replica.history ? historyBaselineId(replica.history.wire) : null);
    return replica.managementInspector();
  }

  /** Restrict an already admitted instance to guarded management, sharing its durable progress and admission. */
  managementInspector(): AutomationManagementInspector {
    const replica = this;
    return Object.freeze({
      pull: (guard: () => Promise<void>) => replica.enqueue(async () => {
        const engine = replica.createEngine(async () => {
          await guard();
          assertFullyAdmitted(replica.admission(), decodeBlindBytes(replica.rawDocument));
        });
        if (!await engine.pull()) throw new Error("Automation management is still catching up; retry inspection");
      }),
      drainPending: (guard: () => Promise<void>) => replica.enqueue(async () => {
        const engine = replica.createEngine(async () => {
          await guard();
          assertFullyAdmitted(replica.admission(), decodeBlindBytes(replica.rawDocument));
        });
        await engine.drainPending();
      }),
      rotateStorageCredentials: (nextBlind: BlindReplicaConfig, persist: (serialized: string) => Promise<void>,
        guard: () => void | Promise<void>) => AutomationReplica.rotateStorageCredentials(
        replica.serialize(), replica.profile, nextBlind, persist, guard, replica.transport),
      prepareHistory: (snapshot: unknown, guard: () => Promise<void>) => replica.enqueue(async () => {
        await guard();
        const anchor = validateWorkerHistoryAuthority(snapshot, replica.workspaceId, replica.authority.currentOwner);
        const previous = replica.scopeAuthoritySnapshot;
        // Preserve the original admitted anchor so older signed baselines still reverify after control advances.
        if (previous && canonicalizeJson((previous as { genesis?: unknown }).genesis) !==
          canonicalizeJson((anchor as { genesis?: unknown }).genesis)) throw new Error("History preparation cannot replace the admitted scope root");
        replica.scopeAuthoritySnapshot = previous ?? anchor;
        try { await guard(); await replica.persistState(); }
        catch (error) { replica.scopeAuthoritySnapshot = previous; throw error; }
        const engine = replica.createEngine(async () => { await guard(); assertFullyAdmitted(replica.admission(), decodeBlindBytes(replica.rawDocument)); });
        await engine.drainPending();
        await engine.push();
        await guard();
        if (replica.progress.pending) throw new Error("Worker history preparation still has an unconfirmed original snapshot");
        const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(replica.rawDocument));
        try {
          const heads = Automerge.getHeads(document).sort();
          if (heads.length > 256) throw new Error("Worker history frontier exceeds transition bound");
          return heads;
        } finally { Automerge.free(document); }
      }),
      verifyHistory: (baselineId: string, sourceHeads: string[], guard: () => Promise<void>) => replica.enqueue(async () => {
        await guard();
        if (!replica.historyBasis || replica.historyBasis.envelope().payload.baselineId !== baselineId) throw new Error("Worker has not received the exact requested verified history baseline");
        assertFullyAdmitted(replica.admission(), decodeBlindBytes(replica.rawDocument));
        await assertWorkerHistoryCoversHeads(replica.historyBasis, sourceHeads, replica.blind, replica.archiveReader(guard), guard);
        await guard();
      }),
      historyBaselineId: () => replica.historyBasis?.envelope().payload.baselineId,
      assertOwner: (identity: WorkspaceWriteAuthorityEvidence["currentOwner"], deviceId: string) =>
        replica.assertOwnerDeviceForRuntime(identity, deviceId),
      describe: (origin: string, workspaceId: string, definitionId: string) =>
        replica.managementDescription(origin, workspaceId, definitionId),
      serialize: () => replica.serialize(),
    });
  }

  /** Apply a separately authorized Rusty policy revision without renewing the automation grant or running replication. */
  static async refreshStoragePolicy(serialized: string, profile: LocalProfile, policyRevision: number,
    persist: (serialized: string) => Promise<void>, ensureCurrent: () => void | Promise<void>): Promise<AutomationManagementInspector> {
    const profileSnapshot = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
      certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } };
    const checkCurrent = ensureCurrent;
    await checkCurrent();
    if (!persist) throw new Error("Automation storage policy refresh requires durable persistence");
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) throw new Error("Serialized automation replica is too large");

    // Management validation admits historical grants without making them executable.
    await AutomationReplica.inspectForManagement(serialized, profileSnapshot, async () => {});
    await checkCurrent();
    const prior = JSON.parse(serialized) as SerializedReplica;
    if (!Number.isSafeInteger(policyRevision) || policyRevision < 1 || policyRevision < prior.blind.policyRevision) {
      throw new Error("Rusty storage policy revision is stale or invalid");
    }

    let nextSerialized = serialized;
    if (prior.blind.policyRevision !== policyRevision || prior.blind.minimumWriterVersion !== 2) {
      const next = structuredClone(prior);
      next.blind.policyRevision = policyRevision;
      next.blind.minimumWriterVersion = 2;
      if (next.replication) {
        next.replication.binding = automationStorageBinding(next.workspaceId, next.blind);
      }
      nextSerialized = JSON.stringify(next);
      await AutomationReplica.inspectForManagement(nextSerialized, profileSnapshot, async () => {});
      await checkCurrent();
      await persist(nextSerialized);
      await checkCurrent();
    }

    const inspector = await AutomationReplica.inspectForManagement(nextSerialized, profileSnapshot, async () => {});
    await checkCurrent();
    return inspector;
  }

  /** Replace frozen Rusty storage credentials without changing grant, content, or executor provenance. */
  static async rotateStorageCredentials(serialized: string, profile: LocalProfile, nextBlind: BlindReplicaConfig,
    persist: (serialized: string) => Promise<void>, ensureCurrent: () => void | Promise<void>,
    transport: ReplicaTransport = defaultTransport): Promise<AutomationManagementInspector> {
    const targetSnapshot = structuredClone(nextBlind);
    const profileSnapshot = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
      certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } };
    const checkCurrent = ensureCurrent;
    await checkCurrent();
    if (!persist) throw new Error("Automation credential rotation requires durable persistence");
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) throw new Error("Serialized automation replica is too large");

    // Management mode validates retained authority, including expired, paused, or deleted executors.
    await AutomationReplica.inspectForManagement(serialized, profileSnapshot, async () => {}, transport);
    await checkCurrent();
    const prior = JSON.parse(serialized) as SerializedReplica;
    const target = parseReplicaConfig(JSON.stringify(targetSnapshot));
    if (target.origin !== prior.blind.origin || target.scopeId !== prior.blind.scopeId ||
      target.workspaceId !== prior.workspaceId || target.servicePublicKey !== prior.blind.servicePublicKey ||
      target.removalPending || target.minimumWriterVersion !== 2) {
      throw new Error("Rusty credential rotation must preserve the pinned Worker storage scope and require writer version 2");
    }
    const credentials = (value: BlindReplicaConfig) => canonicalizeJson([value.origin, value.scopeId, value.workspaceId,
      value.servicePublicKey, value.policyRevision, value.keyEpoch, value.contentKey, value.historicalContentKeys ?? null, value.historicalContentKeyVariants ?? null,
      value.readToken, value.writeToken, value.minimumWriterVersion ?? null]);
    if (credentials(prior.blind) === credentials(target)) {
      const inspector = await AutomationReplica.inspectForManagement(serialized, profileSnapshot, async () => {}, transport);
      await checkCurrent();
      return inspector;
    }
    if (!Number.isSafeInteger(prior.blind.policyRevision) || prior.blind.policyRevision < 1 ||
      !Number.isSafeInteger(target.policyRevision) || target.policyRevision <= prior.blind.policyRevision ||
      prior.blind.keyEpoch >= Number.MAX_SAFE_INTEGER || target.keyEpoch <= prior.blind.keyEpoch ||
      target.readToken === prior.blind.readToken || target.writeToken === prior.blind.writeToken) {
      throw new Error("Rusty credential rotation must advance policy and the content-key epoch while retaining every old key");
    }
    assertRetainsReplicaContentKeys(prior.blind, target);
    if (prior.pending || prior.replication && Object.hasOwn(prior.replication, "pending")) {
      throw new Error("Drain the exact pending Worker upload before rotating storage credentials");
    }

    const next = structuredClone(prior);
    // Keep the current Worker-state reader and its active-history accounting
    // across credential rotation. Older versions restore conservatively at the
    // archive threshold, which is safe but would force needless maintenance.
    next.version = 6;
    const activeBaselineId = next.history ? historyBaselineId(next.history.wire) : null;
    next.historyUsage = parseActiveHistoryUsage(next.historyUsage, activeBaselineId) ?? {
      baselineId: activeBaselineId, admittedChanges: activeHistoryChangeLimit, encodedBytes: activeHistoryByteLimit,
    };
    const { purpose: _purpose, preferenceRevision: _preferenceRevision, ...targetCredentials } = target;
    next.blind = { ...targetCredentials, cursor: prior.blind.cursor, lastUploaded: "" };
    const oldBinding = automationStorageBinding(prior.workspaceId, prior.blind);
    const nextBinding = automationStorageBinding(next.workspaceId, next.blind);
    const replication = structuredClone(prior.replication ?? { version: 1 as const, binding: oldBinding,
      generation: 0, contentRevision: crypto.randomUUID() });
    if (replication.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Worker replica generation is exhausted");
    replication.binding = nextBinding;
    replication.generation++;
    delete replication.uploadedRevision;
    next.replication = replication;
    const nextSerialized = JSON.stringify(next);

    await AutomationReplica.inspectForManagement(nextSerialized, profileSnapshot, async () => {}, transport);
    await checkCurrent();
    await persist(nextSerialized);
    await checkCurrent();
    const inspector = await AutomationReplica.inspectForManagement(nextSerialized, profileSnapshot, async () => {}, transport);
    await checkCurrent();
    return inspector;
  }

  private managementDescription(origin: string, workspaceId: string, definitionId: string) {
    if (workspaceId !== this.workspaceId || this.definition && this.definition.payload.id !== definitionId) {
      throw new Error("Automation definition does not match this existing workspace instance");
    }
    assertFullyAdmitted(this.admission(), decodeBlindBytes(this.rawDocument));
    let state: AutomationDesiredState = this.tombstoned ? "deleted" : "active";
    if (this.definition) {
      const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(this.rawDocument));
      try {
        const entity = document.entities[automationEntityId(definitionId)];
        if (!hasEntityKind(entity, "automation") || entity.executor.personId !== this.profile.identity.personId ||
          entity.executor.origin !== origin || entity.placement.parentId !== this.bindings.boardId ||
          parseAutomationDefinition(JSON.parse(entity.definition)).id !== definitionId) {
          throw new Error("Automation definition does not match its admitted executor and board");
        }
        state = this.tombstoned ? "deleted" : automationLifecycle(entity).state;
      } finally { Automerge.free(document); }
    }
    return { workspaceId: this.workspaceId, boardId: this.bindings.boardId,
      definitionId: this.definition?.payload.id ?? null, executorPersonId: this.profile.identity.personId,
      grantId: this.grant.payload.grantId, expiresAt: this.grant.payload.automation!.expiresAt,
      state, adoptionRequired: !this.definition,
      historyUsage: { ...this.historyUsage, archiveRequired: historyBudgetExceeded(this.historyUsage) },
      storage: { origin: this.blind.origin, scopeId: this.blind.scopeId, keyEpoch: this.blind.keyEpoch,
        servicePublicKey: this.blind.servicePublicKey, policyRevision: this.blind.policyRevision,
        ...(this.blind.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 as const } : {}) } };
  }

  sync(): Promise<void> {
    return this.enqueue(async () => {
      await withAutomationSpan(automationTelemetry(), "automation.replication.sync", {
        "workspace.id": this.workspaceId,
        "board.id": this.bindings.boardId,
        "operation.scope": "local-admission,serialization,transport,decrypt-merge,confirmation",
      }, async span => {
        this.assertActive();
        this.assertPersistence();
        if (this.progress.pending) {
          span?.setAttribute("replication.phase", "confirm-pending-upload");
          try { await this.engine.drainPending(); }
          catch (error) {
            await this.refreshRejectedCheckpointUpload(error, this.engine, phase => span?.setAttribute("replication.phase", phase));
          }
          await this.deliverPublicChanges(automationDiagnosticContext(span));
          return;
        }
        span?.setAttribute("replication.phase", "pull-decrypt-merge");
        await this.engine.pull();
        if (!this.tombstoned && this.controlForRuntime().state === "deleted") {
          this.tombstoned = true;
          await this.persistState();
        }
        span?.setAttribute("replication.phase", "local-admission-serialize-push");
        try { await this.engine.push(); }
        catch (error) {
          await this.refreshRejectedCheckpointUpload(error, this.engine, phase => span?.setAttribute("replication.phase", phase));
        }
        span?.setAttribute("replication.phase", "confirm-public-delivery");
        await this.deliverPublicChanges(automationDiagnosticContext(span));
      });
    });
  }

  private async refreshRejectedCheckpointUpload(error: unknown, engine: ReplicaEngine<Uint8Array, BlindObject, BlindReceipt>,
    setPhase: (phase: string) => void): Promise<void> {
    if (!isCheckpointGenerationRequired(error)) throw error;
    const rejected = this.progress.pending && structuredClone(this.progress.pending);
    if (!rejected) throw new Error("Rusty rejected an upload without a durable Worker outbox", { cause: error });

    // Keep exact bytes and request ID durable until the checkpoint snapshot is fully admitted.
    setPhase("refresh-checkpoint-generation");
    const caughtUp = await engine.pull();
    const current = this.progress.pending;
    if (!current || canonicalizeJson(current) !== canonicalizeJson(rejected)) {
      throw new Error("Worker outbox changed while admitting its checkpoint", { cause: error });
    }
    if (!caughtUp || this.progress.cursor <= (rejected.observedSequence ?? 0)) {
      throw new Error("Rusty checkpoint inventory is not fully admitted; retry synchronization", { cause: error });
    }

    const previous = this.progress;
    if (previous.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Worker replica generation is exhausted");
    const refreshed = structuredClone(previous);
    delete refreshed.pending;
    refreshed.generation += 1;
    this.progress = refreshed;
    try { await this.persistState(); }
    catch (persistError) { this.progress = previous; throw persistError; }

    // Rusty rejected the prior object before storage. Replace it only after admitting the newer frontier.
    setPhase("retry-after-checkpoint-generation");
    await engine.push();
  }

  createLead(eventId: string, normalized: NormalizedLead, decision: unknown, columnId = this.bindings.columns.lead): Promise<{ cardId: string; duplicate: boolean }> {
    normalized = structuredClone(normalized);
    decision = structuredClone(decision);
    return this.enqueue(async () => {
      this.assertActive();
      this.assertPersistence();
      await this.revalidate();
      this.assertExecuting();
      if (columnId !== this.bindings.columns.lead && columnId !== this.bindings.columns.applied) throw new Error("Initial application column is not approved");
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
          this.applied[eventId] = { kind: "lead", cardId, ...(normalized.messageIds ? { messageIds: [...normalized.messageIds] } : {}) };
          try { await this.persistState(); }
          catch (error) { this.applied = previousApplied; delete this.applied[eventId]; throw error; }
          return { cardId, duplicate: true };
        }
        const values = this.leadValues(normalized);
        const card = { id: cardId,
          parentId: columnId, title: `${requiredText(normalized.company, "company")} — ${requiredText(normalized.role, "role")}`,
          body: normalized.message?.slice(0, 8_000) ?? "", values };
        if (this.grant.payload.automation!.version === 2 && !normalized.source) throw new Error("Source capture context is required for intake v2");
        const command = this.grant.payload.automation!.version === 2
          ? { ...card, kind: "createItemWithApplicationSource" as const, data: await captureApplicationSource(this.workspaceId,
            cardId, eventId, normalized.source!.origin, normalized.source!.page, normalized.jobUrl,
            { messageIds: normalized.messageIds }) }
          : { ...card, kind: "createItem" as const };
        const result = await executeOwnedCommand(document, command, this.profile, actorIdForProfile(this.profile), await this.grantHash(),
          (purpose, binding) => this.executionSigningContext(purpose, binding));
        if (!result.ok) throw new Error(`Lead creation rejected: ${result.error.message}`);
        const previousRaw = this.rawDocument;
        const previousAuthorizations = this.authorizations;
        const previousApplied = this.applied;
        const previousHistoryUsage = this.historyUsage;
        this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, previousApplied);
        await this.acceptAuthoredDocument(document, result.value.newDoc, result.value.receipt.changeHash, result.value.receipt.beforeHeads);
        this.applied[eventId] = { kind: "lead", cardId, changeHash: result.value.receipt.changeHash, ...(normalized.messageIds ? { messageIds: [...normalized.messageIds] } : {}) };
        try { await this.persistState(); }
        catch (error) {
          this.rawDocument = previousRaw;
          this.authorizations = previousAuthorizations;
          this.applied = previousApplied;
          this.historyUsage = previousHistoryUsage;
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
      if (columnId !== this.bindings.columns.applied && columnId !== this.bindings.columns.interview && columnId !== this.bindings.columns.rejected) {
        throw new Error("Automation may move cards only to approved application columns");
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
        const result = await executeOwnedCommand(document, { kind: "moveEntity", entityId: cardId, parentId: columnId },
          this.profile, actorIdForProfile(this.profile), await this.grantHash(), (purpose, binding) => this.executionSigningContext(purpose, binding));
        if (!result.ok) throw new Error(`Application move rejected: ${result.error.message}`);
        const previousRaw = this.rawDocument;
        const previousAuthorizations = this.authorizations;
        const previousApplied = this.applied;
        const previousHistoryUsage = this.historyUsage;
        this.applied = Object.assign(Object.create(null) as Record<string, AppliedEvent>, previousApplied);
        await this.acceptAuthoredDocument(document, result.value.newDoc, result.value.receipt.changeHash, result.value.receipt.beforeHeads);
        this.applied[eventId] = { kind: "move", cardId, columnId, changeHash: result.value.receipt.changeHash };
        try { await this.persistState(); }
        catch (error) {
          this.rawDocument = previousRaw;
          this.authorizations = previousAuthorizations;
          this.applied = previousApplied;
          this.historyUsage = previousHistoryUsage;
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
      const messageIds = new Map(Object.values(this.applied).filter(event => event.kind === "lead" && event.messageIds?.length).map(event => [event.cardId, event.messageIds!]));
      const sources = new Map<string, ApplicationSourceData[]>();
      for (const entity of Object.values(document.entities)) {
        if (entity.kind !== "application_source") continue;
        const data = readApplicationSourceData(entity.data);
        sources.set(data.cardId, [...(sources.get(data.cardId) ?? []), data]);
      }
      return Object.values(document.entities).filter((entity): entity is Extract<WorkspaceDocumentV2["entities"][string], { body: string }> =>
        isItem(entity) && !entity.archivedAt && belongsToBoard(document, entity.id, this.bindings.boardId))
        .map(item => ({ cardId: item.id, title: item.title, company: stringValue(item.values[this.bindings.fieldIds.company]),
          role: stringValue(item.values[this.bindings.fieldIds.role]),
          ...(this.bindings.fieldIds.jobUrl && stringValue(item.values[this.bindings.fieldIds.jobUrl])
            ? { jobUrl: stringValue(item.values[this.bindings.fieldIds.jobUrl]) } : {}),
          ...(messageIds.has(item.id) ? { messageIds: [...messageIds.get(item.id)!] } : {}),
          columnId: workflowColumnId(document.entities, item.id) ?? item.placement.parentId ?? "",
          ...(itemWorkflow(item) ? { workflow: itemWorkflow(item) } : {}),
          ...(this.grant.payload.automation!.version === 2 || sources.has(item.id) ? { sources: sources.get(item.id) ?? [] } : {}),
        }));
    } finally { Automerge.free(document); }
  }

  employeeProfileForRuntime(): EmployeeProfile {
    const document = this.admittedDocument();
    try {
      const board = document.entities[this.bindings.boardId];
      const profile = hasEntityKind(board, "board") ? board.settings?.employee_profile : undefined;
      return profile && typeof profile === "object" && "stack" in profile && "work_profile" in profile
        && typeof profile.stack === "string" && typeof profile.work_profile === "string"
        ? { stack: profile.stack, work_profile: profile.work_profile } : emptyEmployeeProfile();
    } finally { Automerge.free(document); }
  }

  priorityBandsForRuntime(): Array<{ optionId: string; minScore: number }> | undefined {
    const document = this.admittedDocument();
    try {
      const board = document.entities[this.bindings.boardId];
      return hasEntityKind(board, "board") && board.priorityPolicy?.bands?.length
        ? board.priorityPolicy.bands.map(band => ({ ...band })) : undefined;
    } finally { Automerge.free(document); }
  }

  appliedForRuntime(eventId: string): AppliedEvent | undefined {
    return Object.hasOwn(this.applied, eventId) ? { ...this.applied[eventId]! } : undefined;
  }

  bindingsForRuntime(): AutomationGrantScope["columns"] { return { ...this.bindings.columns }; }

  async bindingScopeForRuntime(origin: string, cardId: string, sourceRecordId: string):
    Promise<Omit<ApplicationBindingExpected, "integrationId" | "eventId" | "eventHash" | "decisionHash">> {
    this.assertActive();
    const definition = this.definitionForRuntime();
    if (!definition) throw new Error("Application binding requires a signed automation definition");
    this.observationForRuntime(origin, crypto.randomUUID());
    const candidate = this.candidates().find(value => value.cardId === cardId);
    const source = candidate?.sources?.find(value => value.recordId === sourceRecordId);
    if (!candidate?.workflow || candidate.workflow.columnId !== candidate.columnId || !source ||
      source.workspaceId !== this.workspaceId || source.cardId !== cardId || source.observation.phase === "refresh") {
      throw new Error("Application binding requires a current card workflow and original source record");
    }
    return { ownerPersonId: this.authority.currentOwner.personId, origin, definitionId: definition.id,
      workspaceId: this.workspaceId, cardId, grantId: this.grant.payload.grantId,
      sourceRecordId, sourceHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(source))),
      accessEpoch: this.authority.currentEpoch, workflow: { ...candidate.workflow } };
  }

  /** Check historical signature against present admitted source, grant, workflow and owner-device authority. */
  async verifyApplicationBindingForRuntime(value: ApplicationBindingProof,
    event: Pick<ApplicationBindingExpected, "origin" | "integrationId" | "eventId" | "eventHash" | "decisionHash">): Promise<ApplicationBindingPayload> {
    const proof = parseApplicationBindingProof(value);
    const captured = { raw: this.rawDocument, authority: this.authority, grant: this.grant };
    const scope = await this.bindingScopeForRuntime(event.origin, proof.signed.payload.cardId, proof.signed.payload.sourceRecordId);
    const payload = await verifyApplicationBinding(proof, { ...scope, ...event });
    await this.verifyApplicationBindingOwnerForRuntime(proof);
    this.assertActive();
    if (captured.raw !== this.rawDocument || captured.authority !== this.authority || captured.grant !== this.grant) {
      throw new Error("Application binding authority changed during verification");
    }
    return payload;
  }

  /** Exact durable retries retain historical intent, but never bypass present owner-device revocation. */
  async verifyApplicationBindingOwnerForRuntime(value: ApplicationBindingProof): Promise<void> {
    const proof = parseApplicationBindingProof(value);
    const p = proof.signed.payload;
    const captured = { raw: this.rawDocument, authority: this.authority };
    await verifyApplicationBinding(proof, { ownerPersonId: captured.authority.currentOwner.personId,
      origin: p.origin, integrationId: p.integrationId, definitionId: p.definitionId, workspaceId: this.workspaceId,
      cardId: p.cardId, grantId: p.grantId, eventId: p.eventId, eventHash: p.eventHash, decisionHash: p.decisionHash,
      sourceRecordId: p.sourceRecordId, sourceHash: p.sourceHash, accessEpoch: p.accessEpoch, workflow: p.workflow });
    this.assertOwnerDeviceForRuntime({ personId: p.personId, publicKey: proof.publicKey, certificates: proof.certificates }, p.deviceId);
    if (captured.raw !== this.rawDocument || captured.authority !== this.authority) {
      throw new Error("Application binding authority changed during verification");
    }
  }

  /** Callers authenticate their signed request first; this evaluates present rights against the actual replica. */
  assertOwnerDeviceForRuntime(identity: WorkspaceWriteAuthorityEvidence["currentOwner"], deviceId: string): void {
    if (this.deviceRoleForRuntime(identity, deviceId) !== "owner") {
      throw new Error("This action requires a currently authorized owner device");
    }
  }

  private deviceRoleForRuntime(identity: WorkspaceWriteAuthorityEvidence["currentOwner"], deviceId: string, grant?: WorkspaceGrant) {
    const authority = this.authority, now = Date.now();
    const key = canonicalizeJson([identity.personId, identity.publicKey, deviceId,
      identity.certificates.map(value => canonicalizeJson(value)).sort()]);
    const cached = this.deviceAccessCache.get(key);
    const expiresAt = grant?.payload.automation?.expiresAt ?? Infinity;
    if (cached && cached.raw === this.rawDocument && cached.authority === authority && cached.grant === grant &&
      cached.checkedAt <= now && now < expiresAt) return cached.role;
    const role = WasmStateCore.decideWorkspaceAccess({ snapshot: { workspaceId: this.workspaceId,
      genesisOwner: authority.genesisOwner, genesisEpoch: authority.genesisEpoch, expectedCurrentOwner: authority.currentOwner,
      document: Array.from(decodeBlindBytes(this.rawDocument)), ownershipTransfers: authority.ownershipTransfers,
      successionClaims: authority.successionClaims, revocations: authority.revocations,
      deviceRevocations: authority.deviceRevocations, departures: authority.departures },
    identity, deviceId, grant, departures: authority.departures, legacyAuthorityEvidence: [] }, now);
    this.deviceAccessCache.set(key, { raw: this.rawDocument, authority, grant, checkedAt: now, role });
    if (this.deviceAccessCache.size > 16) this.deviceAccessCache.delete(this.deviceAccessCache.keys().next().value!);
    return role;
  }

  /** Observation signatures use complete certificate evidence and current admitted device authority. */
  async signObservationForRuntime(origin: string, nonce: string): Promise<AutomationObservationProof> {
    const captured = { raw: this.rawDocument, authority: this.authority, grant: this.grant };
    const payload = this.observationForRuntime(origin, nonce);
    const revision = canonicalizeJson([this.grant.signature, this.authority.currentEpoch, payload.state, payload.heads]);
    const context = await resolveSigningContext({ profile: this.profile, certificates: [this.profile.certificate],
      purpose: payload.kind, binding: { origin, nonce, workspaceId: this.workspaceId, integrationId: payload.integrationId,
        grantId: payload.grantId }, authorityRevision: revision, expiresAt: this.grant.payload.automation!.expiresAt,
      current: async () => {
        this.assertActive();
        if (captured.raw !== this.rawDocument || captured.authority !== this.authority || captured.grant !== this.grant) {
          throw new Error("Automation observation authority changed during signing");
        }
        const role = this.deviceRoleForRuntime({ personId: this.profile.identity.personId,
          publicKey: this.profile.identity.publicKey, certificates: [this.profile.certificate] }, this.profile.device.deviceId, this.grant);
        if (role !== "automation") throw new Error("Automation observation requires its currently authorized device");
        return { personId: this.profile.identity.personId, deviceId: this.profile.device.deviceId, authorityRevision: revision };
      } });
    const evidence = signingEvidence(context);
    return parseAutomationObservationProof({ publicKey: evidence.identity.publicKey, certificates: evidence.certificates,
      signed: await signWithContext(context, payload) });
  }

  reviewIdentityForRuntime(origin: string, workspaceId: string, definitionId: string) {
    if (workspaceId !== this.workspaceId || this.definitionForRuntime()?.id !== definitionId) return null;
    this.observationForRuntime(origin, crypto.randomUUID());
    return { personId: this.profile.identity.personId, definitionId };
  }

  async reviewPageForRuntime(offset: number) {
    const captured = this.rawDocument;
    const choices = this.candidates().sort((left, right) => left.cardId.localeCompare(right.cardId))
      .flatMap<{ candidate: AutomationCandidate; source: ApplicationSourceData | undefined }>(candidate => {
      const originals = candidate.sources?.filter(source => source.observation.phase !== "refresh")
        .sort((left, right) => left.recordId.localeCompare(right.recordId)) ?? [];
      return originals.length ? originals.map(source => ({ candidate, source })) : [{ candidate, source: undefined }];
    });
    if (offset > choices.length) throw new Error("Application list changed; restart review");
    const options: ApplicationReviewOption[] = await Promise.all(choices.slice(offset, offset + 20).map(async ({ candidate, source }) => {
      const observation = source?.observation;
      return { cardId: candidate.cardId, displayTitle: (candidate.title ?? `${candidate.company} — ${candidate.role}`).slice(0, 256),
        sourceRecordId: source?.recordId ?? null,
        sourceHash: source ? await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(source))) : null,
        sourceTitle: observation?.status === "available" ? observation.title.slice(0, 256) : null,
        sourceCompany: observation?.status === "available" ? observation.company.slice(0, 128) : null,
        sourceStatus: observation?.status ?? null, workflow: candidate.workflow ?? null };
    }));
    if (captured !== this.rawDocument) throw new Error("Application list changed during review");
    return { options, offset, total: choices.length, hasMore: offset + options.length < choices.length,
      grantId: this.grant.payload.grantId, accessEpoch: this.authority.currentEpoch,
      automationState: this.controlForRuntime().state };
  }

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
    const sources = this.definitionForRuntime()?.parameters.sources;
    return this.controlForRuntime().state === "active" && (sources === undefined || Array.isArray(sources) && sources.includes(source));
  }

  serialize(): string {
    return JSON.stringify({ version: 6,
      workspaceId: this.workspaceId, blind: { ...this.blind, cursor: this.cursor, lastUploaded: this.lastUploaded },
      ...(this.history ? { history: this.history } : {}), ...(this.scopeAuthoritySnapshot ? { scopeAuthoritySnapshot: this.scopeAuthoritySnapshot } : {}),
      historyUsage: this.historyUsage,
      grant: this.grant, ...(this.definition ? { definition: this.definition } : {}), bindings: this.bindings, authority: this.authority, rawDocument: this.rawDocument,
      authorizations: this.authorizations, chat: this.chat, ...(this.tombstoned ? { tombstoned: true as const } : {}),
      ...(this.attachments.length ? { attachments: this.attachments } : {}),
      ...(this.pending ? { pending: this.pending } : {}), ...(this.publicDelivery ? { publicDelivery: this.publicDelivery } : {}),
      replication: this.replicationMetadata(), applied: this.applied } satisfies SerializedReplica);
  }

  private async deliverPublicChanges(diagnosticContext?: Context): Promise<void> {
    if (!this.transport.publicDelivery || this.tombstoned || this.controlForRuntime().state !== "active") return;
    const document = this.admittedDocument();
    const sourceHeads = Automerge.getHeads(document).sort();
    const captured = { raw: this.rawDocument, authority: this.authority, grant: this.grant };
    const ensureCurrent = async () => {
      this.assertActive(); this.assertExecuting();
      if (captured.raw !== this.rawDocument || captured.authority !== this.authority || captured.grant !== this.grant ||
        this.deviceRoleForRuntime({ personId: this.profile.identity.personId, publicKey: this.profile.identity.publicKey,
          certificates: [this.profile.certificate] }, this.profile.device.deviceId, this.grant) !== "automation") {
        throw new Error("Public delivery authority changed");
      }
    };
    try {
      // The admitted document itself is durable; this marker records an unconfirmed delivery across restarts.
      this.publicDelivery = { pending: true, sourceHeads };
      await this.persistState();
      await this.transport.publicDelivery({ origin: this.blind.origin, workspaceId: this.workspaceId, boardId: this.bindings.boardId,
        identity: this.profile.identity, deviceId: this.profile.device.deviceId, certificates: [this.profile.certificate],
        grant: this.grant, sourceHeads, ensureCurrent, diagnosticContext,
        ensureSourceCovers: async heads => {
          const missing = heads.filter(head => !Automerge.hasHeads(document, [head]));
          if (!missing.length) return;
          if (!this.historyBasis) throw new Error("Synchronize this board before public delivery");
          await assertWorkerHistoryCoversHeads(this.historyBasis, missing, this.blind, this.archiveReader(ensureCurrent), ensureCurrent);
        },
        sign: async payload => {
          const context = await this.executionSigningContext("rusty-publication-command", {
            boardId: payload.boardId, challengeId: payload.challengeId, projectionHash: payload.projectionHash });
          return signWithContext(context, payload);
        },
        buildProjection: current => automationPublicProjection(document, this.workspaceId, this.bindings.boardId, current) });
      await ensureCurrent();
      this.publicDelivery = { pending: false, sourceHeads };
      await this.persistState();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Public delivery unavailable";
      recordAutomationException(cause, { event: "automation.public_delivery.failed", operation: "public-board-delivery",
        "workspace.id": this.workspaceId, "board.id": this.bindings.boardId });
      this.publicDelivery = { pending: true, sourceHeads, error };
      await this.persistState();
      console.error(JSON.stringify({ event: "automation.public-delivery-failed", workspaceId: this.workspaceId, error: "delivery failed; inspect OpenTelemetry exception details" }));
    } finally { Automerge.free(document); }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.running.then(action, action);
    this.running = next.then(() => undefined, () => undefined);
    return next;
  }

  private get cursor(): number { return this.progress.cursor; }
  private set cursor(value: number) { this.progress.cursor = value; }
  private get lastUploaded(): string { return this.progress.lastUploaded; }
  private set lastUploaded(value: string) { this.progress.lastUploaded = value; }
  private get pending(): PendingUpload | undefined { return this.progress.pending; }
  private set pending(value: PendingUpload | undefined) {
    if (!value) { delete this.progress.pending; return; }
    this.progress.pending = { ...value, requestId: value.requestId ?? crypto.randomUUID(),
      bytes: value.bytes ?? decodeBlindBytes(value.object.ciphertext).length - 16 };
  }

  private replicationMetadata(): ReplicaMetadata {
    const { version, binding, generation, uploadedRevision, contentIdentity } = this.progress;
    return { version, binding, generation, ...(uploadedRevision === undefined ? {} : { uploadedRevision }),
      ...(contentIdentity === undefined ? {} : { contentIdentity }), contentRevision: this.contentRevision };
  }

  private storageBinding(): string {
    return automationStorageBinding(this.workspaceId, this.blind);
  }

  private createEngine(managementGuard?: () => Promise<void>): ReplicaEngine<Uint8Array, BlindObject, BlindReceipt> {
    return new ReplicaEngine(this.progress.binding, {
      repository: {
        read: async () => this.progress,
        commit: async (expected, next) => {
          if (this.progress.generation !== expected) throw new Error("Replica progress changed during persistence");
          const previous = this.progress;
          this.progress = structuredClone(next);
          try { await this.persistState(); }
          catch (error) { this.progress = previous; throw error; }
        },
      },
      content: {
        revision: async () => this.contentRevision,
        capture: () => this.captureSnapshot(Boolean(managementGuard)),
        seal: plaintext => encryptBlindObject(this.blind.scopeId, this.blind.keyEpoch, decodeBlindBytes(this.blind.contentKey), plaintext),
      },
      transport: {
        inventory: cursor => this.transport.inventory({ ...this.blind }, cursor),
        download: id => this.transport.download({ ...this.blind }, id),
        upload: (object, requestId, observedSequence) => this.transport.upload({ ...this.blind }, object, requestId, observedSequence),
      },
      admit: object => this.receiveSnapshot(object, managementGuard),
      verifyReceipt: async (receipt, object, requestId) => {
        await verifyBlindReceipt(receipt, this.blind, object, requestId);
        // A retry may deliver an older snapshot before publishing newer local commands.
        // Only the exact current captured revision can attest to the current event map.
        const included = this.progress.pending?.revision === this.contentRevision ? this.applied : {};
        await this.transport.receiptVerified?.(receipt, object, requestId, included);
      },
      guard: async () => {
        if (managementGuard) await managementGuard();
        else this.assertActive();
        this.assertPersistence();
        if (this.storageBinding() !== this.progress.binding) throw new Error("Rusty credential binding changed during replication");
      },
    });
  }

  private archiveReader(guard: () => void | Promise<void>): HistoryBaselineFetchPort {
    if (this.transport.archive) return this.transport.archive({ ...this.blind }, guard);
    const remote = createArchiveRemote({ ...this.blind }, { fetch, ensureCurrent: guard });
    return { download: id => remote.download(id), ensureCurrent: guard };
  }

  private wireSnapshot(): WireSnapshot {
    return { version: this.history ? 2 : 1, workspaceId: this.workspaceId, document: this.rawDocument,
      ...(this.history ? { history: this.history.wire } : {}),
      authorization: { version: 1, records: normalizeWireAuthorizations(this.authorizations), authority: this.authority }, chat: this.chat,
      ...(this.attachments.length ? { attachments: this.attachments } : {}) };
  }

  private async captureSnapshot(management = false) {
    const admission = management ? this.admission() : await this.revalidate();
    if (admission.quarantinedHashes.length || admission.pendingHashes.length) throw new Error("Unadmitted workspace changes prevent replica upload");
    const plaintext = new TextEncoder().encode(canonicalizeJson(this.wireSnapshot()));
    if (plaintext.length > maximumSnapshotBytes) throw new Error("Automation snapshot exceeds the Rusty object limit");
    return { hash: await blindHash(plaintext), bytes: plaintext.length, payload: plaintext };
  }

  private replaceEvidence(rawDocument: string, authorizations: WorkspaceChangeAuthorization[],
    authority: WorkspaceWriteAuthorityEvidence, chat: OpaqueChatBatch | null = this.chat,
    attachments: AttachmentLocator[] = this.attachments): void {
    if (rawDocument === this.rawDocument && authorizations === this.authorizations && authority === this.authority && chat === this.chat &&
      sameAttachmentLocators(attachments, this.attachments)) return;
    this.rawDocument = rawDocument;
    this.authorizations = authorizations;
    this.authority = authority;
    this.chat = chat;
    this.attachments = parseAttachmentLocators(attachments);
    this.contentRevision = crypto.randomUUID();
    this.admissionCache = undefined;
  }

  private async receiveSnapshot(object: BlindObject, managementGuard?: () => Promise<void>): Promise<{ hash: string }> {
    const plaintext = await openWithReplicaContentKeys(this.blind, object.keyEpoch,
      key => decryptBlindObject(object, this.blind.scopeId, object.keyEpoch, decodeBlindBytes(key)));
    if (plaintext.length > maximumSnapshotBytes) throw new Error("Encrypted automation snapshot exceeds the size limit");
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as WireSnapshot;
    if ((snapshot.version !== 1 && snapshot.version !== 2) || (snapshot.version === 2) !== Boolean(snapshot.history) ||
      snapshot.workspaceId !== this.workspaceId || typeof snapshot.document !== "string" || !snapshot.authorization) throw new Error("Encrypted snapshot is invalid");
    if (this.history && !snapshot.history) throw new Error("A compact Worker requires the verified history descriptor; original source retained");
    const revision = this.contentRevision;
    const ensureCurrent = () => {
      if (revision !== this.contentRevision) throw new Error("Worker content changed during history receive");
      if (!managementGuard) this.assertActive();
    };
    const guard = async () => { ensureCurrent(); if (managementGuard) await managementGuard(); ensureCurrent(); };
    const nextChat = mergeOpaqueChat(this.chat, parseOpaqueChat(snapshot.chat));
    const nextAttachments = mergeAttachmentLocators(this.attachments, snapshot.attachments);
    const incoming = decodeBlindBytes(snapshot.document), local = decodeBlindBytes(this.rawDocument);
    let nextHistory = this.history, nextBasis = this.historyBasis, switching = false;
    if (snapshot.history && canonicalizeJson(parseWireHistoryBaseline(snapshot.history)) !== canonicalizeJson(this.history?.wire ?? null)) {
      if (!this.scopeAuthoritySnapshot) throw new Error("Worker history requires an admitted signed scope authority");
      if (this.progress.pending) throw new Error("Confirm the exact original Worker outbox before switching history basis");
      const reader = this.archiveReader(guard);
      const received = await receiveWorkerHistoryBasis({ wire: snapshot.history, workspaceId: this.workspaceId, config: this.blind,
        trustedScopeAuthority: this.scopeAuthoritySnapshot, previous: this.historyBasis, fetch: reader, guard, ensureCurrent });
      try {
        const document = Automerge.load<WorkspaceDocumentV2>(local);
        try { await assertWorkerHistoryCoversHeads(received.basis, Automerge.getHeads(document), this.blind, reader, guard); }
        finally { Automerge.free(document); }
      } catch (error) { received.basis.free(); throw error; }
      nextHistory = received.stored; nextBasis = received.basis; switching = true;
    }
    const merged = switching ? incoming : mergeDocuments(local, incoming, actorIdForProfile(this.profile));
    const bundle = switching ? snapshot.authorization : normalizeBundle(snapshot.authorization, this.authorizations);
    const authority = nextBasis ? mergeAuthority(bundle.authority, this.authority) : prepareAuthority(bundle.authority, this.authority, merged, this.workspaceId);
    let admission: WorkspaceAdmissionResult;
    try {
      admission = computeWorkspaceAdmission({ workspaceId: this.workspaceId, remote: merged,
        authorization: { ...bundle, authority }, knownAuthority: this.authority, receivedBasis: nextBasis, now: Date.now() }, WasmStateCore as never);
      if (switching) assertFullyAdmitted(admission, merged);
    } catch (error) { if (switching) nextBasis?.free(); throw error; }
    let nextHistoryUsage = this.historyUsage;
    const mergedDocument = Automerge.load<WorkspaceDocumentV2>(merged);
    try {
      const previousDocument = Automerge.load<WorkspaceDocumentV2>(local);
      try {
        const admitted = new Set(admission.admittedHashes);
        if (switching && nextBasis) {
          const baselineDocument = Automerge.load<WorkspaceDocumentV2>(nextBasis.document());
          try {
            const tail = Automerge.getChanges(baselineDocument, mergedDocument)
              .filter(change => admitted.has(Automerge.decodeChange(change).hash));
            nextHistoryUsage = receivedHistoryUsage({ baselineId: historyBaselineId(nextHistory!.wire),
              admittedChanges: 0, encodedBytes: 0 }, tail);
          } finally { Automerge.free(baselineDocument); }
        } else {
          const tail = Automerge.getChanges(previousDocument, mergedDocument)
            .filter(change => admitted.has(Automerge.decodeChange(change).hash));
          nextHistoryUsage = receivedHistoryUsage(this.historyUsage, tail);
        }
      } finally { Automerge.free(previousDocument); }
    } catch (error) { if (switching) nextBasis?.free(); throw error; }
    finally { Automerge.free(mergedDocument); }
    const previous = { authority: this.authority, authorizations: this.authorizations, rawDocument: this.rawDocument,
      chat: this.chat, attachments: this.attachments, history: this.history, basis: this.historyBasis, historyUsage: this.historyUsage };
    this.history = nextHistory; this.historyBasis = nextBasis;
    this.historyUsage = nextHistoryUsage;
    this.replaceEvidence(encodeBlindBytes(merged), switching ? admission.verifiedAuthorizations : mergeAuthorizationRecords(this.authorizations, admission.verifiedAuthorizations),
      authority, nextChat, nextAttachments);
    try { await this.persistState(); }
    catch (error) {
      this.history = previous.history; this.historyBasis = previous.basis;
      this.historyUsage = previous.historyUsage;
      this.replaceEvidence(previous.rawDocument, previous.authorizations, previous.authority, previous.chat, previous.attachments);
      if (switching) nextBasis?.free();
      throw error;
    }
    if (switching) previous.basis?.free();
    return { hash: await blindHash(new TextEncoder().encode(canonicalizeJson(snapshot))) };
  }

  private async validateStoredProgress(): Promise<void> {
    const snapshot = this.wireSnapshot();
    const plaintext = new TextEncoder().encode(canonicalizeJson(snapshot));
    const hash = await blindHash(plaintext);
    if (this.progress.uploadedRevision === this.contentRevision && this.progress.lastUploaded !== hash) {
      delete this.progress.uploadedRevision;
    }
    const pending = this.progress.pending;
    if (pending && pending.revision === undefined) {
      const previousBytes = await openWithReplicaContentKeys(this.blind, pending.object.keyEpoch,
        key => decryptBlindObject(pending.object, this.blind.scopeId, pending.object.keyEpoch, decodeBlindBytes(key)));
      const previous = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(previousBytes)) as WireSnapshot;
      if (previous.authorization?.version !== 1 || !Array.isArray(previous.authorization.records)) return;
      const normalized = { ...previous, authorization: { ...previous.authorization,
        records: normalizeWireAuthorizations(previous.authorization.records as WorkspaceChangeAuthorization[]) } };
      if (canonicalizeJson(normalized) === canonicalizeJson(snapshot)) {
        this.progress.pending = { ...pending, hash, revision: this.contentRevision };
      }
    }
  }

  private async revalidate() {
    this.assertActive();
    return this.admission();
  }

  private admission(document?: Automerge.Doc<WorkspaceDocumentV2>): WorkspaceAdmissionResult {
    // Historical admission ignores receiver time. Live grant expiry is checked
    // separately; every document, proof or authority change invalidates this cache.
    const cached = this.admissionCache;
    if (cached?.rawDocument === this.rawDocument && cached.authorizations === this.authorizations && cached.authority === this.authority) return cached.result;
    const input = { workspaceId: this.workspaceId,
      authorization: { version: 1, records: this.authorizations, authority: this.authority },
      knownAuthority: this.authority, receivedBasis: this.historyBasis, now: Date.now() } as const;
    const result = document
      ? computeWorkspaceDocumentAdmission(input, WasmStateCore as never, document)
      : computeWorkspaceAdmission({ ...input, remote: decodeBlindBytes(this.rawDocument) }, WasmStateCore as never);
    this.admissionCache = { rawDocument: this.rawDocument, authorizations: this.authorizations, authority: this.authority, result };
    return result;
  }

  private admittedDocument(): Automerge.Doc<WorkspaceDocumentV2> {
    this.assertActive();
    const bytes = decodeBlindBytes(this.rawDocument);
    const document = Automerge.load<WorkspaceDocumentV2>(bytes, { actor: actorIdForProfile(this.profile) });
    try {
      const admission = this.admission(document);
      assertFullyAdmitted(admission, bytes);
      return document;
    } catch (error) { Automerge.free(document); throw error; }
  }

  private async acceptAuthoredDocument(previousDocument: Automerge.Doc<WorkspaceDocumentV2>, document: Automerge.Doc<WorkspaceDocumentV2>,
    changeHash: string, beforeHeads: string[]): Promise<void> {
    const newChanges = Automerge.getChangesMetaSince(document, beforeHeads);
    if (newChanges.length !== 1 || newChanges[0]!.hash !== changeHash) {
      throw new Error("Automation authoring produced unexpected Automerge history");
    }
    const authoredBytes = Automerge.getChanges(previousDocument, document);
    if (authoredBytes.length !== 1 || Automerge.decodeChange(authoredBytes[0]!).hash !== changeHash) {
      throw new Error("Automation authoring produced unexpected active history bytes");
    }
    const nextUsage = ensureHistoryBudget(this.historyUsage, authoredBytes);
    const context = await this.executionSigningContext("workspace-changes", { workspaceId: this.workspaceId,
      personId: this.profile.identity.personId, deviceId: this.profile.device.deviceId });
    const evidence = signingEvidence(context);
    const signed = await signWithContext(context, {
      kind: "workspace-changes" as const, version: 1 as const, workspaceId: this.workspaceId,
      hashes: [changeHash], personId: this.profile.identity.personId, deviceId: this.profile.device.deviceId,
    });
    const nextAuthorizations = mergeAuthorizationRecords(this.authorizations, [{ signed,
      publicKey: evidence.identity.publicKey, certificates: evidence.certificates, grant: this.grant,
      ownerPublicKey: this.authority.currentOwner.publicKey,
      ownerCertificates: this.authority.currentOwner.certificates }]);
    const candidateRaw = encodeBlindBytes(Automerge.save(document));
    const result = computeWorkspaceDocumentAdmission({ workspaceId: this.workspaceId,
      authorization: { version: 1, records: nextAuthorizations, authority: this.authority },
      knownAuthority: this.authority, receivedBasis: this.historyBasis, now: Date.now() }, WasmStateCore as never, document);
    if (result.quarantinedHashes.includes(changeHash) || result.pendingHashes.includes(changeHash) || !result.admittedHashes.includes(changeHash)) {
      const decision = result.decisions.find(value => value.hash === changeHash);
      throw new Error(`Rust rejected the scoped automation change: ${JSON.stringify(decision?.status ?? "missing-admission")}`);
    }
    this.replaceEvidence(candidateRaw, nextAuthorizations, this.authority);
    this.historyUsage = nextUsage;
    this.admissionCache = { rawDocument: this.rawDocument, authorizations: this.authorizations, authority: this.authority, result };
  }

  /** Worker signs under its own admitted Automation authority, without consulting any browser-local identity store. */
  private executionSigningContext(purpose: string, binding: Record<string, string | number>) {
    const captured = { raw: this.rawDocument, authority: this.authority, grant: this.grant, revision: this.contentRevision,
      key: this.profile.privateKeys.devicePrivateKey, certificate: canonicalizeJson(this.profile.certificate) };
    return resolveSigningContext({ profile: this.profile, certificates: [this.profile.certificate], purpose, binding,
      authorityRevision: captured.revision, expiresAt: this.grant.payload.automation!.expiresAt, current: async () => {
        this.assertActive(); this.assertExecuting();
        if (captured.raw !== this.rawDocument || captured.authority !== this.authority || captured.grant !== this.grant ||
          captured.revision !== this.contentRevision || captured.key !== this.profile.privateKeys.devicePrivateKey ||
          captured.certificate !== canonicalizeJson(this.profile.certificate) ||
          this.deviceRoleForRuntime({ personId: this.profile.identity.personId, publicKey: this.profile.identity.publicKey,
            certificates: [this.profile.certificate] }, this.profile.device.deviceId, this.grant) !== "automation") {
          throw new Error("Automation signing authority changed during authoring");
        }
        return { personId: this.profile.identity.personId, deviceId: this.profile.device.deviceId, authorityRevision: captured.revision };
      } });
  }
  private leadValues(normalized: NormalizedLead): Record<string, string> {
    const scope = this.grant.payload.automation!;
    const values: Record<string, string> = {
      [this.bindings.fieldIds.company]: requiredText(normalized.company, "company"),
      [this.bindings.fieldIds.role]: requiredText(normalized.role, "role"),
    };
    if (normalized.jobUrl) values[this.bindings.fieldIds.jobUrl] = normalized.jobUrl.slice(0, 2048);
    if (this.bindings.fieldIds.roleType && normalized.roleType) values[this.bindings.fieldIds.roleType] = normalized.roleType.slice(0, 256);
    if (this.bindings.fieldIds.seniority && normalized.seniority) values[this.bindings.fieldIds.seniority] = normalized.seniority.slice(0, 256);
    if (this.bindings.fieldIds.notes && normalized.message) values[this.bindings.fieldIds.notes] = normalized.message.slice(0, 8_000);
    if (this.bindings.fieldIds.sourceText && normalized.sourceText !== undefined) values[this.bindings.fieldIds.sourceText] = normalized.sourceText;
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
  parseReplicaContentKeys(packet.blind);
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
  if (grant.payload.automation!.version === 2 && !packet.definition) throw new Error("Source scope v2 requires its signed type contract");
  if (packet.definition) await validateDefinitionProof(packet.definition, packet.workspaceId, grant, owner);
  return packet.initial.history ? mergeAuthority(authority, null) : prepareAuthority(authority, null, decodeBlindBytes(packet.initial.document), packet.workspaceId);
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

async function restoreSerializedHistory(value: SerializedReplica, ensureCurrent: () => void): Promise<WasmVerifiedReceivedHistoryBaseline | undefined> {
  if (!value.history) return undefined;
  const anchor = validateWorkerHistoryAuthority(value.scopeAuthoritySnapshot, value.workspaceId);
  return restoreWorkerHistoryBasis(value.history, value.workspaceId, value.blind, anchor, ensureCurrent, ensureCurrent);
}

async function validateSerialized(value: SerializedReplica, profile: LocalProfile,
  purpose: "restore" | "renewal" | "management" = "restore", receivedBasis?: WasmVerifiedReceivedHistoryBaseline): Promise<WorkspaceAdmissionResult | undefined> {
  if (!value || ![1, 2, 3, 4, 5, 6].includes(value.version) || value.workspaceId !== value.blind?.workspaceId ||
    value.grant?.payload?.role !== "automation" || value.grant.payload.personId !== profile.identity.personId ||
    !value.rawDocument || !Array.isArray(value.authorizations) || !value.authority || !value.applied || typeof value.applied !== "object") {
    throw new Error("Serialized automation replica is invalid");
  }
  const keys = parseReplicaContentKeys(value.blind);
  if (value.history ? value.version !== 5 && value.version !== 6 : value.version === 5 || (keys.historicalContentKeyVariants ? value.version !== 4 && value.version !== 6 : value.version === 4 || (value.version === 3) !== Boolean(keys.historicalContentKeys) && value.version !== 6)) {
    throw new Error("Worker key history requires its complete compatible reader version");
  }
  const baselineId = value.history ? historyBaselineId(value.history.wire) : null;
  if (value.version === 6 ? !parseActiveHistoryUsage(value.historyUsage, baselineId) : value.historyUsage !== undefined) {
    throw new Error("Worker active history progress requires a compatible reader version");
  }
  if (value.version === 2 && !value.definition || value.version === 1 && value.definition ||
    value.tombstoned !== undefined && value.tombstoned !== true) throw new Error("Serialized automation contract version is invalid");
  if (value.grant.payload.automation?.version === 2 && !value.definition) throw new Error("Serialized source scope v2 requires its signed type contract");
  validateBindings(value.bindings, value.grant.payload.automation);
  if (value.blind.cursor < 0 || !Number.isSafeInteger(value.blind.cursor) ||
    (value.blind.lastUploaded !== "" && !/^[A-Za-z0-9_-]{43}$/.test(value.blind.lastUploaded)) ||
    value.blind.workspaceId !== value.workspaceId || value.blind.keyEpoch < 1) {
    throw new Error("Serialized blind replica configuration is invalid");
  }
  let admission: WorkspaceAdmissionResult | undefined;
  let owner = value.authority.currentOwner;
  if (purpose !== "restore") {
    const epoch = value.grant.payload.accessEpoch;
    if (typeof epoch !== "number") throw new Error("Serialized automation grant epoch is missing");
    const history = admitHistoricalAutomationAuthority({ workspaceId: value.workspaceId, epoch, bytes: decodeBlindBytes(value.rawDocument),
      authorization: { version: 1, records: value.authorizations, authority: value.authority }, receivedBasis });
    admission = history.admission;
    owner = history.issuer;
  }
  if (!owner?.personId || !owner.publicKey || await publicKeyId(owner.publicKey) !== owner.personId ||
    purpose === "restore" && value.grant.payload.accessEpoch !== value.authority.currentEpoch ||
    purpose === "restore" && value.grant.payload.automation!.expiresAt <= Date.now()) {
    throw new Error("Serialized automation authority is invalid or expired");
  }
  const role = WasmStateCore.verifyWorkspaceGrant(value.grant, value.workspaceId, profile.identity.personId, {
    personId: owner.personId, publicKey: owner.publicKey, certificates: owner.certificates,
  });
  if (role !== "automation") throw new Error("Serialized automation grant is not owner-authorized");
  if (value.definition) await validateDefinitionProof(value.definition, value.workspaceId, value.grant, owner);
  return admission;
}

async function validateDefinitionProof(definition: SignedEnvelope<AutomationDefinition>, workspaceId: string,
  grant: WorkspaceGrant, owner: WorkspaceWriteAuthorityEvidence["currentOwner"]): Promise<void> {
  if (definition.payload.typeVersion !== grant.payload.automation!.version) throw new Error("Automation definition version does not match its grant");
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

function mergeAuthority(incoming: WorkspaceWriteAuthorityEvidence, known: WorkspaceWriteAuthorityEvidence | null): WorkspaceWriteAuthorityEvidence {
  return WasmStateCore.prepareWriteEvidence({ incoming, known, records: [], genesisPersonId: incoming.genesisOwner.personId,
    remoteOwnerPersonId: incoming.currentOwner.personId }) as WorkspaceWriteAuthorityEvidence;
}

function normalizeBundle(bundle: IncomingAuthorizationBundle, records: WorkspaceChangeAuthorization[]): IncomingAuthorizationBundle {
  const flattened = bundle.version === 1 ? bundle.records : bundle.pages.flat();
  return { version: 1, records: mergeAuthorizationRecords(records, flattened as WorkspaceChangeAuthorization[]), authority: bundle.authority };
}

function normalizeWireAuthorizations(records: WorkspaceChangeAuthorization[]): WorkspaceChangeAuthorization[] {
  return records.map(({ grant, ...record }) => grant ? { ...record, grant } : record);
}

function sameAttachmentLocators(left: AttachmentLocator[], right: AttachmentLocator[]): boolean {
  return left.length === right.length && left.every((locator, index) => locator.blobId === right[index]?.blobId &&
    locator.transferId === right[index]?.transferId && locator.manifestId === right[index]?.manifestId);
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
  try { return Automerge.save(Automerge.loadIncremental(left, rightBytes)); }
  finally { Automerge.free(left); }
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

function isCheckpointGenerationRequired(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "checkpoint_generation_required" && "status" in error && error.status === 409;
}
