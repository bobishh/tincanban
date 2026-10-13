import { hasEntityKind } from "./domain/model"
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
  saveWorkspaceRecord,
  type WorkspaceRecord,
  type WorkspaceStorage,
} from "./storage";
import {
  notifyLocalChanges,
  reconcile,
  refreshCausalReview,
  refreshAvailableWorkspaces,
  updateReactiveState,
} from "./statePersistence";
import { withWorkspaceMutation } from "./workspaceMutation";
import { reclassifyStoredWorkspace } from "./stateCausalAdmission";
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore";
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
    mergeWorkspaceRecord,
    subscribeLocalChanges,
  };
}

async function reclassifyWorkspace(id: string, storage = defaultStorage): Promise<void> {
  try {
    const result = await reclassifyStoredWorkspace(id, storage)
    if (!result.doc) return
    if (result.changed) await publishCommittedWorkspace(id, result.doc, storage)
    else {
      if (stateRuntime.activeDoc?.id === id && !sameHeads(stateRuntime.activeDoc, result.doc)) updateReactiveState(result.doc)
      await refreshCausalReview(storage, id)
    }
  } catch (error) {
    stateRuntime.causalReviewError.value = "Access update pending. Workspace history could not be reclassified; reload to retry."
    throw error
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
  const doc = stateRuntime.activeDoc?.id === id
    ? stateRuntime.activeDoc
    : (await storage.loadWorkspaceDoc(id))?.doc;
  if (!doc) throw new Error("The selected workspace is unavailable on this device.");
  return doc;
}

async function readWorkspaceHeads(id: string): Promise<string[]> {
  return Automerge.getHeads(await readWorkspaceDoc(id))
}

async function recordVerifiedOwnerWorkspace(id: string, storage = defaultStorage): Promise<void> {
  const profile = await requireProfile()
  const doc = await readWorkspaceDoc(id, storage)
  if (doc.ownerPersonId !== profile.identity.personId) {
    throw new Error("Only a workspace owned by this identity can be added from an owner offer.")
  }
  await addWorkspaceToPersonalRoot(id, "import", storage)
  await refreshAvailableWorkspaces(storage)
}

async function readWorkspaceBytes(
  id: string,
  storage = defaultStorage,
): Promise<Uint8Array> {
  const evidence = await storage.loadCausalEvidence(id)
  if (evidence) return new Uint8Array(evidence.bytes)
  const doc = await readWorkspaceDoc(id, storage);
  return Automerge.save(doc);
}

async function mergeAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
  storage = defaultStorage,
): Promise<void> {
  await withWorkspaceMutation(id, async () => {
    // Validation must use the same current durable base as the eventual merge.
    const { remote, local, admission } = await validateAuthorizedWorkspace(id, bytes, authorization, storage);
    const merged = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument);
    const mergedValidation = validateWorkspaceDoc(merged);
    if (!mergedValidation.ok) throw invalidWorkspaceReceived(mergedValidation.error);
    if (local && remote.ownerPersonId !== local.ownerPersonId)
      throw new Error("Workspace ownership cannot change through sync.");
    const documentChanged = !local || !sameHeads(merged, local);
    const { proofChanged, causalChanged } = await storage.commitWorkspace(
      id, merged, Automerge.save(merged), admission.verifiedAuthorizations as WorkspaceChangeAuthorization[], undefined,
      { bytes: admission.rawBytes, decisions: admission.decisions, authorizationEvidence: admission.authorizationEvidence,
        admissionCheckpoint: admission.admissionCheckpoint },
    );
    const knownLocalHashes = new Set(local ? Automerge.getChangesMetaSince(local, []).map(change => change.hash) : [])
    if (documentChanged) for (const change of Automerge.getChangesMetaSince(merged, []).filter(change => !knownLocalHashes.has(change.hash))) {
      meshTrace("document.persisted", { workspaceId: id, recordId: change.hash, changeId: change.hash,
        phase: "remote", component: "automerge", heads: Automerge.getHeads(merged) });
    }
    if (documentChanged || proofChanged || causalChanged) await publishCommittedWorkspace(id, merged, storage);
  });
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
): Promise<{ remote: Automerge.Doc<WorkspaceDocumentV2>; local: Automerge.Doc<WorkspaceDocumentV2> | undefined;
  admission: Awaited<ReturnType<typeof evaluateIncomingWorkspaceAdmission>> }> {
  const remote = Automerge.load<WorkspaceDocumentV2>(bytes);
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
  const local = await mergeAuthorizationBase(id, remote, storage);
  if (!validation.ok && (!local || local.formatVersion !== 3))
    throw invalidWorkspaceReceived({ code: "unsupported_format", message: "Workspace owner must reopen this board in updated tincanban before sharing it." });
  const evidence = await storage.loadCausalEvidence(id)
  const rawLocal = evidence ? Automerge.load<WorkspaceDocumentV2>(evidence.bytes) : local
  try {
    const admission = await evaluateIncomingWorkspaceAdmission(rawLocal, remote, authorization,
      (evidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[])
    return { remote, local, admission }
  } finally {
    if (rawLocal && rawLocal !== local) Automerge.free(rawLocal)
  }
}

async function mergeAuthorizationBase(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  storage = defaultStorage,
) {
  const reusable = stateRuntime.activeDoc?.id === id ? stateRuntime.activeDoc : undefined;
  const local = (await storage.loadWorkspaceDoc(id, reusable))?.doc;
  if (local && !sharesBoard(local, remote)) throw new Error(`Workspace conflict: ${id} identifies different boards. Nothing was replaced.`);
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
  const local = (await storage.loadWorkspaceDoc(doc.id))?.doc;
  if (local) {
    const bytes = Automerge.save(doc)
    const authorization = await exportAuthorizationBundle(bytes, profile)
    await mergeAuthorizedWorkspace(doc.id, bytes, authorization, storage)
  } else {
    await withWorkspaceMutation(doc.id, async () => {
      await storage.saveSnapshot(doc.id, doc, Automerge.save(doc));
    });
  }
  await storage.registerWorkspace(doc.id, doc.title);
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

async function mergeWorkspaceRecord(
  record: WorkspaceRecord,
  storage = defaultStorage,
): Promise<void> {
  const doc = stateRuntime.activeDoc;
  const profile = stateRuntime.currentProfile;
  if (!doc || !profile) throw new Error("Workspace not hydrated");
  assertWorkspaceCapability(
    await workspaceRole(doc, profile),
    "workspace.import",
  );
  await saveWorkspaceRecord(record);
  await reconcile(storage);
}

function subscribeLocalChanges(listener: (workspaceId?: string) => void): () => void {
  stateRuntime.localChangeListeners.add(listener);
  return () => stateRuntime.localChangeListeners.delete(listener);
}
