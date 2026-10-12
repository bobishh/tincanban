import type * as Automerge from "@automerge/automerge/slim"
import type { Heads, WorkspaceDocumentV2 } from "./model"
import type { Command } from "./commandTypes"
import type { CommandContext, CommandHandler, PreparedCommand } from "./commandHandlerTypes"
import * as basic from "./commandBasicHandlers"
import * as content from "./commandContentHandlers"
import * as schema from "./commandSchemaHandlers"
import * as profile from "./commandProfileHandlers"
import * as automation from "./commandAutomationHandlers"
import { planWorkspaceMigration } from "./workspaceMigration"

const handlers = {
  migrateWorkspaceFormat: (doc, _command, context) => planWorkspaceMigration(doc, context.nowIso),
  createWorkspace: basic.createWorkspace,
  setWorkspaceArchived: basic.setWorkspaceArchived,
  renameWorkspace: basic.renameWorkspace,
  createBoard: basic.createBoard,
  createItem: basic.createItem,
  patchItem: basic.patchItem,
  restoreItemVersion: basic.restoreItemVersion,
  moveEntity: basic.moveEntity,
  restoreAndMove: basic.restoreAndMove,
  renameEntity: basic.renameEntity,
  setEntityArchived: basic.setEntityArchived,
  createColumn: content.createColumn,
  createField: content.createField,
  patchField: content.patchField,
  createTemplate: content.createTemplate,
  patchTemplate: content.patchTemplate,
  addDocument: content.addDocument,
  patchDocument: content.patchDocument,
  recordArtifact: content.recordArtifact,
  createFieldOption: content.createFieldOption,
  patchFieldOption: content.patchFieldOption,
  updateBoardSchema: schema.updateBoardSchema,
  updateWorkspaceSettings: schema.updateWorkspaceSettings,
  setMemberAvatar: profile.setMemberAvatar,
  createAutomation: automation.createAutomation,
  configureAutomation: automation.configureAutomation,
  setAutomationState: automation.setAutomationState,
} satisfies { [K in Command["kind"]]: CommandHandler<K> }

export function prepareCommand(doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command, nowIso: string, beforeHeads: Heads, actorPersonId?: string): PreparedCommand {
  const handler = handlers[command.kind] as CommandHandler<Command["kind"]>
  return handler(doc, command, { nowIso, beforeHeads, actorPersonId } as CommandContext)
}
