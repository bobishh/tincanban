import type * as Automerge from "@automerge/automerge/slim";
import type {
  ChangeProof,
  CommandErrorCode,
  CommandResult,
  FieldValue,
  FileReference,
  Heads,
  TransactionReceipt,
  WorkspaceDocumentV2,
} from "./model";
import type { BoardSchemaDraft } from "./schema";
import type { WorkspaceSettingsDraft } from "./workspaceSettings";
import type { AutomationDefinition } from "./automationContract";
import type { AutomationDesiredState } from "./automationLifecycle";

export type NarrativeFoldSources = { expectedBody: string; notesFieldId?: string; expectedNotes?: FieldValue; notes: Array<{ id: string; title: string; content: string | null; format: "markdown" | "html" | "pdf" | "file" | "path" }> };

export type Command =
  | { kind: "migrateWorkspaceFormat" }
  | { kind: "createWorkspace"; title: string; preset: "job-search" | "blank" }
  | { kind: "renameWorkspace"; title: string }
  | { kind: "setWorkspaceArchived"; archived: boolean }
  | { kind: "createBoard"; title: string; preset: "job-search" | "blank" }
  | { kind: "createColumn"; boardId: string; title: string; archive?: true; collapsible?: boolean; beforeId?: string | null }
  | { kind: "createItem"; id?: string; parentId: string; title: string; body?: string; values?: Record<string, FieldValue>; beforeId?: string | null }
  | { kind: "patchItem"; entityId: string; title?: string; body?: string; values?: Record<string, FieldValue>; foldNarrativeSources?: NarrativeFoldSources }
  | { kind: "restoreItemVersion"; entityId: string; changeHash: string }
  | { kind: "moveEntity"; entityId: string; parentId: string; beforeId?: string | null }
  | { kind: "renameEntity"; entityId: string; title: string; collapsible?: boolean }
  | { kind: "setEntityArchived"; entityId: string; archived: boolean }
  | { kind: "restoreAndMove"; entityId: string; parentId: string; beforeId?: string | null }
  | {
      kind: "createField";
      boardId: string;
      title: string;
      valueType: string;
      required: boolean;
      min?: number | null;
      max?: number | null;
      options?: Record<string, { title: string }>;
    }
  | { kind: "patchField"; fieldId: string; title?: string; required?: boolean; min?: number | null; max?: number | null; valueType?: string }
  | { kind: "createFieldOption"; fieldId: string; title: string; beforeId?: string | null }
  | { kind: "patchFieldOption"; fieldId: string; optionId: string; title?: string; archived?: boolean }
  | {
      kind: "addDocument";
      id?: string;
      itemId: string;
      documentKind: "cv" | "cover_letter" | "note" | "attachment";
      title: string;
      format: "markdown" | "html" | "pdf" | "file" | "path";
      content?: string | null;
      file?: FileReference | null;
      localPath?: string;
    }
  | { kind: "patchDocument"; documentId: string; title?: string; content?: string | null }
  | { kind: "createTemplate"; id?: string; title: string; markdown: string }
  | { kind: "patchTemplate"; templateId: string; title?: string; markdown?: string }
  | {
      kind: "recordArtifact";
      id?: string;
      itemId: string;
      templateId: string;
      title: string;
      artifactKind: "cv" | "cover_letter";
      pdf: FileReference;
      sourceMarkdown?: FileReference | null;
    }
  | { kind: "updateBoardSchema"; boardId: string; schema: BoardSchemaDraft; expectedHeads?: Heads }
  | { kind: "updateWorkspaceSettings"; settings: WorkspaceSettingsDraft; expectedHeads?: Heads }
  | { kind: "setMemberAvatar"; avatarData: string | null; changedAt?: string }
  | { kind: "createAutomation"; definition: AutomationDefinition; approval: string; executor: { origin: string; personId: string } }
  | { kind: "configureAutomation"; definition: AutomationDefinition; approval: string }
  | { kind: "setAutomationState"; automationId: string; state: AutomationDesiredState };

export type ExecuteResult = CommandResult<{
  newDoc: Automerge.Doc<WorkspaceDocumentV2>;
  receipt: TransactionReceipt;
  proof: ChangeProof;
}>;

export function err<T>(
  code: CommandErrorCode,
  message: string,
  field?: string,
): CommandResult<T> {
  return { ok: false, error: { code, message, field } };
}
