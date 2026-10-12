import * as Automerge from "@automerge/automerge/slim";
import { bootstrapIdentity } from "./domain/identity";
import { commitAndPersist, dismissCausalChange, reconcile, restoreCausalChange, reviewCausalChange, whenReady } from "./statePersistence";
import { stateRuntime } from "./stateContext";
import { createStateDerived } from "./stateDerived";
import { createWorkspaceActions } from "./stateWorkspaceActions";
import { createLeadActions } from "./stateLeadActions";
import { createContentActions } from "./stateContentActions";
import { createSyncActions } from "./stateSyncActions";
import { projectPendingItemMoves } from "./pendingItemMoves";

export function createTincanbanActions() {
  const derived = createStateDerived();
  return {
    workspace: stateRuntime.workspace,
    ready: stateRuntime.ready,
    startupStage: stateRuntime.startupStage,
    saveState: stateRuntime.saveState,
    ...derived,
    availableWorkspaces: stateRuntime.availableWorkspaces,
    archivedWorkspaces: stateRuntime.archivedWorkspaces,
    causalReview: stateRuntime.causalReview,
    causalReviewError: stateRuntime.causalReviewError,
    activeWorkspace: stateRuntime.activeWorkspaceMeta,
    docVersion: stateRuntime.docVersion,
    ...createWorkspaceActions(),
    ...createLeadActions(derived.activeBoard),
    ...createContentActions(),
    executeCommandAsync: commitAndPersist,
    executeWorkspaceCommandAsync: (id: string, command: Parameters<typeof commitAndPersist>[0]) => commitAndPersist(command, undefined, id),
    reviewCausalChange,
    dismissCausalChange,
    restoreCausalChange,
    getActiveDoc: () => stateRuntime.activeDoc,
    getPresentedWorkspaceDoc: () => {
      void stateRuntime.docVersion.value;
      return stateRuntime.activeDoc ? projectPendingItemMoves(stateRuntime.activeDoc) : null;
    },
    whenReady,
    getCurrentProfile: () => stateRuntime.currentProfile,
    refreshIdentity,
    reconcile,
    getAutomergeBytes: () =>
      stateRuntime.activeDoc
        ? Automerge.save(stateRuntime.activeDoc)
        : new Uint8Array(),
    ...createSyncActions(),
  };
}

async function refreshIdentity(): Promise<void> {
  stateRuntime.currentProfile = await bootstrapIdentity();
  stateRuntime.docVersion.value += 1;
}
