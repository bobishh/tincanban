import templateData from "../board-templates.json" with { type: "json" }
import type { Preset } from "../domain/seeds"
import { entityKind, hasEntityKind } from "../domain/model"
import { registerUtilityTools } from "./webmcpUtilityTools"
import * as Automerge from "@automerge/automerge/slim"
import { isItem, type Item, type Board, type FieldValue } from "../domain/model"
import { archivedItemsForBoard } from "../domain/archive"
import { isEntityVisible } from "../domain/ancestry"
import { projectWorkspaceSettings } from "../domain/workspaceSettings"
import type { WorkspaceSettingsDraft } from "../domain/workspaceSettings"
import { projectItemPriority } from "../domain/priority"
import type { Command } from "../domain/commands"
import {
  noUnknown, objectInput, optionalString, requiredString, workspaceRecords, workspaceSettingsSchema,
  type RegisterTool, type ToolStore,
} from "../webmcpContract"

function fieldValues(value: unknown): Record<string, FieldValue> {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("values must be an object")
  const values = Object.entries(value)
  if (values.some(([, fieldValue]) => !["string", "number", "boolean"].includes(typeof fieldValue) && fieldValue !== null)) {
    throw new Error("values must contain string, number, boolean, or null values")
  }
  return Object.fromEntries(values) as Record<string, FieldValue>
}

async function runCommand(store: ToolStore, command: Command): Promise<void> {
  if (!store.executeCommandAsync) throw new Error("Command execution not supported by store")
  await store.executeCommandAsync(command)
}

type RelocationCommand = Extract<Command, { kind: "moveEntity" | "restoreAndMove" }>

async function registerRelocationTool(
  store: ToolStore,
  register: RegisterTool,
  details: {
    name: string
    title: string
    description: string
    kind: RelocationCommand["kind"]
    resultKey: "moved" | "restored"
  },
): Promise<void> {
  await register({
    name: details.name,
    title: details.title,
    description: details.description,
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        parentId: { type: "string" },
        beforeId: { type: ["string", "null"] },
      },
      required: ["entityId", "parentId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "parentId", "beforeId"])
      const entityId = requiredString(value, "entityId")
      const parentId = requiredString(value, "parentId")
      const beforeId = optionalString(value, "beforeId") ?? null
      await runCommand(store, { kind: details.kind, entityId, parentId, beforeId })
      return { [details.resultKey]: true, entityId, parentId }
    },
  })
}

export async function registerWebMcpTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await registerWorkspaceTools(store, register)
  await registerReadTools(store, register)
  await registerItemTools(store, register)
  await registerMoveTools(store, register)
  await registerEntityTools(store, register)
  await registerRecoveryTools(store, register)
  await registerUtilityTools(store, register)
}

async function registerWorkspaceTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await register({
    name: "list_workspaces",
    title: "List workspaces",
    description: "List available workspaces in the local repository.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      if (store.availableWorkspaces) return workspaceRecords(store)
      const doc = store.getActiveDoc?.()
      return doc ? [{ id: doc.id, title: doc.title, active: true }] : []
    },
  })

  await register({
    name: "switch_workspace",
    title: "Switch workspace",
    description: "Open an available workspace by stable workspace ID so later commands target it.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["workspaceId"])
      const workspaceId = requiredString(value, "workspaceId")
      const target = workspaceRecords(store).find((workspace) => workspace.id === workspaceId)
      if (!target) throw new Error("Workspace not found")
      if (!store.switchWorkspaceAsync) throw new Error("Workspace switching not supported by store")
      await store.switchWorkspaceAsync(workspaceId)
      return { switched: true, id: target.id, title: target.title }
    },
  })

  await register({
    name: "create_workspace",
    title: "Create workspace",
    description: "Create a workspace from a configured board template.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        preset: { type: "string", enum: Object.keys(templateData) },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["title", "preset"])
      const title = requiredString(value, "title")
      const preset = (value.preset as Preset) ?? "blank"
      if (store.createWorkspaceAsync) {
        const ws = await store.createWorkspaceAsync(title, preset)
        return { created: true, id: ws.id, title: ws.title }
      }
      throw new Error("Workspace creation not supported by store")
    },
  })

  await register({
    name: "rename_workspace",
    title: "Rename workspace",
    description: "Update the title of the active workspace.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["title"])
      const title = requiredString(value, "title")
      if (store.executeCommandAsync) {
        await store.executeCommandAsync({ kind: "renameWorkspace", title })
        return { renamed: true, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

}

async function registerReadTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await register({
    name: "get_workspace",
    title: "Get active workspace",
    description: "Read the active workspace details, entities summary, and active board.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("No active workspace document")
      const board = Object.values(doc.entities).find((e): e is Board => hasEntityKind(e, "board"))
      return {
        id: doc.id,
        title: doc.title,
        boardId: board?.id,
        entityCount: Object.keys(doc.entities).length,
        entities: Object.values(doc.entities).map(entity => ({ id: entity.id, kind: entityKind(entity), title: entity.title })),
      }
    },
  })

  await register({
    name: "get_workspace_settings",
    title: "Get workspace settings",
    description: "Read the complete editable workspace configuration: title, board, columns, fields, and document templates. Returns CRDT heads for conflict-safe apply.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute(input) {
      const value = input ? objectInput(input) : {}
      noUnknown(value, [])
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("No active workspace document")
      return { settings: projectWorkspaceSettings(doc), heads: Automerge.getHeads(doc) }
    },
  })

  await register({
    name: "apply_workspace_settings",
    title: "Apply workspace settings",
    description: "Validate and apply the complete workspace configuration in one conflict-safe CRDT transaction. Omitted columns, fields, and document templates are soft-archived.",
    inputSchema: {
      type: "object",
      properties: {
        settings: workspaceSettingsSchema,
        expectedHeads: { type: "array", items: { type: "string" } },
      },
      required: ["settings"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["settings", "expectedHeads"])
      if (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) throw new Error("settings must be an object")
      if (value.expectedHeads !== undefined && (!Array.isArray(value.expectedHeads) || value.expectedHeads.some((head) => typeof head !== "string"))) {
        throw new Error("expectedHeads must be an array of strings")
      }
      if (!store.executeCommandAsync) throw new Error("Command execution not supported by store")
      await store.executeCommandAsync({
        kind: "updateWorkspaceSettings",
        settings: value.settings as WorkspaceSettingsDraft,
        expectedHeads: value.expectedHeads as string[] | undefined,
      })
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("Workspace unavailable after apply")
      return { applied: true, settings: projectWorkspaceSettings(doc), heads: Automerge.getHeads(doc) }
    },
  })

  await register({
    name: "list_items",
    title: "List items",
    description: "List visible non-archived items in the active workspace. Supports filtering by parent column or search text.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string" },
        search: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      const value = input ? objectInput(input) : {}
      noUnknown(value, ["parentId", "search"])
      const parentId = optionalString(value, "parentId")
      const search = optionalString(value, "search")?.toLowerCase()

      const doc = store.getActiveDoc?.()
      if (!doc) return []
      const board = Object.values(doc.entities).find((entity): entity is Board => hasEntityKind(entity, "board") && !entity.archivedAt)

      return Object.values(doc.entities)
        .filter((e): e is Item => isItem(e) && isEntityVisible(doc.entities, e.id))
        .map(item => {
          const notesId = board?.cardPresentation?.narrativeFieldId
          const textNotesId = notesId && doc.entities[notesId]?.kind === "field" && doc.entities[notesId].valueType === "text" ? notesId : undefined
          return projectItemPriority(board, item, textNotesId)
        })
        .filter((t) => (!parentId || t.placement.parentId === parentId))
        .filter((t) => (!search || `${t.title} ${t.body}`.toLowerCase().includes(search)))
        .map((t) => ({
          id: t.id,
          title: t.title,
          body: t.body,
          parentId: t.placement.parentId,
          rank: t.placement.rank,
          values: t.values,
        }))
    },
  })

}

async function registerItemTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await register({
    name: "get_entity",
    title: "Get entity by ID",
    description: "Read a raw typed entity by its unique ID from the workspace.",
    inputSchema: {
      type: "object",
      properties: { entityId: { type: "string" } },
      required: ["entityId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId"])
      const entityId = requiredString(value, "entityId")
      const doc = store.getActiveDoc?.()
      if (!doc) throw new Error("No active workspace document")
      const entity = doc.entities[entityId]
      if (!entity) throw new Error(`Entity ${entityId} not found`)
      return entity
    },
  })

  await register({
    name: "create_item",
    title: "Create item",
    description: "Create a new item under a parent column or parent item.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        values: { type: "object" },
      },
      required: ["parentId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["parentId", "title", "body", "values"])
      const parentId = requiredString(value, "parentId")
      const title = requiredString(value, "title")
      const body = optionalString(value, "body") ?? ""
      const values = fieldValues(value.values)

      if (store.executeCommandAsync) {
        const id = crypto.randomUUID()
        await store.executeCommandAsync({
          kind: "createItem",
          id,
          parentId,
          title,
          body,
          values,
        })
        return { created: true, id, parentId, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

}

async function registerMoveTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await register({
    name: "patch_item",
    title: "Patch item",
    description: "Update title, body, or custom field values of an existing item.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        values: { type: "object" },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "title", "body", "values"])
      const entityId = requiredString(value, "entityId")
      const title = optionalString(value, "title")
      const body = optionalString(value, "body")
      const values = value.values === undefined ? undefined : fieldValues(value.values)

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "patchItem",
          entityId,
          title,
          body,
          values,
        })
        return { patched: true, entityId }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await registerRelocationTool(store, register, {
    name: "move_entity",
    title: "Move entity",
    description: "Reorder or move an entity to a new parent column or item.",
    kind: "moveEntity",
    resultKey: "moved",
  })

}

async function registerEntityTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await register({
    name: "rename_entity",
    title: "Rename entity",
    description: "Rename an existing entity without modifying its placement or kind.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        title: { type: "string" },
      },
      required: ["entityId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["entityId", "title"])
      const entityId = requiredString(value, "entityId")
      const title = requiredString(value, "title")

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "renameEntity",
          entityId,
          title,
        })
        return { renamed: true, entityId, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "set_item_archived",
    title: "Archive or restore item",
    description: "Set archived state of an item in the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        archived: { type: "boolean" },
      },
      required: ["itemId", "archived"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["itemId", "archived"])
      const itemId = requiredString(value, "itemId")
      if (typeof value.archived !== "boolean") throw new Error("archived must be a boolean")
      if (!isItem(store.getActiveDoc?.()?.entities[itemId])) throw new Error("Item not found")

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({
          kind: "setEntityArchived",
          entityId: itemId,
          archived: value.archived,
        })
        return { updated: true, itemId, archived: value.archived }
      }
      throw new Error("Command execution not supported by store")
    },
  })

}

async function registerRecoveryTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await registerRelocationTool(store, register, {
    name: "restore_and_move",
    title: "Restore and move entity",
    description: "Restore a archived entity and reassign it to a valid live parent in one transaction.",
    kind: "restoreAndMove",
    resultKey: "restored",
  })

  await register({
    name: "list_archived_items",
    title: "List archived items",
    description: "List archived items on the active board, including when its Archive column is hidden.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      const doc = store.getActiveDoc?.()
      if (!doc) return []
      const board = Object.values(doc.entities).find((entity): entity is Board => hasEntityKind(entity, "board") && !entity.archivedAt)
      return board ? archivedItemsForBoard(doc, board.id).map(item => ({ id: item.id, title: item.title })) : []
    },
  })

}
