import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { reclassifyStoredWorkspace, sameWorkspaceHeads } from "./stateCausalAdmission"
import { stateRuntime } from "./stateContext"
import type * as IncomingWorkspace from "./stateIncomingWorkspace"
import { publishCommittedWorkspace, refreshCausalReview, refreshAvailableWorkspaces, updateReactiveState } from "./statePersistence"
import { addWorkspaceToPersonalRoot, requireProfile, switchWorkspace } from "./stateWorkspaceActions"
import { defaultStorage, type WorkspaceStorage } from "./storage"
import { WorkspaceUnavailableError } from "./workspaceAvailability"

export function createSyncActions() {
  return {
    readWorkspaceDoc,
    withWorkspaceDoc,
    readWorkspaceHeads,
    readWorkspaceBytes,
    recordVerifiedOwnerWorkspace,
    reclassifyWorkspace,
    switchWorkspace: switchWorkspaceWithAdmission,
    validateAuthorizedWorkspace: async (...args: Parameters<typeof IncomingWorkspace.validateAuthorizedWorkspace>) =>
      (await loadIncomingWorkspace()).validateAuthorizedWorkspace(...args),
    mergeAuthorizedWorkspace,
    commitReceivedWorkspace: async (...args: Parameters<typeof IncomingWorkspace.commitReceivedWorkspace>) =>
      (await loadIncomingWorkspace()).commitReceivedWorkspace(...args),
    importWorkspaceDocument: async (...args: Parameters<typeof IncomingWorkspace.importWorkspaceDocument>) =>
      (await loadIncomingWorkspace()).importWorkspaceDocument(...args),
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
      if (stateRuntime.activeDoc?.id === id && !sameWorkspaceHeads(stateRuntime.activeDoc, result.doc)) {
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

/** Read within the lease: native documents must not escape the callback. Active documents remain borrowed. */
async function withWorkspaceDoc<T>(id: string, read: (doc: Automerge.Doc<WorkspaceDocumentV2>) => T | Promise<T>,
  storage = defaultStorage): Promise<T> {
  const lease = await readWorkspaceDocLease(id, storage)
  try { return await read(lease.doc) }
  finally { if (lease.owned) Automerge.free(lease.doc) }
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

function loadIncomingWorkspace() {
  return import("./stateIncomingWorkspace")
}

async function mergeAuthorizedWorkspace(...args: Parameters<typeof IncomingWorkspace.mergeAuthorizedWorkspace>) {
  return (await loadIncomingWorkspace()).mergeAuthorizedWorkspace(...args)
}

function subscribeLocalChanges(listener: (workspaceId?: string) => void): () => void {
  stateRuntime.localChangeListeners.add(listener);
  return () => stateRuntime.localChangeListeners.delete(listener);
}
