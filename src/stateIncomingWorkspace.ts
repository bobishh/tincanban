import * as Automerge from "@automerge/automerge/slim"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { canonicalizeJson, type LocalProfile } from "./domain/identity"
import { assertWorkspaceCapability } from "./domain/permissions"
import { hasEntityKind, validateWorkspaceDoc, type WorkspaceDocumentV2 } from "./domain/model"
import { planWorkspaceMigration } from "./domain/workspaceMigration"
import type { WorkspaceChangeAuthorization } from "./product-replica"
import { receivedHistoryBasisIdentity } from "./product-replica/receivedHistoryBasisIdentity"
import { stateRuntime } from "./stateContext"
import { sameWorkspaceHeads } from "./stateCausalAdmission"
import { reusableDeltaAdmission } from "./stateDeltaAdmission"
import type { IncomingPacket } from "./stateIncomingPacketCache"
import { fullyVerifiedIncomingInput, type VerifiedIncomingAdmission } from "./stateIncomingReuseEquality"
import { publishCommittedWorkspace, refreshAvailableWorkspaces, refreshCausalReview } from "./statePersistence"
import { addWorkspaceToPersonalRoot, requireProfile, switchWorkspace } from "./stateWorkspaceActions"
import { defaultStorage, type WorkspaceStorage, type WorkspaceTransactionContext } from "./storage"
import type { StoredCausalEvidence } from "./storageJournal"
import { durableAdmittedFrontierCredential, evaluateIncomingWorkspaceAdmission, exportAuthorizationBundle, localWorkspaceAdmissionAuthority, workspaceRole } from "./sync/changeAuthorization"
import { meshTrace } from "./sync/meshTrace"
import type { ReceivedWorkspaceCommit } from "./sync/workspaceSet"
import { packetMatchingVerifiedAuthority } from "./sync/authorityFingerprint"
import { hasOnlyStoredAdmissionProofs } from "./sync/workspaceAdmissionCheckpoint"
import type { WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"

export async function mergeAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage = defaultStorage,
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline,
  ensureCurrent?: () => Promise<void>,
): Promise<void> {
  const committed = await commitReceivedWorkspace(id, bytes, authorization, storage, receivedBasis, ensureCurrent)
  if (committed.phase === "unadmitted") throw committed.cause
}

export async function commitReceivedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage = defaultStorage,
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline,
  ensureCurrent?: () => Promise<void>,
): Promise<ReceivedWorkspaceCommit> {
  return storage.withWorkspaceTransaction(id, transaction =>
    commitCapturedWorkspace(id, bytes, authorization, storage, receivedBasis, transaction, ensureCurrent))
}

async function commitCapturedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage: WorkspaceStorage,
  receivedBasis: WasmVerifiedReceivedHistoryBaseline | undefined,
  transaction: WorkspaceTransactionContext,
  ensureCurrent?: () => Promise<void>,
): Promise<ReceivedWorkspaceCommit> {
  const incoming = await loadIncomingReuse()
  const profile = stateRuntime.currentProfile ?? undefined
  const prepared = await prepareCapturedWorkspace(id, bytes, authorization, storage, receivedBasis, transaction, incoming, profile)
  if (prepared.phase !== "prepared") {
    if (prepared.phase === "committed") await ensureCurrent?.()
    return prepared
  }
  await persistPreparedWorkspace(id, prepared.packet, prepared.workspace, storage, transaction, profile, incoming.rememberIncomingPacket, ensureCurrent)
  return { phase: "committed" }
}

function loadIncomingReuse() {
  return import("./stateIncomingReuse")
}

type IncomingReuse = Awaited<ReturnType<typeof loadIncomingReuse>>
type CapturedPreparation = ReceivedWorkspaceCommit | { phase: "prepared"; packet: IncomingPacket; workspace: PreparedWorkspace }

async function prepareCapturedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage: WorkspaceStorage,
  receivedBasis: WasmVerifiedReceivedHistoryBaseline | undefined,
  transaction: WorkspaceTransactionContext,
  incoming: IncomingReuse,
  profile: LocalProfile | undefined,
): Promise<CapturedPreparation> {
  try {
    if (!receivedBasis && await incoming.reuseIncomingPacket(id, { bytes, authorization }, transaction, profile))
      return { phase: "committed" }
    const packet = incoming.copyIncomingPacket(bytes, authorization)
    // Admission and commit share this transaction's captured durable base.
    return { phase: "prepared", packet, workspace: await prepareAuthorizedWorkspace(
      id, packet.bytes, packet.authorization, storage, receivedBasis, transaction) }
  } catch (cause) {
    return { phase: "unadmitted", cause }
  }
}

async function persistPreparedWorkspace(
  id: string,
  packet: IncomingPacket,
  prepared: PreparedWorkspace,
  storage: WorkspaceStorage,
  transaction: WorkspaceTransactionContext,
  profile: LocalProfile | undefined,
  rememberIncomingPacket: IncomingReuse["rememberIncomingPacket"],
  ensureCurrent?: () => Promise<void>,
): Promise<void> {
  if (prepared.phase === "unchanged") {
    try {
      await assertReceivedBasisCurrent(storage, id, prepared.receivedBasis, transaction)
      await ensureCurrent?.()
      const revision = transaction.capturedRevision
      if (revision) await rememberIncomingPacket(packet, prepared.local, storage, prepared.credentialFingerprint,
        profile, prepared.replay, transaction.capturedBaselineId, revision).catch(() => undefined)
      meshTrace("workspace.admission.frontier-reused", { workspaceId: id, incremental: prepared.incremental ?? false })
    } finally {
      releaseReceivedDocuments(prepared.remote, prepared.local, undefined, false)
    }
    return
  }
  const { remote, local, admission, receivedBasis: admittedBasis } = prepared
  let merged: Automerge.Doc<WorkspaceDocumentV2> | undefined
  let transferred = false
  try {
    merged = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
    const mergedValidation = validateWorkspaceDoc(merged)
    if (!mergedValidation.ok) throw invalidWorkspaceReceived(mergedValidation.error)
    if (local && remote.ownerPersonId !== local.ownerPersonId)
      throw new Error("Workspace ownership cannot change through sync.")
    await assertReceivedBasisCurrent(storage, id, admittedBasis, transaction)
    const documentChanged = !local || !sameWorkspaceHeads(merged, local)
    await ensureCurrent?.()
    const { proofChanged, causalChanged } = await transaction.commitWorkspace(
      merged, Automerge.save(merged), admission.verifiedAuthorizations as WorkspaceChangeAuthorization[], undefined,
      { bytes: admission.rawBytes, decisions: admission.decisions, authorizationEvidence: admission.authorizationEvidence,
        admissionCheckpoint: admission.admissionCheckpoint },
    )
    if (documentChanged) traceNewRemoteChanges(id, merged, local)
    if (documentChanged || proofChanged || causalChanged) {
      transferred = stateRuntime.activeDoc?.id === id
      await publishCommittedWorkspace(id, merged, storage)
    }
    // Optional cache maintenance follows durable success and cannot reject that success.
    await rememberIncomingPacket(packet, merged, storage, admission.credentialFingerprint, profile, admission,
      transaction.capturedBaselineId).catch(() => undefined)
  } finally {
    releaseReceivedDocuments(remote, local, merged, transferred)
  }
}

type AdmittedIncrementalFrontier = {
  evidence: StoredCausalEvidence
  credentialFingerprint: string
}

/** Local incremental frontier already admitted at this captured revision. Undefined asks for strict admission. */
export async function recognizeAdmittedIncrementalFrontier(local: Automerge.Doc<WorkspaceDocumentV2>,
  remote: Automerge.Doc<WorkspaceDocumentV2>, authorization: unknown, evidence: StoredCausalEvidence | null | undefined,
  transaction: WorkspaceTransactionContext, profile?: LocalProfile): Promise<AdmittedIncrementalFrontier | undefined> {
  const revision = transaction.capturedRevision
  const frontier = await reusableDeltaAdmission(local, transaction, profile, false)
  if (!frontier || !incrementalEvidenceMatchesFrontier(evidence, frontier, local, remote, transaction)) return
  const current = await localWorkspaceAdmissionAuthority(local, profile)
  if (frontier.authorityFingerprint !== current.fingerprint) return
  const records = packetMatchingVerifiedAuthority(authorization, current.authority)
  if (!records || !packetProofsMatchFrontier(records, authorization, evidence)) return
  const latest = await transaction.readDeltaFrontier()
  if (!sameFrontier(latest, frontier) || !sameFrontier(transaction.capturedFrontier, frontier) || transaction.capturedRevision !== revision) return
  const checked = await localWorkspaceAdmissionAuthority(local, profile)
  if (checked.fingerprint !== current.fingerprint) throw new Error("Workspace authority changed during validation. Retry synchronization.")
  return { evidence, credentialFingerprint: checked.credentialFingerprint }
}

function incrementalEvidenceMatchesFrontier(evidence: StoredCausalEvidence | null | undefined, frontier: WorkspaceDeltaFrontier,
  local: Automerge.Doc<WorkspaceDocumentV2>, remote: Automerge.Doc<WorkspaceDocumentV2>,
  transaction: WorkspaceTransactionContext): evidence is StoredCausalEvidence {
  const checkpoint = evidence?.admissionCheckpoint
  if (!evidence?.authorizationEvidence?.length || !evidence.decisions.length || !checkpoint?.incremental) return false
  if (evidence.decisions.some(decision => decision.status.type !== "admitted")) return false
  if (remote.id !== local.id || documentHeads(local) !== documentHeads(remote)) return false
  if (documentHeads(local) !== [...frontier.heads].sort().join() || !frontier.heads.every(head =>
    evidence.decisions.some(decision => decision.hash === head && decision.status.type === "admitted"))) return false
  const bound = { policy: checkpoint.policy, inputHash: checkpoint.inputHash, projectionHeads: [...checkpoint.projectionHeads].sort(),
    decisionsHash: checkpoint.decisionsHash, incremental: true as const }
  const expected = { policy: frontier.policy, inputHash: frontier.chainHash, projectionHeads: [...frontier.heads].sort(),
    decisionsHash: frontier.chainHash, incremental: true as const }
  return canonicalizeJson(bound) === canonicalizeJson(expected) && sameFrontier(transaction.capturedFrontier, frontier)
}

function packetProofsMatchFrontier(records: unknown[], authorization: unknown, evidence: StoredCausalEvidence) {
  const stored = evidence.authorizationEvidence
  if (!stored?.length) return false
  try {
    if (!hasOnlyStoredAdmissionProofs(records, stored)) return false
    return fullyVerifiedIncomingInput(authorization, { decisions: evidence.decisions,
      admittedHashes: evidence.decisions.map(decision => decision.hash),
      verifiedAuthorizations: stored as WorkspaceChangeAuthorization[] })
  } catch { return false }
}

function sameFrontier(left: WorkspaceDeltaFrontier | null | undefined, right: WorkspaceDeltaFrontier) {
  return Boolean(left && !left.invalidated && canonicalizeJson(left) === canonicalizeJson(right))
}

function documentHeads(doc: Automerge.Doc<WorkspaceDocumentV2>) {
  return Automerge.getHeads(doc).sort().join()
}

function storedFrontierProof(evidence: StoredCausalEvidence): VerifiedIncomingAdmission | undefined {
  const records = evidence.authorizationEvidence as WorkspaceChangeAuthorization[] | undefined
  if (!records?.length || !evidence.decisions.length) return
  return { decisions: evidence.decisions, verifiedAuthorizations: records,
    admittedHashes: evidence.decisions.filter(decision => decision.status.type === "admitted").map(decision => decision.hash) }
}

function releaseReceivedDocuments(remote: Automerge.Doc<WorkspaceDocumentV2>, local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  merged: Automerge.Doc<WorkspaceDocumentV2> | undefined, transferred: boolean) {
  Automerge.free(remote)
  if (local) Automerge.free(local)
  if (merged && !transferred) Automerge.free(merged)
}

async function assertReceivedBasisCurrent(storage: WorkspaceStorage, id: string, admitted?: WasmVerifiedReceivedHistoryBaseline,
  transaction?: WorkspaceTransactionContext) {
  if (!admitted) return
  const current = await (transaction ? transaction.getVerifiedReceivedHistoryBaseline() : storage.getVerifiedReceivedHistoryBaseline(id))
  if (!current || receivedHistoryBasisIdentity(current)?.baselineId !== receivedHistoryBasisIdentity(admitted)?.baselineId)
    throw new Error("Received history basis changed during workspace admission")
}

function traceNewRemoteChanges(id: string, merged: Automerge.Doc<WorkspaceDocumentV2>, local?: Automerge.Doc<WorkspaceDocumentV2>) {
  const known = new Set(local ? Automerge.getChangesMetaSince(local, []).map(change => change.hash) : [])
  for (const change of Automerge.getChangesMetaSince(merged, []).filter(change => !known.has(change.hash))) {
    meshTrace("document.persisted", { workspaceId: id, recordId: change.hash, changeId: change.hash,
      phase: "remote", component: "automerge", heads: Automerge.getHeads(merged) });
  }
}

/**
 * Checks a received document and all of its signatures without writing a
 * snapshot, proof record, or mesh credential. Invitation flows use this to
 * reject the whole set before any durable state becomes visible.
 */
export async function validateAuthorizedWorkspace(id: string, bytes: Uint8Array, authorization: unknown,
  storage = defaultStorage, receivedBasis?: WasmVerifiedReceivedHistoryBaseline): Promise<void> {
  await storage.withWorkspaceTransaction(id, async transaction => {
    const { reuseIncomingPacket } = await import("./stateIncomingReuse")
    if (!receivedBasis && await reuseIncomingPacket(id, { bytes, authorization }, transaction, stateRuntime.currentProfile ?? undefined)) return
    const prepared = await prepareAuthorizedWorkspace(id, bytes, authorization, storage, receivedBasis, transaction)
    // Preflight only checks the candidate; ownership never escapes this boundary.
    releaseAdmissionDocuments(prepared.remote, prepared.local)
  })
}

function releaseAdmissionDocuments(remote: Automerge.Doc<WorkspaceDocumentV2>, local?: Automerge.Doc<WorkspaceDocumentV2>) {
  Automerge.free(remote)
  if (local) Automerge.free(local)
}

type WorkspaceAdmission = Awaited<ReturnType<typeof evaluateIncomingWorkspaceAdmission>>
type PreparedWorkspace =
  | { phase: "ready"; remote: Automerge.Doc<WorkspaceDocumentV2>; local: Automerge.Doc<WorkspaceDocumentV2> | undefined;
      admission: WorkspaceAdmission; receivedBasis?: WasmVerifiedReceivedHistoryBaseline }
  | { phase: "unchanged"; remote: Automerge.Doc<WorkspaceDocumentV2>; local: Automerge.Doc<WorkspaceDocumentV2>;
      replay: VerifiedIncomingAdmission; credentialFingerprint: string; incremental?: boolean;
      receivedBasis?: WasmVerifiedReceivedHistoryBaseline }

async function prepareAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage = defaultStorage,
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline,
  transaction?: WorkspaceTransactionContext,
): Promise<PreparedWorkspace> {
  const remote = Automerge.load<WorkspaceDocumentV2>(bytes)
  let local: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    local = await mergeAuthorizationBase(id, remote, storage, transaction)
    assertShareableWorkspace(remote, id, local)
    const opened = await openAdmissionInputs(id, remote, authorization, local, storage, receivedBasis, transaction)
    if (opened.reused && local) return { phase: "unchanged", remote, local, ...opened.reused, receivedBasis: opened.basis }
    return { phase: "ready", remote, local, receivedBasis: opened.basis,
      admission: await admitRemoteEvidence(local, remote, authorization, opened.evidence, opened.basis) }
  } catch (error) {
    releaseAdmissionDocuments(remote, local)
    throw error
  }
}

function assertShareableWorkspace(remote: Automerge.Doc<WorkspaceDocumentV2>, id: string, local?: Automerge.Doc<WorkspaceDocumentV2>) {
  const valid = validateRemoteWorkspace(remote, id)
  if (!valid && (!local || local.formatVersion !== 3))
    throw invalidWorkspaceReceived({ code: "unsupported_format", message: "Workspace owner must reopen this board in updated tincanban before sharing it." })
}

async function openAdmissionInputs(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  authorization: unknown,
  local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  storage: WorkspaceStorage,
  receivedBasis: WasmVerifiedReceivedHistoryBaseline | undefined,
  transaction: WorkspaceTransactionContext | undefined,
) {
  const evidence = await (transaction ? transaction.loadCausalEvidence() : storage.loadCausalEvidence(id))
  const basis = receivedBasis ?? await (transaction
    ? transaction.getVerifiedReceivedHistoryBaseline() : storage.getVerifiedReceivedHistoryBaseline(id))
  const reused = local ? await reusedDurableFrontier(local, remote, authorization, evidence, basis, transaction) : undefined
  return { evidence, basis, reused }
}

async function reusedDurableFrontier(
  local: Automerge.Doc<WorkspaceDocumentV2>,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  authorization: unknown,
  evidence: StoredCausalEvidence | null,
  basis: WasmVerifiedReceivedHistoryBaseline | undefined,
  transaction: WorkspaceTransactionContext | undefined,
) {
  if (!evidence) return
  if (evidence.admissionCheckpoint?.incremental && transaction) {
    const verified = await recognizeAdmittedIncrementalFrontier(local, remote, authorization, evidence, transaction,
      stateRuntime.currentProfile ?? undefined)
    if (!verified) return
    const replay = storedFrontierProof(verified.evidence)
    if (replay) return { replay, credentialFingerprint: verified.credentialFingerprint, incremental: true }
    return
  }
  const credentialFingerprint = await durableAdmittedFrontierCredential(local, remote, authorization, evidence, basis)
  if (credentialFingerprint === undefined) return
  const replay = storedFrontierProof(evidence)
  if (!replay || !fullyVerifiedIncomingInput(authorization, replay)) return
  return { replay, credentialFingerprint }
}

async function admitRemoteEvidence(
  local: Automerge.Doc<WorkspaceDocumentV2> | undefined,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  authorization: unknown,
  evidence: StoredCausalEvidence | null,
  basis?: WasmVerifiedReceivedHistoryBaseline,
) {
  const rawLocal = evidence ? Automerge.load<WorkspaceDocumentV2>(evidence.bytes) : local
  try {
    return await evaluateIncomingWorkspaceAdmission(rawLocal, remote, authorization,
      (evidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[], basis)
  } finally {
    if (evidence) Automerge.free(rawLocal!)
  }
}

function validateRemoteWorkspace(remote: Automerge.Doc<WorkspaceDocumentV2>, id: string): boolean {
  if (remote.id !== id) {
    throw invalidWorkspaceReceived({
      code: "workspace_id_mismatch",
      message: "The document id does not match the invited workspace.",
    });
  }
  const validation = validateWorkspaceDoc(remote);
  if (!validation.ok && (remote as unknown as { formatVersion: number }).formatVersion !== 2)
    throw invalidWorkspaceReceived(validation.error);
  if (!validation.ok) {
    const migration = planWorkspaceMigration(remote, new Date().toISOString());
    if (!migration.ok) throw invalidWorkspaceReceived(migration.error);
  }
  return validation.ok
}

async function mergeAuthorizationBase(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  storage = defaultStorage,
  transaction?: WorkspaceTransactionContext,
) {
  const reusable = stateRuntime.activeDoc?.id === id ? stateRuntime.activeDoc : undefined;
  const local = (await (transaction ? transaction.loadWorkspaceDoc() : storage.loadWorkspaceDoc(id, reusable)))?.doc;
  if (local && !sharesBoard(local, remote)) {
    Automerge.free(local)
    throw new Error(`Workspace conflict: ${id} identifies different boards. Nothing was replaced.`);
  }
  return local;
}

function sharesBoard(
  local: Automerge.Doc<WorkspaceDocumentV2>,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
): boolean {
  return Object.values(local.entities).some(
    (entity) =>
      hasEntityKind(entity, "board") && hasEntityKind(remote.entities[entity.id], "board"),
  );
}

export async function importWorkspaceDocument(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  storage = defaultStorage,
): Promise<void> {
  const validation = validateWorkspaceDoc(doc);
  if (!validation.ok) throw invalidWorkspaceReceived(validation.error);
  const profile = await requireProfile();
  await assertImportAllowed(doc, profile, storage);
  const existing = await storage.loadWorkspaceDoc(doc.id);
  if (existing) {
    try {
      const bytes = Automerge.save(doc)
      const authorization = await exportAuthorizationBundle(bytes, profile)
      await mergeAuthorizedWorkspace(doc.id, bytes, authorization, storage)
    } finally { Automerge.free(existing.doc) }
  } else {
    await storage.withWorkspaceTransaction(doc.id, async transaction => {
      const current = await transaction.loadWorkspaceDoc()
      if (current) {
        Automerge.free(current.doc)
        throw new Error("Workspace already exists; import must be admitted against its current state.")
      }
      await transaction.commitWorkspace(doc, Automerge.save(doc), []);
    });
  }
  await addWorkspaceToPersonalRoot(doc.id, "import", storage);
  await switchWorkspace(doc.id, storage);
  await refreshCausalReview(storage, doc.id);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId: doc.id });
}

async function assertImportAllowed(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  profile: Awaited<ReturnType<typeof requireProfile>>,
  storage: WorkspaceStorage,
): Promise<void> {
  const existing = (await storage.loadWorkspaceDoc(doc.id))?.doc;
  if (existing) {
    try {
      assertWorkspaceCapability(
        await workspaceRole(existing, profile),
        "workspace.import",
      );
      if (existing.ownerPersonId !== doc.ownerPersonId)
        throw new Error("Workspace ownership cannot change through import.");
    } finally { Automerge.free(existing) }
  } else if (doc.ownerPersonId !== profile.identity.personId)
    throw new Error("Only the workspace owner can import a new workspace");
}

function invalidWorkspaceReceived(diagnostic: {
  code: string;
  message: string;
  field?: string;
}): Error {
  const error = new Error("Invalid workspace received.", { cause: diagnostic });
  error.name = "WorkspaceDocumentRejected";
  return error;
}
