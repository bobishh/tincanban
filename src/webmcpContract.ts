import type { Command } from "./domain/commands";
import type { WorkspaceDocumentV2 } from "./domain/model";

export type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: {
        readOnlyHint?: boolean;
        untrustedContentHint?: boolean;
      };
      execute: (input: unknown) => unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

export type ToolStore = {
  getActiveDoc?: () => WorkspaceDocumentV2 | null;
  executeCommandAsync?: (command: Command) => Promise<unknown>;
  createWorkspaceAsync?: (
    title: string,
    presetKey: "job-search" | "blank",
  ) => Promise<WorkspaceDocumentV2>;
  switchWorkspaceAsync?: (workspaceId: string) => Promise<void>;
  availableWorkspaces?: { value: WorkspaceSummary[] } | WorkspaceSummary[];
  activeWorkspace?: WorkspaceSummary;
  placementIssues?: { value: PlacementIssue[] } | PlacementIssue[];
  sendChatMessage?: (body: string) => Promise<void>;
  getSyncTrace?: () => unknown[];
};

type WorkspaceSummary = {
  id: string;
  title: string;
  updatedAt?: string;
};

type PlacementIssue = {
  entity?: { id: string; title: string };
  id?: string;
  title?: string;
  issue?: string;
  entityId?: string;
  parentId?: string | null;
  type?: string;
};

export type RegisterTool = (
  tool: Parameters<ModelContext["registerTool"]>[0],
) => void | Promise<void>;

export const workspaceSettingsSchema = {
  type: "object",
  properties: {
    formatVersion: { type: "number", const: 1 },
    workspace: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    board: {
      type: "object",
      properties: {
        boardId: {
          type: "string",
          description: "Stable board ID returned by get_workspace_settings.",
        },
        boardTitle: { type: "string" },
        entityName: {
          type: "string",
          description: "Singular noun used by Add and Edit actions.",
        },
        columns: {
          type: "array",
          description:
            "Ordered board columns. Omission archives an existing column and hides its children.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Keep returned IDs when editing. Omit only for new columns.",
              },
              title: { type: "string" },
              archive: {
                type: "boolean",
                enum: [true],
                description:
                  "Optional. Assigns this as the board's sole Archive column. Independent from the collapsible setting.",
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        cardStageButtons: {
          type: "array",
          description: "Ordered card detail buttons. Empty array hides them. Each button moves a card to its target column; label defaults to column title.",
          items: {
            type: "object",
            properties: { columnId: { type: "string" }, label: { type: "string" } },
            required: ["columnId"],
            additionalProperties: false,
          },
        },
        fields: {
          type: "array",
          description:
            "Ordered typed item fields. Omission archives a field while retaining stored values.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Keep returned IDs when editing. Omit only for new fields.",
              },
              title: { type: "string" },
              valueType: {
                type: "string",
                enum: [
                  "text",
                  "number",
                  "boolean",
                  "select",
                  "url",
                  "date",
                  "datetime",
                ],
              },
              required: { type: "boolean" },
              min: { type: ["number", "null"] },
              max: { type: ["number", "null"] },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                  },
                  required: ["title"],
                  additionalProperties: false,
                },
              },
            },
            required: ["title", "valueType", "required"],
            additionalProperties: false,
          },
        },
        employee_profile: {
          type: "object",
          description: "Shared employee profile compared with vacancies by approved job intake automation.",
          properties: { stack: { type: "string", maxLength: 4000 }, work_profile: { type: "string", maxLength: 8000 } },
          required: ["stack", "work_profile"],
          additionalProperties: false,
        },
        priorityPolicy: {
          type: ["object", "null"],
          description:
            "Declarative automatic priority policy. job-fit-v1 reads a Clef assessment from assessmentFieldId; weighted-rules-v1 evaluates custom rules.",
          properties: {
            version: { type: "number", const: 1 },
            evaluator: { type: "string", enum: ["weighted-rules-v1", "job-fit-v1"] },
            assessmentFieldId: { type: "string" },
            sort: {
              type: "string",
              enum: ["fit_desc", "fit_asc", "manual"],
            },
            priorityFieldId: { type: "string" },
            fitFieldId: { type: ["string", "null"] },
            rules: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  fieldId: { type: "string" },
                  operator: {
                    type: "string",
                    enum: [
                      "equals",
                      "contains",
                      "at_least",
                      "at_most",
                      "is_set",
                    ],
                  },
                  value: {
                    type: ["string", "number", "boolean", "null"],
                  },
                  weight: { type: "number", minimum: -10, maximum: 10 },
                },
                required: ["id", "fieldId", "operator", "value", "weight"],
                additionalProperties: false,
              },
            },
            bands: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  optionId: { type: "string" },
                  minScore: { type: "number", minimum: 0, maximum: 10 },
                },
                required: ["optionId", "minScore"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "version",
            "evaluator",
            "priorityFieldId",
            "fitFieldId",
            "rules",
            "bands",
          ],
          additionalProperties: false,
        },
      },
      required: ["boardId", "boardTitle", "entityName", "columns", "fields"],
      additionalProperties: false,
    },
    documentTemplates: {
      type: "array",
      description:
        "Ordered entity document templates. Keep IDs when editing; omit ID for new templates.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          markdown: { type: "string" },
        },
        required: ["title", "markdown"],
        additionalProperties: false,
      },
    },
  },
  required: ["formatVersion", "workspace", "board", "documentTemplates"],
  additionalProperties: false,
} as const;

export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

export function requiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} is required`);
  return value.trim();
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

export function noUnknown(
  input: Record<string, unknown>,
  allowed: string[],
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown fields: ${unknown.join(", ")}`);
}

export function workspaceRecords(store: ToolStore) {
  const source = store.availableWorkspaces
    ? Array.isArray(store.availableWorkspaces)
      ? store.availableWorkspaces
      : store.availableWorkspaces.value
    : [];
  const activeId = store.activeWorkspace?.id;
  return source.map((workspace) => ({
    id: String(workspace.id),
    title: String(workspace.title),
    updatedAt:
      typeof workspace.updatedAt === "string" ? workspace.updatedAt : undefined,
    active: workspace.id === activeId,
  }));
}
