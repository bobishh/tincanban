import type { Preset } from "./domain/seeds"
import type * as Automerge from "@automerge/automerge/slim";
import { reactive, ref, type Ref } from "vue";
import type { LocalProfile } from "./domain/identity";
import type { WorkspaceDocumentV2 } from "./domain/model";
import type { Workspace } from "./types";

type WorkspaceSummary = { id: string; title: string; updatedAt: string };
type ActiveWorkspaceMeta = {
  id: string;
  title: string;
  presetKey: Preset;
};

export type StateRuntime = {
  workspace: Workspace;
  ready: { value: boolean };
  startupStage: Ref<"starting" | "reading" | "updating" | "history" | "access">;
  saveState: Ref<"idle" | "saving" | "saved" | "error">;
  docVersion: Ref<number>;
  availableWorkspaces: Ref<WorkspaceSummary[]>;
  archivedWorkspaces: Ref<WorkspaceSummary[]>;
  causalReview: Ref<Array<{ hash: string; status: { type: "quarantined" | "pending"; reason: string };
    actor: string; time: number; action: string; preview: string[]; dismissed?: boolean; resolved?: boolean; personId?: string; deviceId?: string }>>;
  causalReviewError: Ref<string>;
  activeWorkspaceMeta: ActiveWorkspaceMeta;
  activeDoc: Automerge.Doc<WorkspaceDocumentV2> | null;
  currentProfile: LocalProfile | null;
  pendingWrites: number;
  batchSaveFailed: boolean;
  localChangeListeners: Set<(workspaceId?: string) => void>;
  storageChannel: BroadcastChannel | undefined;
  reconcilePromise: Promise<void> | undefined;
  reconcileRequested: boolean;
  reconcileWorkspaceChanged: boolean;
  reconcileWorkspaceIds: Set<string>;
  reconcileWorkspaceUnknown: boolean;
};

export const stateRuntime: StateRuntime = {
  workspace: reactive<Workspace>({
    items: [],
    documents: [],
    templates: [],
    artifacts: [],
  }),
  ready: reactive({ value: false }),
  startupStage: ref("starting"),
  saveState: ref("idle"),
  docVersion: ref(0),
  availableWorkspaces: ref([]),
  archivedWorkspaces: ref([]),
  causalReview: ref([]),
  causalReviewError: ref(""),
  activeWorkspaceMeta: reactive({
    id: "",
    title: "Untitled",
    presetKey: "blank",
  }),
  activeDoc: null,
  currentProfile: null,
  pendingWrites: 0,
  batchSaveFailed: false,
  localChangeListeners: new Set(),
  storageChannel:
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel("tincanban-workspace"),
  reconcilePromise: undefined,
  reconcileRequested: false,
  reconcileWorkspaceChanged: false,
  reconcileWorkspaceIds: new Set(),
  reconcileWorkspaceUnknown: false,
};
