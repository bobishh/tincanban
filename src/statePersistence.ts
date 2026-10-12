import { hasEntityKind, validateWorkspaceDoc } from "./domain/model"
import { meshTrace } from "./sync/meshTrace"
import * as Automerge from "@automerge/automerge/slim";
import { initializeAutomerge } from "./crdt";
import {
  assertWorkspaceCapability,
  assertWorkspaceCommand,
  type WorkspaceRole,
} from "./domain/permissions";
import {
  bootstrapIdentity,
  type LocalProfile,
} from "./domain/identity";
import { initializePersonalRootCatalog, registerWorkspaceInCurrentRoot } from "./statePersonalRoot";
import { createWorkspaceDoc } from "./domain/seeds";
import { migrateOwnedWorkspaces } from "./stateStartupMigration";
import { type Board, type WorkspaceDocumentV2 } from "./domain/model";
import { executeCommand, type Command, type ExecuteResult } from "./domain/commands";
import {
  evaluateIncomingWorkspaceAdmission,
  exportDocumentAuthorizationBundle,
  prepareLocalChangeAuthorizations,
  recordGenesisAuthority,
  localChangeAuthorityGrantHash,
  workspaceRole,
} from "./sync/changeAuthorization";
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore";
import {
  defaultStorage,
  type WorkspaceStorage,
} from "./storage";
import { projectWorkspace } from "./stateProjection";
import { withWorkspaceMutation } from "./workspaceMutation";
import { stateRuntime } from "./stateContext";
import { readLocal, writeLocal } from "./localDb";
import { loadReviewAction, refreshCausalReview } from "./stateCausalReviewLoader";
import type { CausalReviewCallbacks } from "./stateCausalReviewLoader";
import { assertWorkspaceWritesAllowed, reclassifyStoredWorkspace } from "./stateCausalAdmission";
import { applyInjectedFixture } from "./stateInjectedFixture";
import { canReuseAdmittedDocument } from "./sync/localAdmissionReuse";
import { clearPendingItemMoves } from "./pendingItemMoves";
import { startPendingWrite } from "./statePendingWrites";
import { diagnoseStartupStep, setStartupDiagnosticDevice } from "./sync/startupDiagnostics";

type ReadinessWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

const readinessWaiters = new Set<ReadinessWaiter>();

export function resetStateForTest(): void {
  clearPendingItemMoves();
  stateRuntime.activeDoc = null;
  stateRuntime.currentProfile = null;
  stateRuntime.ready.value = false;
  stateRuntime.startupStage.value = "starting";
  stateRuntime.saveState.value = "idle";
  stateRuntime.pendingWrites = 0;
  stateRuntime.batchSaveFailed = false;
  stateRuntime.reconcilePromise = undefined;
  stateRuntime.reconcileRequested = false;
  stateRuntime.reconcileWorkspaceChanged = false;
  stateRuntime.reconcileWorkspaceIds.clear();
  stateRuntime.reconcileWorkspaceUnknown = false;
  clearWorkspaceProjection();
  stateRuntime.availableWorkspaces.value = [];
  stateRuntime.archivedWorkspaces.value = [];
  stateRuntime.causalReview.value = [];
  stateRuntime.causalReviewError.value = "";
  Object.assign(stateRuntime.activeWorkspaceMeta, {
    id: "",
    title: "Untitled",
    presetKey: "blank",
  });
  stateRuntime.docVersion.value += 1;
  stateRuntime.localChangeListeners.clear();
}

export function updateReactiveState(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
): void {
  stateRuntime.activeDoc = doc;
  const board = Object.values(doc.entities).find(
    (entity): entity is Board => hasEntityKind(entity, "board"),
  );
  Object.assign(stateRuntime.activeWorkspaceMeta, {
    id: doc.id,
    title: doc.title,
    presetKey: board?.preset?.key ?? "blank",
  });
  stateRuntime.docVersion.value += 1;
  const projected = projectWorkspace(doc);
  replaceWorkspaceProjection(projected);
}

export async function prepareLocalState(storage = defaultStorage): Promise<void> {
  try {
    stateRuntime.startupStage.value = "reading";
    console.info("[tincanban.startup] prepare", "automerge")
    await diagnoseStartupStep("automerge-wasm", initializeAutomerge);
    console.info("[tincanban.startup] prepare", "identity")
    stateRuntime.currentProfile = await diagnoseStartupStep("identity-load", bootstrapIdentity);
    setStartupDiagnosticDevice(stateRuntime.currentProfile.device.deviceId);
    console.info("[tincanban.startup] prepare", "catalog")
    await refreshAvailableWorkspaces(storage);
  } catch (error) {
    rejectReadinessWaiters(error);
    throw error;
  }
}

export async function hydrate(storage = defaultStorage): Promise<void> {
  await prepareLocalState(storage);
  await hydratePreparedState(storage);
}

export async function hydratePreparedState(storage = defaultStorage): Promise<void> {
  try {
    const profile = stateRuntime.currentProfile;
    if (!profile) throw new Error("Local identity is unavailable");
    console.info("[tincanban.startup] hydrate", "workspace")
    let doc = await diagnoseStartupStep("initial-workspace-load", () => loadInitialWorkspace(storage, profile));
    // Publish only the saved projection, never the separate raw causal history.
    // Readiness stays false until local history checks finish.
    if (validateWorkspaceDoc(doc).ok) await diagnoseStartupStep("workspace-preview", () => updateReactiveState(doc), { workspaceId: doc.id });
    stateRuntime.startupStage.value = "updating";
    await diagnoseStartupStep("workspace-migrations", () => migrateOwnedWorkspaces(storage, profile,
      source => persistAuthorizedCommand(source, { kind: "migrateWorkspaceFormat" }, profile, storage)));
    stateRuntime.startupStage.value = "history";
    const reclassified = await diagnoseStartupStep("history-reclassification", () => reclassifyStoredWorkspace(doc.id, storage), { workspaceId: doc.id, operationCount: Automerge.stats(doc).numOps });
    doc = reclassified.doc ?? (await storage.loadWorkspaceDoc(doc.id))?.doc ?? doc;
    await diagnoseStartupStep("workspace-projection", () => updateReactiveState(doc), { workspaceId: doc.id });
    await diagnoseStartupStep("causal-review", () => refreshCausalReview(storage, doc.id), { workspaceId: doc.id });
    console.info("[tincanban.startup] hydrate", "personal-root")
    await diagnoseStartupStep("personal-root-load", () => initializePersonalRootCatalog(storage, profile));
    applyInjectedFixture(updateReactiveState);
    console.info("[tincanban.startup] hydrate", "catalog")
    await refreshAvailableWorkspaces(storage);
    stateRuntime.startupStage.value = "access";
    stateRuntime.ready.value = true;
    for (const waiter of readinessWaiters) waiter.resolve();
    readinessWaiters.clear();
  } catch (error) {
    rejectReadinessWaiters(error);
    throw error;
  }
}

export { refreshCausalReview };

function rejectReadinessWaiters(error: unknown): void {
  for (const waiter of readinessWaiters) waiter.reject(error);
  readinessWaiters.clear();
}

export function whenReady(): Promise<void> {
  if (stateRuntime.ready.value && stateRuntime.activeDoc) return Promise.resolve();
  return new Promise((resolve, reject) => {
    readinessWaiters.add({ resolve, reject });
  });
}

export async function commitAndPersist(
  command: Command,
  storage = defaultStorage,
  targetWorkspaceId?: string,
): Promise<void> {
  if (!stateRuntime.ready.value) throw new Error("Saved board is still being checked. Try again when checks finish.");
  const workspaceId = targetWorkspaceId ?? stateRuntime.activeDoc?.id;
  const profile = stateRuntime.currentProfile;
  if (!workspaceId || !profile) throw new Error("Workspace not hydrated");
  const finishWrite = startPendingWrite(stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null, command);
  try {
    await persistCommand(workspaceId, command, profile, storage);
  } catch (error) {
    stateRuntime.batchSaveFailed = true;
    throw error;
  } finally {
    finishWrite();
  }
}

export async function persistAuthorizedCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  command: Command,
  profile: LocalProfile,
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  return withWorkspaceMutation(doc.id, async () => {
    const stored = (await storage.loadWorkspaceDoc(doc.id))?.doc;
    const base = stored ? Automerge.merge(Automerge.clone(stored), Automerge.clone(doc)) : doc;
    return commitAuthorizedCommand(base, command, profile, storage);
  });
}

export async function reviewCausalChange(changeHash: string, storage = defaultStorage): Promise<void> {
  const callbacks: CausalReviewCallbacks = { latestWorkspaceDocument, persistNewLocalChange, updateReactiveState, notifyLocalChanges };
  await assertWorkspaceWritesAllowed(stateRuntime.activeDoc?.id)
  await (await requireReviewAction()).reviewCausalChange(changeHash, storage, callbacks)
}

export async function dismissCausalChange(changeHash: string, storage = defaultStorage): Promise<void> {
  await (await requireReviewAction()).setCausalChangeDismissed(changeHash, true, storage)
}

export async function restoreCausalChange(changeHash: string, storage = defaultStorage): Promise<void> {
  await (await requireReviewAction()).setCausalChangeDismissed(changeHash, false, storage)
}

async function requireReviewAction() {
  const module = await loadReviewAction()
  if (!module) throw new Error("Workspace change review could not load. Reload to retry.")
  return module
}

async function commitAuthorizedCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command,
  profile: LocalProfile, storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  await assertWorkspaceWritesAllowed(doc.id);
  const role = await workspaceRole(doc, profile);
  if (command.kind !== "setMemberAvatar") ensureContentWrite(role)
  assertWorkspaceCommand(role, doc, command);
  const authorityGrantHash = await localChangeAuthorityGrantHash(doc.id, profile.identity.personId, command.kind === "setMemberAvatar");
  const result = await executeCommand(doc, command, profile, undefined, authorityGrantHash);
  if (!result.ok)
    throw new Error(
      `Command failed: [${result.error.code}] ${result.error.message}`,
    );
  return persistNewLocalChange(doc, result.value, profile, storage);
}

type CreatedLocalChange = Extract<ExecuteResult, { ok: true }>['value']

async function persistNewLocalChange(
  base: Automerge.Doc<WorkspaceDocumentV2>, created: CreatedLocalChange,
  profile: LocalProfile, storage: WorkspaceStorage, reviewedChangeHash?: string,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  await assertWorkspaceWritesAllowed(base.id);
  const changeBytes = Automerge.getLastLocalChange(created.newDoc);
  if (!changeBytes) throw new Error("No change produced");
  const authorizations = await prepareLocalChangeAuthorizations(created.newDoc, profile, [created.receipt.changeHash]);
  const bundle = await exportDocumentAuthorizationBundle(created.newDoc, profile)
  bundle.records = mergeAuthorizationRecords(bundle.records as WorkspaceChangeAuthorization[], authorizations)
  const previousEvidence = await storage.loadCausalEvidence(base.id)
  // An all-admitted evidence snapshot is already represented by the authorized
  // base document. Reuse it instead of synchronously loading the full raw
  // history on every local write. Keep loading raw bytes when quarantined or
  // pending branches must remain available for reclassification.
  const preserveRawHistory = hasUnresolvedCausalChanges(previousEvidence)
  const rawBase = preserveRawHistory ? Automerge.load<WorkspaceDocumentV2>(previousEvidence!.bytes) : base
  let admission: Awaited<ReturnType<typeof evaluateIncomingWorkspaceAdmission>>
  try {
    admission = await evaluateIncomingWorkspaceAdmission(rawBase, created.newDoc, bundle,
      (previousEvidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[])
  } finally {
    if (preserveRawHistory) Automerge.free(rawBase)
  }
  const decision = admission.decisions.find(item => item.hash === created.receipt.changeHash)
  if (decision?.status.type !== "admitted")
    throw new Error(decision?.status.type === "quarantined" || decision?.status.type === "pending"
      ? `Local change failed causal admission: ${decision.status.reason}`
      : "Local change missing from causal admission")
  // A fully admitted plan leaves the locally created document unchanged. It is
  // already an Automerge handle, so loading the worker's equivalent snapshot
  // would decode the entire large workspace again on the UI thread.
  const allChangesAdmitted = canReuseAdmittedDocument(admission, Automerge.getHeads(created.newDoc))
  const authorizedDoc = allChangesAdmitted
    ? created.newDoc
    : Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
  const reviewMetadata = causalReviewMetadata(previousEvidence, reviewedChangeHash, created.receipt.changeHash)
  await storage.commitWorkspace(base.id, authorizedDoc, Automerge.save(authorizedDoc), admission.verifiedAuthorizations, {
    receipt: created.receipt, changeBytes, proof: created.proof,
  }, { bytes: admission.rawBytes, decisions: admission.decisions, authorizationEvidence: admission.authorizationEvidence,
    ...reviewMetadata });
  meshTrace("document.persisted", { workspaceId: base.id, recordId: created.receipt.changeHash, changeId: created.receipt.changeHash, phase: "local", component: "automerge", heads: Automerge.getHeads(authorizedDoc), bytes: changeBytes.byteLength });
  return authorizedDoc;
}

function causalReviewMetadata(
  previous: Awaited<ReturnType<WorkspaceStorage["loadCausalEvidence"]>>,
  sourceHash: string | undefined,
  authorizedChangeHash: string,
) {
  const resolved = new Map((previous?.resolvedReviews ?? []).map(review => [review.sourceHash, review.authorizedChangeHash]))
  const dismissed = new Set(previous?.dismissedHashes ?? [])
  if (sourceHash) { resolved.set(sourceHash, authorizedChangeHash); dismissed.add(sourceHash) }
  return {
    dismissedHashes: [...dismissed].sort(),
    resolvedReviews: [...resolved].map(([reviewSourceHash, authorizedHash]) => ({
      sourceHash: reviewSourceHash, authorizedChangeHash: authorizedHash,
    })),
  }
}

function hasUnresolvedCausalChanges(evidence: Awaited<ReturnType<WorkspaceStorage["loadCausalEvidence"]>>): boolean {
  return evidence?.decisions.some(decision => decision.status.type !== "admitted") ?? false;
}

export async function reconcile(storage = defaultStorage, workspaceChanged = false, changedWorkspaceId?: string): Promise<void> {
  if (!stateRuntime.ready.value || !stateRuntime.activeDoc)
    return;
  if (workspaceChanged) {
    stateRuntime.reconcileWorkspaceChanged = true;
    if (changedWorkspaceId) stateRuntime.reconcileWorkspaceIds.add(changedWorkspaceId);
    else stateRuntime.reconcileWorkspaceUnknown = true;
  }
  if (stateRuntime.reconcilePromise) {
    stateRuntime.reconcileRequested = true;
    return stateRuntime.reconcilePromise;
  }
  stateRuntime.reconcilePromise = (async () => {
    do {
      stateRuntime.reconcileRequested = false;
      const workspaceChanged = stateRuntime.reconcileWorkspaceChanged;
      stateRuntime.reconcileWorkspaceChanged = false;
      const workspaceIds = new Set(stateRuntime.reconcileWorkspaceIds);
      stateRuntime.reconcileWorkspaceIds.clear();
      const workspaceUnknown = stateRuntime.reconcileWorkspaceUnknown;
      stateRuntime.reconcileWorkspaceUnknown = false;
      await reconcileWorkspace(storage, workspaceChanged, workspaceIds, workspaceUnknown);
    } while (stateRuntime.reconcileRequested);
  })().finally(() => {
    stateRuntime.reconcilePromise = undefined;
  });
  return stateRuntime.reconcilePromise;
}

export async function refreshAvailableWorkspaces(
  storage = defaultStorage,
): Promise<void> {
  const catalog = await storage.listWorkspaceCatalog();
  const root = await storage.loadPersonalRoot();
  const profile = stateRuntime.currentProfile;
  const entitled = root && profile?.identity.personId === root.identity.personId
    ? new Set(Object.values(root.workspaces ?? {}).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
    : root ? new Set<string>() : undefined;
  stateRuntime.availableWorkspaces.value = entitled
    ? catalog.available.filter(workspace => entitled.has(workspace.id))
    : catalog.available;
  stateRuntime.archivedWorkspaces.value = entitled
    ? catalog.archived.filter(workspace => entitled.has(workspace.id))
    : catalog.archived;
  const meta = stateRuntime.activeWorkspaceMeta;
  if (
    meta.id && !stateRuntime.activeDoc?.archivedAt && (!entitled || entitled.has(meta.id)) &&
    !stateRuntime.availableWorkspaces.value.some(
      (workspace) => workspace.id === meta.id,
    )
  ) {
    stateRuntime.availableWorkspaces.value.unshift({
      id: meta.id,
      title: meta.title,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function notifyLocalChanges(workspaceId?: string): void {
  for (const listener of stateRuntime.localChangeListeners) listener(workspaceId);
}

async function loadInitialWorkspace(
  storage: WorkspaceStorage,
  profile: LocalProfile,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const initialId = await activeWorkspaceId();
  const loaded = await loadPreferredWorkspace(storage, initialId);
  if (loaded) return loaded.doc;
  const doc = await initializeFirstWorkspace(
    storage,
    profile,
  );
  if (!doc) throw new Error("Workspace initialization failed");
  return doc;
}

async function activeWorkspaceId(): Promise<string> {
  return await readLocal("tincanban.active_workspace_id") ?? "default";
}

async function loadPreferredWorkspace(
  storage: WorkspaceStorage,
  initialId: string,
) {
  const root = await storage.loadPersonalRoot();
  const entitledIds = root
    ? new Set(Object.values(root.workspaces ?? {}).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
    : undefined;
  const preferred = !entitledIds || entitledIds.has(initialId)
    ? await storage.loadWorkspaceDoc(initialId)
    : null;
  if (preferred && !preferred.doc.archivedAt) return preferred;
  const fallback = initialId === "default" || (entitledIds && !entitledIds.has("default"))
    ? null : await storage.loadWorkspaceDoc("default");
  return fallback && !fallback.doc.archivedAt ? fallback : null;
}

async function initializeFirstWorkspace(
  storage: WorkspaceStorage,
  profile: LocalProfile,
) {
  const initialize = async () => {
    const catalogRoot = await storage.loadPersonalRoot();
    const entitledIds = catalogRoot
      ? new Set(Object.values(catalogRoot.workspaces ?? {}).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
      : undefined;
    const existing = (await storage.listWorkspaces()).filter(workspace => !entitledIds || entitledIds.has(workspace.id));
    const first = existing[0];
    if (first) return (await storage.loadWorkspaceDoc(first.id))?.doc ?? null;
    const workspaceId = crypto.randomUUID();
    const doc = Automerge.from<WorkspaceDocumentV2>(
      createWorkspaceDoc(workspaceId, "Untitled", profile.identity.personId, "blank"),
    );
    await recordGenesisAuthority(doc, profile);
    await storage.saveSnapshot(workspaceId, doc, Automerge.save(doc));
    await storage.registerWorkspace(workspaceId, "Untitled");
    await registerWorkspaceInCurrentRoot(storage, profile, workspaceId, "genesis");
    await writeLocal("tincanban.active_workspace_id", workspaceId);
    return doc;
  };
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("tincanban-first-workspace", initialize)
    : initialize();
}

async function persistCommand(
  workspaceId: string,
  command: Command,
  profile: LocalProfile,
  storage: WorkspaceStorage,
): Promise<void> {
  await withWorkspaceMutation(workspaceId, async () => {
    const base = await latestWorkspaceDocument(workspaceId, storage);
    const next = await commitAuthorizedCommand(base, command, profile, storage);
    if (stateRuntime.activeDoc?.id === workspaceId) {
      updateReactiveState(next);
      await refreshCausalReview(storage, workspaceId);
    }
    stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId });
    notifyLocalChanges(workspaceId);
  });
}

async function latestWorkspaceDocument(
  workspaceId: string,
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const local =
    stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null;
  const stored = (await storage.loadWorkspaceDoc(workspaceId, local ?? undefined))?.doc ?? null;
  if (!local && !stored) throw new Error("Workspace not hydrated");
  const hasCausalEvidence = Boolean(stored && await storage.loadCausalEvidence(workspaceId));
  return chooseLatestWorkspaceDocument(local, stored, hasCausalEvidence);
}

function chooseLatestWorkspaceDocument(local: Automerge.Doc<WorkspaceDocumentV2> | null,
  stored: Automerge.Doc<WorkspaceDocumentV2> | null, hasCausalEvidence: boolean): Automerge.Doc<WorkspaceDocumentV2> {
  if (!local) return stored!
  if (!stored || hasCausalEvidence || Automerge.getHeads(local).sort().join() === Automerge.getHeads(stored).sort().join()) return stored ?? local
  return Automerge.merge(Automerge.clone(local), Automerge.clone(stored))
}

function ensureContentWrite(role: WorkspaceRole): void {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write");
}

async function reconcileWorkspace(storage: WorkspaceStorage, workspaceChanged = false,
  changedWorkspaceIds = new Set<string>(), workspaceUnknown = false): Promise<void> {
  const active = stateRuntime.activeDoc;
  if (!active) return;
  await refreshAvailableWorkspaces(storage);
  const loaded = await storage.loadWorkspaceDoc(active.id, active);
  const activeChanged = loaded &&
    Automerge.getHeads(active).sort().join(",") !== loaded.heads.join(",");
  if (activeChanged) {
    updateReactiveState(loaded.doc);
  }
  await refreshCausalReview(storage, active.id);
  if (workspaceUnknown) {
    notifyLocalChanges();
    return;
  }
  const changedIds = new Set(changedWorkspaceIds);
  if (activeChanged) changedIds.add(active.id);
  for (const id of changedIds) notifyLocalChanges(id);
  if (workspaceChanged && changedIds.size === 0) notifyLocalChanges();
}

function clearWorkspaceProjection(): void {
  const workspace = stateRuntime.workspace;
  workspace.leads.splice(0, workspace.leads.length);
  workspace.documents.splice(0, workspace.documents.length);
  workspace.templates.splice(0, workspace.templates.length);
  workspace.artifacts.splice(0, workspace.artifacts.length);
}

function replaceWorkspaceProjection(
  projected: typeof stateRuntime.workspace,
): void {
  const workspace = stateRuntime.workspace;
  workspace.leads.splice(0, workspace.leads.length, ...projected.leads);
  workspace.documents.splice(
    0,
    workspace.documents.length,
    ...projected.documents,
  );
  workspace.templates.splice(
    0,
    workspace.templates.length,
    ...projected.templates,
  );
  workspace.artifacts.splice(
    0,
    workspace.artifacts.length,
    ...projected.artifacts,
  );
}

stateRuntime.storageChannel?.addEventListener("message", (event: MessageEvent<{ type?: unknown; workspaceId?: unknown }>) => {
  if (event.data?.type !== "workspace-persisted") return;
  void reconcile(defaultStorage, true,
    typeof event.data.workspaceId === "string" ? event.data.workspaceId : undefined);
});
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    void reconcile();
  });
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (!globalThis.document.hidden) void reconcile();
  });
}
