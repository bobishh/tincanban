import type { Preset } from "./domain/seeds"
import * as Automerge from "@automerge/automerge/slim";
import type { WorkspaceRole } from "./domain/permissions";
import { bootstrapIdentity } from "./domain/identity";
import { createWorkspaceDoc, type WorkspaceCreationDraft } from "./domain/seeds";
import type { WorkspaceDocumentV2 } from "./domain/model";
import { registerWorkspaceInRoot } from "./domain/personalRoot";
import { recordGenesisAuthority, workspaceRole } from "./sync/changeAuthorization";
import { defaultStorage, type WorkspaceStorage } from "./storage";
import {
  commitAndPersist,
  persistAuthorizedCommand,
  refreshAvailableWorkspaces,
  updateReactiveState,
} from "./statePersistence";
import { stateRuntime } from "./stateContext";
import { writeLocal } from "./localDb";

export function createWorkspaceActions() {
  return {
    createWorkspaceAsync,
    importWorkspaceAsNew,
    switchWorkspace,
    getWorkspaceRole,
    renameWorkspaceAsync,
    archiveWorkspaceAsync,
    restoreWorkspaceAsync,
  };
}

async function createWorkspaceAsync(
  title: string,
  presetKey: Preset,
  storage = defaultStorage,
  creationDraft?: WorkspaceCreationDraft,
) {
  const profile = await requireProfile();
  const id = crypto.randomUUID();
  const cleanTitle = title.trim();
  if (creationDraft) {
    const { validateBoardSchemaDraft } = await import("./domain/schema")
    const validation = validateBoardSchemaDraft(creationDraft)
    if (!validation.valid) throw new Error(validation.errors[0]?.message ?? "Board configuration is invalid")
  }
  const initialDocument = creationDraft
    ? await import("./domain/workspaceCreation").then(({ createWorkspaceDocFromDraft }) => createWorkspaceDocFromDraft(id, cleanTitle, profile.identity.personId, presetKey, creationDraft))
    : createWorkspaceDoc(id, cleanTitle, profile.identity.personId, presetKey)
  const doc = Automerge.from<WorkspaceDocumentV2>(initialDocument)
  await recordGenesisAuthority(doc, profile);
  await storage.saveSnapshot(id, doc, Automerge.save(doc));
  await addWorkspaceToPersonalRoot(id, "genesis", storage);
  await saveActiveWorkspaceId(id);
  updateReactiveState(doc);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId: id });
  return doc;
}

async function importWorkspaceAsNew(
  source: WorkspaceDocumentV2,
  storage = defaultStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const profile = await requireProfile();
  const { forkWorkspaceDocumentV2 } = await import("./domain/workspaceBundle");
  const copied = forkWorkspaceDocumentV2(
    source,
    crypto.randomUUID(),
    profile.identity.personId,
  );
  if (!copied.ok) throw new Error(copied.error.message);
  const doc = copied.value;
  await recordGenesisAuthority(doc, profile);
  await storage.saveSnapshot(doc.id, doc, Automerge.save(doc));
  await addWorkspaceToPersonalRoot(doc.id, "genesis", storage);
  await saveActiveWorkspaceId(doc.id);
  updateReactiveState(doc);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId: doc.id });
  return doc;
}

export async function switchWorkspace(
  workspaceId: string,
  storage = defaultStorage,
): Promise<void> {
  const loaded = await storage.loadWorkspaceDoc(workspaceId);
  if (!loaded) return;
  const doc = loaded.doc;
  if (doc.archivedAt) return;
  await saveActiveWorkspaceId(workspaceId);
  updateReactiveState(doc);
}

async function getWorkspaceRole(
  workspaceId: string,
  storage = defaultStorage,
): Promise<WorkspaceRole> {
  const profile = await requireProfile();
  const doc =
    stateRuntime.activeDoc?.id === workspaceId
      ? stateRuntime.activeDoc
      : (await storage.loadWorkspaceDoc(workspaceId))?.doc;
  if (!doc) throw new Error("Workspace not found");
  return workspaceRole(doc, profile);
}

async function renameWorkspaceAsync(
  workspaceId: string,
  title: string,
  storage = defaultStorage,
): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error("Workspace name is required");
  const profile = await requireProfile();
  if (stateRuntime.activeDoc?.id === workspaceId)
    await commitAndPersist(
      { kind: "renameWorkspace", title: cleanTitle },
      storage,
    );
  else await renameInactiveWorkspace(workspaceId, cleanTitle, profile, storage);
  await refreshAvailableWorkspaces(storage);
}

async function renameInactiveWorkspace(
  workspaceId: string,
  title: string,
  profile: Awaited<ReturnType<typeof requireProfile>>,
  storage: WorkspaceStorage,
): Promise<void> {
  const loaded = await storage.loadWorkspaceDoc(workspaceId);
  if (!loaded) throw new Error("Workspace not found");
  await persistAuthorizedCommand(
    loaded.doc,
    { kind: "renameWorkspace", title },
    profile,
    storage,
  );
}

async function archiveWorkspaceAsync(
  workspaceId: string,
  storage = defaultStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2> | undefined> {
  const wasActive = stateRuntime.activeDoc?.id === workspaceId;
  if (wasActive) await commitAndPersist({ kind: "setWorkspaceArchived", archived: true }, storage);
  else {
    const loaded = await storage.loadWorkspaceDoc(workspaceId);
    if (!loaded) throw new Error("Workspace not found");
    await persistAuthorizedCommand(loaded.doc, { kind: "setWorkspaceArchived", archived: true }, await requireProfile(), storage);
  }
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId });
  if (wasActive) return selectWorkspaceReplacement(storage);
}

async function restoreWorkspaceAsync(workspaceId: string, storage = defaultStorage): Promise<void> {
  const loaded = await storage.loadWorkspaceDoc(workspaceId);
  if (!loaded) throw new Error("Workspace not found");
  const doc = loaded.doc;
  await persistAuthorizedCommand(doc, { kind: "setWorkspaceArchived", archived: false }, await requireProfile(), storage);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId });
}

async function selectWorkspaceReplacement(
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2> | undefined> {
  const replacement = stateRuntime.availableWorkspaces.value[0];
  if (replacement) {
    await switchWorkspace(replacement.id, storage);
    return undefined;
  }
  return createWorkspaceAsync("Untitled", "blank", storage);
}

export async function addWorkspaceToPersonalRoot(
  id: string,
  source: "genesis" | "import",
  storage: WorkspaceStorage,
): Promise<void> {
  const root = await storage.loadPersonalRoot();
  if (!root) return;
  await storage.updatePersonalRootForIdentity(root.identity.personId, current => {
    if (!current) return null;
    registerWorkspaceInRoot(current, id, id, source);
    return current;
  });
}

export async function requireProfile() {
  if (!stateRuntime.currentProfile)
    stateRuntime.currentProfile = await bootstrapIdentity();
  return stateRuntime.currentProfile;
}

async function saveActiveWorkspaceId(id: string): Promise<void> {
  await writeLocal("tincanban.active_workspace_id", id);
}
