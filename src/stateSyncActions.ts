import { hasEntityKind } from "./domain/model"
import { WorkspaceUnavailableError } from "./workspaceAvailability"
import { meshTrace } from "./sync/meshTrace"
import * as Automerge from "@automerge/automerge/slim";
import { assertWorkspaceCapability } from "./domain/permissions";
import type { WorkspaceDocumentV2 } from "./domain/model";
import { validateWorkspaceDoc } from "./domain/model";
import { planWorkspaceMigration } from "./domain/workspaceMigration";
import {
  exportAuthorizationBundle,
  workspaceRole,
  evaluateIncomingWorkspaceAdmission,
} from "./sync/changeAuthorization";
import {
  defaultStorage,
  type WorkspaceStorage,
  type WorkspaceTransactionContext,
} from "./storage";
import {
  notifyLocalChanges,
  refreshCausalReview,
  refreshAvailableWorkspaces,
  updateReactiveState,
} from "./statePersistence";
import { reclassifyStoredWorkspace } from "./stateCausalAdmission";
import { receivedHistoryBasisIdentity } from "./product-replica/receivedHistoryBasisIdentity";
import type { WorkspaceChangeAuthorization } from "./product-replica";
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm";
import { stateRuntime } from "./stateContext";
import {
  addWorkspaceToPersonalRoot,
  requireProfile,
  switchWorkspace,
} from "./stateWorkspaceActions";

export function createSyncActions() {
  return {
    readWorkspaceDoc,
    readWorkspaceHeads,
    readWorkspaceBytes,
    recordVerifiedOwnerWorkspace,
    reclassifyWorkspace,
    switchWorkspace: switchWorkspaceWithAdmission,
    validateAuthorizedWorkspace,
    mergeAuthorizedWorkspace,
    importWorkspaceDocument,
    subscribeLocalChanges,
  };
}

async function reclassifyWorkspace(id: string, storage = defaultStorage): Promise<void> {
  let result: Awaited<ReturnType<typeof reclassifyStoredWorkspace>> | undefined
  let transferred = false
  try {
    result = await reclassifyStoredWorkspace(id, storage)
    if (!result.doc) return
    if (result.changed) {
      transferred = stateRuntime.activeDoc?.id === id
      await publishCommittedWorkspace(id, result.doc, storage)
    }
    else {
      if (stateRuntime.activeDoc?.id === id && !sameHeads(stateRuntime.activeDoc, result.doc)) {
        transferred = true
        updateReactiveState(result.doc)
      }
      await refreshCausalReview(storage, id)
    }
  } catch (error) {
    stateRuntime.causalReviewError.value = "Access update pending. Workspace history could not be reclassified; reload to retry."
    throw error
  } finally {
    if (result?.doc && !transferred) Automerge.free(result.doc)
  }
}

async function switchWorkspaceWithAdmission(id: string, storage = defaultStorage): Promise<void> {
  await reclassifyWorkspace(id, storage)
  await switchWorkspace(id, storage)
  await refreshCausalReview(storage, id)
  await refreshAvailableWorkspaces(storage)
}

async function readWorkspaceDoc(
  id: string,
  storage = defaultStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  return (await readWorkspaceDocLease(id, storage)).doc;
}

async function readWorkspaceDocLease(id: string, storage: WorkspaceStorage = defaultStorage): Promise<{
  doc: Automerge.Doc<WorkspaceDocumentV2>; owned: boolean
}> {
  const active = stateRuntime.activeDoc?.id === id ? stateRuntime.activeDoc : null;
  if (active) return { doc: active, owned: false };
  const loaded = await storage.loadWorkspaceDoc(id);
  if (!loaded) throw new WorkspaceUnavailableError();
  return { doc: loaded.doc, owned: true };
}

async function readWorkspaceHeads(id: string): Promise<string[]> {
  const lease = await readWorkspaceDocLease(id)
  try { return Automerge.getHeads(lease.doc) }
  finally { if (lease.owned) Automerge.free(lease.doc) }
}

async function recordVerifiedOwnerWorkspace(id: string, storage = defaultStorage): Promise<void> {
  const profile = await requireProfile()
  const lease = await readWorkspaceDocLease(id, storage)
  try {
    if (lease.doc.ownerPersonId !== profile.identity.personId) {
      throw new Error("Only a workspace owned by this identity can be added from an owner offer.")
    }
    await addWorkspaceToPersonalRoot(id, "import", storage)
    await refreshAvailableWorkspaces(storage)
  } finally { if (lease.owned) Automerge.free(lease.doc) }
}

async function readWorkspaceBytes(
  id: string,
  storage = defaultStorage,
): Promise<Uint8Array> {
  const evidence = await storage.loadCausalEvidence(id)
  if (evidence) return new Uint8Array(evidence.bytes)
  const lease = await readWorkspaceDocLease(id, storage);
  try { return Automerge.save(lease.doc) }
  finally { if (lease.owned) Automerge.free(lease.doc) }
}

async function mergeAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage = defaultStorage,
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline,
): Promise<void> {
  await storage.withWorkspaceTransaction(id, async transaction => {
    const { reuseIncomingPacket, copyIncomingPacket, rememberIncomingPacket } = await import("./stateIncomingReuse")
    const profile = stateRuntime.currentProfile ?? undefined
    if (!receivedBasis && await reuseIncomingPacket(id, { bytes, authorization }, transaction, profile)) return
    const packet = copyIncomingPacket(bytes, authorization)
    // Validation must use the same current durable base as the eventual merge.
    const validated = await validateAuthorizedWorkspace(
      id, packet.bytes, packet.authorization, storage, receivedBasis, transaction)
    const { remote, local, admission, receivedBasis: admittedBasis } = validated
    let merged: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let transferred = false
    try {
      merged = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
      const mergedValidation = validateWorkspaceDoc(merged);
      if (!mergedValidation.ok) throw invalidWorkspaceReceived(mergedValidation.error);
      if (local && remote.ownerPersonId !== local.ownerPersonId)
        throw new Error("Workspace ownership cannot change through sync.");
      await assertReceivedBasisCurrent(storage, id, admittedBasis, transaction)
      const documentChanged = !local || !sameHeads(merged, local);
      const { proofChanged, causalChanged } = await transaction.commitWorkspace(
        merged, Automerge.save(merged), admission.verifiedAuthorizations as WorkspaceChangeAuthorization[], undefined,
        { bytes: admission.rawBytes, decisions: admission.decisions, authorizationEvidence: admission.authorizationEvidence,
          admissionCheckpoint: admission.admissionCheckpoint },
      );
      if (documentChanged) traceNewRemoteChanges(id, merged, local)
      if (documentChanged || proofChanged || causalChanged) {
        transferred = stateRuntime.activeDoc?.id === id
        await publishCommittedWorkspace(id, merged, storage)
      }
      // Optional cache maintenance follows durable success and cannot reject that success.
      await rememberIncomingPacket(packet, merged, storage, admission.credentialFingerprint, profile).catch(() => undefined)
    } finally {
      releaseReceivedDocuments(remote, local, merged, transferred)
    }
  });
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
async function validateAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage = defaultStorage,
  receivedBasis?: WasmVerifiedReceivedHistoryBaseline,
  transaction?: WorkspaceTransactionContext,
): Promise<{ remote: Automerge.Doc<WorkspaceDocumentV2>; local: Automerge.Doc<WorkspaceDocumentV2> | undefined;
  admission: Awaited<ReturnType<typeof evaluateIncomingWorkspaceAdmission>>; receivedBasis?: WasmVerifiedReceivedHistoryBaseline }> {
  const remote = Automerge.load<WorkspaceDocumentV2>(bytes);
  let local: Automerge.Doc<WorkspaceDocumentV2> | undefined
  try {
    const valid = validateRemoteWorkspace(remote, id)
    local = await mergeAuthorizationBase(id, remote, storage, transaction);
    if (!valid && (!local || local.formatVersion !== 3))
      throw invalidWorkspaceReceived({ code: "unsupported_format", message: "Workspace owner must reopen this board in updated tincanban before sharing it." });
    const evidence = await (transaction ? transaction.loadCausalEvidence() : storage.loadCausalEvidence(id))
    const basis = receivedBasis ?? await (transaction
      ? transaction.getVerifiedReceivedHistoryBaseline()
      : storage.getVerifiedReceivedHistoryBaseline(id))
    const rawLocal = evidence ? Automerge.load<WorkspaceDocumentV2>(evidence.bytes) : local
    try {
      const admission = await evaluateIncomingWorkspaceAdmission(rawLocal, remote, authorization,
        (evidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[], basis)
      return { remote, local, admission, receivedBasis: basis }
    } finally {
      if (evidence) Automerge.free(rawLocal!)
    }
  } catch (error) {
    Automerge.free(remote)
    if (local) Automerge.free(local)
    throw error
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

function sameHeads(
  left: Automerge.Doc<WorkspaceDocumentV2>,
  right: Automerge.Doc<WorkspaceDocumentV2>,
): boolean {
  return (
    Automerge.getHeads(left).sort().join() ===
    Automerge.getHeads(right).sort().join()
  );
}

async function publishCommittedWorkspace(
  id: string,
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  storage: WorkspaceStorage,
): Promise<void> {
  if (stateRuntime.activeDoc?.id === id) {
    updateReactiveState(doc);
    await refreshCausalReview(storage, id);
  }
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId: id });
  notifyLocalChanges(id);
}

async function importWorkspaceDocument(
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

function invalidWorkspaceReceived(diagnostic: {
  code: string;
  message: string;
  field?: string;
}): Error {
  const error = new Error("Invalid workspace received.", { cause: diagnostic });
  error.name = "WorkspaceDocumentRejected";
  return error;
}

async function assertImportAllowed(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  profile: Awaited<ReturnType<typeof requireProfile>>,
  storage: WorkspaceStorage,
): Promise<void> {
  const existing = (await storage.loadWorkspaceDoc(doc.id))?.doc;
  if (existing) {
    assertWorkspaceCapability(
      await workspaceRole(existing, profile),
      "workspace.import",
    );
    if (existing.ownerPersonId !== doc.ownerPersonId)
      throw new Error("Workspace ownership cannot change through import.");
  } else if (doc.ownerPersonId !== profile.identity.personId)
    throw new Error("Only the workspace owner can import a new workspace");
}

function subscribeLocalChanges(listener: (workspaceId?: string) => void): () => void {
  stateRuntime.localChangeListeners.add(listener);
  return () => stateRuntime.localChangeListeners.delete(listener);
}
