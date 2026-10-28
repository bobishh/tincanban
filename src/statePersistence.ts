import { hasEntityKind, validateWorkspaceDoc } from "./domain/model"
import { recoverPendingIdentityDeviceActivation } from "./sync/identityDeviceActivationLoader"
import * as Automerge from "@automerge/automerge/slim";
import { initializeAutomerge } from "./crdt";
import {
  bootstrapIdentity,
  type LocalProfile,
} from "./domain/identity";
import { initializePersonalRootCatalog, registerWorkspaceInCurrentRoot } from "./statePersonalRoot";
import { createWorkspaceDoc } from "./domain/seeds";
import { migrateOwnedWorkspaces } from "./stateStartupMigration";
import { type Board, type WorkspaceDocumentV2 } from "./domain/model";
import type { Command } from "./domain/commands";
import { recordGenesisAuthority } from "./sync/changeAuthorization";
import {
  defaultStorage,
  type WorkspaceStorage,
  type WorkspaceTransactionContext,
} from "./storage";
import { projectWorkspace } from "./stateProjection";
import { withWorkspaceMutation } from "./workspaceMutation";
import { stateRuntime } from "./stateContext";
import { readLocal, writeLocal } from "./localDb";
import { loadReviewAction, refreshCausalReview } from "./stateCausalReviewLoader";
import type { CausalReviewCallbacks } from "./stateCausalReviewLoader";
import { assertWorkspaceWritesAllowed, reclassifyStoredWorkspace } from "./stateCausalAdmission";
import { applyInjectedFixture } from "./stateInjectedFixture";
import { clearPendingItemMoves } from "./pendingItemMoves";
import { startPendingWrite } from "./statePendingWrites";
import { diagnoseStartupStep, diagnoseStartupOperation } from "./sync/startupDiagnostics";
import type { Context } from "@opentelemetry/api";
import { prepareLocalDeltaAdmission } from "./stateDeltaAdmission";
import { requestWebLock } from "./webLock"
import { commitAuthorizedCommand, persistNewLocalChange } from "./stateLocalChangePersistence";

type ReadinessWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

const readinessWaiters = new Set<ReadinessWaiter>();

export function resetStateForTest(): void {
  stateRuntime.workspaceSelectionVersion++;
  stateRuntime.workspaceSelectionPending = null;
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

export async function prepareLocalState(storage = defaultStorage, diagnosticContext?: Context): Promise<void> {
  const step = <T>(name: string, action: () => T | Promise<T>, detail: Record<string, unknown> = {}) =>
    diagnoseStartupStep(name, action, detail, diagnosticContext);
  try {
    stateRuntime.startupStage.value = "reading";
    console.info("[tincanban.startup] prepare", "automerge")
    await step("automerge-wasm", initializeAutomerge);
    console.info("[tincanban.startup] prepare", "identity")
    stateRuntime.currentProfile = await step("identity-load", bootstrapIdentity);
    const recoveryProfile = stateRuntime.currentProfile;
    await step("workspace-backup-recovery", async () => {
      const { resumeWorkspaceHistoryRecoveryProjection } = await import("./sync/workspaceHistoryRecoveryProjection");
      await resumeWorkspaceHistoryRecoveryProjection(recoveryProfile.identity.personId, () => {
        if (stateRuntime.currentProfile?.identity.personId !== recoveryProfile.identity.personId ||
          stateRuntime.currentProfile?.device.deviceId !== recoveryProfile.device.deviceId) {
          throw new Error("Identity changed during workspace recovery");
        }
      });
    });
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

export async function hydratePreparedState(storage = defaultStorage, diagnosticContext?: Context): Promise<void> {
  const step = <T>(name: string, action: () => T | Promise<T>, detail: Record<string, unknown> = {}) =>
    diagnoseStartupStep(name, action, detail, diagnosticContext);
  try {
    const profile = stateRuntime.currentProfile;
    if (!profile) throw new Error("Local identity is unavailable");
    console.info("[tincanban.startup] hydrate", "workspace")
    let doc = await diagnoseStartupOperation("initial-workspace-load", parent => loadInitialWorkspace(storage, profile, parent), {}, diagnosticContext);
    // Publish only the saved projection, never the separate raw causal history.
    // Readiness stays false until local history checks finish.
    if (validateWorkspaceDoc(doc).ok) await step("workspace-preview", () => updateReactiveState(doc), { workspaceId: doc.id });
    stateRuntime.startupStage.value = "updating";
    await step("workspace-migrations", () => migrateOwnedWorkspaces(storage, profile,
      source => persistAuthorizedCommand(source, { kind: "migrateWorkspaceFormat" }, profile, storage)));
    stateRuntime.startupStage.value = "history";
    const reclassified = await diagnoseStartupOperation("history-reclassification", parent => reclassifyStoredWorkspace(doc.id, storage, parent), { workspaceId: doc.id, operationCount: Automerge.stats(doc).numOps }, diagnosticContext);
    doc = reclassified.doc ?? (await storage.loadWorkspaceDoc(doc.id))?.doc ?? doc;
    await step("workspace-projection", () => updateReactiveState(doc), { workspaceId: doc.id });
    await step("causal-review", () => refreshCausalReview(storage, doc.id), { workspaceId: doc.id });
    console.info("[tincanban.startup] hydrate", "personal-root")
    await step("personal-root-load", () => initializePersonalRootCatalog(storage, profile));
    await step("identity-device-recovery", () => recoverPendingIdentityDeviceActivation(profile.identity.personId, () => {
      if (stateRuntime.currentProfile?.identity.personId !== profile.identity.personId ||
        stateRuntime.currentProfile?.device.deviceId !== profile.device.deviceId) throw new Error("Identity changed during device-state recovery");
    }));
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
  await prepareLocalDeltaAdmission(doc.id, storage, profile)
  return storage.withWorkspaceTransaction(doc.id, async transaction => {
    const stored = (await transaction.loadWorkspaceDoc())?.doc;
    const base = stored ? mergeWorkspaceDocuments(stored, doc) : doc;
    let result: Automerge.Doc<WorkspaceDocumentV2> | undefined
    try {
      result = await commitAuthorizedCommand(base, command, profile, storage, transaction);
      return result;
    } finally {
      if (stored) Automerge.free(stored)
      if (stored && result !== base) Automerge.free(base)
    }
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

export async function reconcile(storage = defaultStorage, workspaceChanged = false, changedWorkspaceId?: string): Promise<void> {
  if (!stateRuntime.ready.value || !stateRuntime.activeDoc)
    return;
  if (workspaceChanged) {
    stateRuntime.reconcileWorkspaceChanged = true;
    if (changedWorkspaceId) stateRuntime.reconcileWorkspaceIds.add(changedWorkspaceId);
    else stateRuntime.reconcileWorkspaceUnknown = true;
  }
  const pendingReconciliation: Promise<void> | undefined = stateRuntime.reconcilePromise
  if (pendingReconciliation) {
    stateRuntime.reconcileRequested = true;
    return pendingReconciliation;
  }
  const reconciliation: Promise<void> = (async (): Promise<void> => {
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
  stateRuntime.reconcilePromise = reconciliation;
  return reconciliation;
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
  diagnosticContext?: Context,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const initialId = await activeWorkspaceId();
  const loaded = await loadPreferredWorkspace(storage, initialId, diagnosticContext);
  if (loaded) return loaded.doc;
  const doc = await initializeFirstWorkspace(
    storage,
    profile, diagnosticContext,
  );
  if (!doc) throw new Error("Workspace initialization failed");
  return doc;
}

async function activeWorkspaceId(): Promise<string> {
  return await readLocal("tincanban.active_workspace_id") ?? "default";
}

function loadStartupWorkspace(storage: WorkspaceStorage, workspaceId: string, diagnosticContext?: Context) {
  return storage.loadWorkspaceDoc(workspaceId, undefined, (stage, read, detail) =>
    diagnoseStartupStep(`initial-workspace-${stage}`, read, { ...detail, workspaceId }, diagnosticContext));
}

async function loadPreferredWorkspace(
  storage: WorkspaceStorage,
  initialId: string,
  diagnosticContext?: Context,
) {
  const root = await storage.loadPersonalRoot();
  const entitledIds = root
    ? new Set(Object.values(root.workspaces ?? {}).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
    : undefined;
  const preferred = !entitledIds || entitledIds.has(initialId)
    ? await loadStartupWorkspace(storage, initialId, diagnosticContext)
    : null;
  if (preferred && !preferred.doc.archivedAt) return preferred;
  const fallback = initialId === "default" || (entitledIds && !entitledIds.has("default"))
    ? null : await loadStartupWorkspace(storage, "default", diagnosticContext);
  return fallback && !fallback.doc.archivedAt ? fallback : null;
}

async function initializeFirstWorkspace(
  storage: WorkspaceStorage,
  profile: LocalProfile,
  diagnosticContext?: Context,
): Promise<Automerge.Doc<WorkspaceDocumentV2> | null> {
  const initialize = async (): Promise<Automerge.Doc<WorkspaceDocumentV2> | null> => {
    const catalogRoot = await storage.loadPersonalRoot();
    const entitledIds = catalogRoot
      ? new Set(Object.values(catalogRoot.workspaces ?? {}).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
      : undefined;
    const existing = (await storage.listWorkspaces()).filter(workspace => !entitledIds || entitledIds.has(workspace.id));
    const first = existing[0];
    if (first) return (await loadStartupWorkspace(storage, first.id, diagnosticContext))?.doc ?? null;
    const workspaceId = crypto.randomUUID();
    const doc = Automerge.from<WorkspaceDocumentV2>(
      createWorkspaceDoc(workspaceId, "Untitled", profile.identity.personId, "blank"),
    );
    let committed: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let docReleased = false
    try {
      const authorizations = await recordGenesisAuthority(doc, profile);
      committed = await storage.withWorkspaceTransaction(workspaceId, async transaction => {
        const existing = await transaction.loadWorkspaceDoc()
        if (existing) return existing.doc
        await transaction.commitWorkspace(doc, Automerge.save(doc), authorizations)
        return doc
      })
      if (committed !== doc) {
        Automerge.free(doc)
        docReleased = true
      }
      await registerWorkspaceInCurrentRoot(storage, profile, workspaceId, "genesis");
      await writeLocal("tincanban.active_workspace_id", workspaceId);
      return committed;
    } catch (error) {
      if (!docReleased) Automerge.free(doc)
      if (committed && committed !== doc) Automerge.free(committed)
      throw error
    }
  };
  return typeof navigator !== "undefined" && navigator.locks
    ? requestWebLock("tincanban-first-workspace", initialize)
    : initialize();
}

async function persistCommand(
  workspaceId: string,
  command: Command,
  profile: LocalProfile,
  storage: WorkspaceStorage,
): Promise<void> {
  await prepareLocalDeltaAdmission(workspaceId, storage, profile)
  await storage.withWorkspaceTransaction(workspaceId, async transaction => {
    const borrowed = stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null;
    let base: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let next: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let retained: Automerge.Doc<WorkspaceDocumentV2> | undefined
    try {
      base = await latestWorkspaceDocument(workspaceId, storage, transaction);
      next = await commitAuthorizedCommand(base, command, profile, storage, transaction);
      if (stateRuntime.activeDoc?.id === workspaceId) {
        retained = next
        updateReactiveState(next);
        next = undefined
        await refreshCausalReview(storage, workspaceId);
      }
      stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId });
      notifyLocalChanges(workspaceId);
    } finally {
      if (base && base !== borrowed && base !== retained) Automerge.free(base)
      if (next) Automerge.free(next)
    }
  });
}

async function latestWorkspaceDocument(
  workspaceId: string,
  storage: WorkspaceStorage,
  transaction?: WorkspaceTransactionContext,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const local =
    stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null;
  const stored = (transaction
    ? await transaction.loadWorkspaceDoc()
    : await storage.loadWorkspaceDoc(workspaceId, local ?? undefined))?.doc ?? null;
  if (!local && !stored) throw new Error("Workspace not hydrated");
  try {
    const hasCausalEvidence = Boolean(stored && await storage.hasCausalEvidence(workspaceId));
    const selected = chooseLatestWorkspaceDocument(local, stored, hasCausalEvidence);
    if (stored && selected !== stored) Automerge.free(stored)
    return selected
  } catch (error) {
    if (stored) Automerge.free(stored)
    throw error
  }
}

function chooseLatestWorkspaceDocument(local: Automerge.Doc<WorkspaceDocumentV2> | null,
  stored: Automerge.Doc<WorkspaceDocumentV2> | null, hasCausalEvidence: boolean): Automerge.Doc<WorkspaceDocumentV2> {
  if (!local) return stored!
  if (!stored || hasCausalEvidence || Automerge.getHeads(local).sort().join() === Automerge.getHeads(stored).sort().join()) return stored ?? local
  return mergeWorkspaceDocuments(local, stored)
}

function mergeWorkspaceDocuments(left: Automerge.Doc<WorkspaceDocumentV2>, right: Automerge.Doc<WorkspaceDocumentV2>) {
  const leftCopy = Automerge.clone(left)
  const rightCopy = Automerge.clone(right)
  try {
    return Automerge.merge(leftCopy, rightCopy)
  } catch (error) {
    Automerge.free(leftCopy)
    throw error
  } finally {
    Automerge.free(rightCopy)
  }
}

async function reconcileWorkspace(storage: WorkspaceStorage, workspaceChanged = false,
  changedWorkspaceIds = new Set<string>(), workspaceUnknown = false): Promise<void> {
  const active = stateRuntime.activeDoc;
  if (!active) return;
  await refreshAvailableWorkspaces(storage);
  const activeChanged = await withWorkspaceMutation(active.id, async () => {
    const current = stateRuntime.activeDoc;
    if (current?.id !== active.id) return false;
    const loaded = await storage.loadWorkspaceDoc(current.id, current);
    if (stateRuntime.activeDoc?.id !== current.id) return false;
    const changed = loaded && Automerge.getHeads(current).sort().join(",") !== loaded.heads.join(",");
    if (changed) updateReactiveState(loaded.doc);
    await refreshCausalReview(storage, current.id);
    return Boolean(changed);
  });
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
  workspace.items.splice(0, workspace.items.length);
  workspace.documents.splice(0, workspace.documents.length);
  workspace.templates.splice(0, workspace.templates.length);
  workspace.artifacts.splice(0, workspace.artifacts.length);
}

function replaceWorkspaceProjection(
  projected: typeof stateRuntime.workspace,
): void {
  const workspace = stateRuntime.workspace;
  workspace.items.splice(0, workspace.items.length, ...projected.items);
  workspace.documents.splice(0, workspace.documents.length, ...projected.documents);
  workspace.templates.splice(0, workspace.templates.length, ...projected.templates);
  workspace.artifacts.splice(0, workspace.artifacts.length, ...projected.artifacts);
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
