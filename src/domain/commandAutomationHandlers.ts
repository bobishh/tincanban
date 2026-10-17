import type { CommandHandler } from "./commandHandlerTypes"
import { err } from "./commandTypes"
import { parseAutomationDefinition } from "./automationContract"
import { automationEntityId, automationLifecycle, isAutomationOrigin } from "./automationLifecycle"
import { hasEntityKind } from "./model"
import { parseAutomationApproval } from "./automationApproval"
import { canonicalizeJson } from "./identityCrypto"

export const createAutomation: CommandHandler<"createAutomation"> = (doc, command, context) => {
  let definition
  try { definition = parseAutomationDefinition(command.definition) } catch { return err("invalid_input", "Automation definition is invalid") }
  const id = automationEntityId(definition.id)
  if (doc.entities[id]) return err("invalid_input", "Automation instance already exists")
  const board = doc.entities[definition.scope.boardId]
  if (definition.scope.workspaceId !== doc.id || !hasEntityKind(board, "board") || board.archivedAt) {
    return err("invalid_input", "Automation scope must identify an active board in this workspace")
  }
  if (!isAutomationOrigin(command.executor.origin)) return err("invalid_input", "Automation executor origin is invalid")
  if (!command.executor.personId || command.executor.personId === context.actorPersonId) return err("invalid_input", "Automation requires a separate executor identity")
  try {
    const approval = parseAutomationApproval(command.approval)
    if (approval.grant.payload.personId !== command.executor.personId || canonicalizeJson(approval.definition.payload) !== canonicalizeJson(definition)) {
      return err("invalid_input", "Automation approval does not match its executor or definition")
    }
  } catch { return err("invalid_input", "Automation approval metadata is invalid") }
  const controlId = crypto.randomUUID()
  return { ok: true, value: { changedEntityIds: [id], apply: draft => {
    draft.entities[id] = { id, kind: "automation", title: definition.name,
      placement: { parentId: definition.scope.boardId, rank: "0/1" }, archivedAt: null,
      createdAt: context.nowIso, updatedAt: context.nowIso, definition: JSON.stringify(definition),
      approval: command.approval, executor: { ...command.executor }, controls: { [controlId]: JSON.stringify({ state: "active", supersedes: [] }) } }
  } } }
}

export const configureAutomation: CommandHandler<"configureAutomation"> = (doc, command, context) => {
  try {
    const definition = parseAutomationDefinition(command.definition)
    const approval = parseAutomationApproval(command.approval)
    const entity = doc.entities[automationEntityId(definition.id)]
    if (!hasEntityKind(entity, "automation") || automationLifecycle(entity).state === "deleted") return err("invalid_input", "Automation is missing or removed")
    if (definition.scope.workspaceId !== doc.id || definition.scope.boardId !== entity.placement.parentId ||
      approval.grant.payload.personId !== entity.executor.personId || canonicalizeJson(approval.definition.payload) !== canonicalizeJson(definition)) {
      return err("invalid_input", "Automation approval does not match its executor and scope")
    }
    return { ok: true, value: { changedEntityIds: [entity.id], apply: draft => {
      const target = draft.entities[entity.id]
      if (!hasEntityKind(target, "automation")) throw new Error("Automation disappeared")
      target.definition = JSON.stringify(definition)
      target.approval = command.approval
      target.title = definition.name
      target.updatedAt = context.nowIso
    } } }
  } catch { return err("invalid_input", "Automation approval is invalid") }
}

export const setAutomationState: CommandHandler<"setAutomationState"> = (doc, command, context) => {
  const entity = doc.entities[command.automationId]
  if (!hasEntityKind(entity, "automation")) return err("not_found", "Automation instance not found")
  if (!["active", "paused", "deleted"].includes(command.state)) return err("invalid_input", "Automation state is invalid")
  let lifecycle
  try { lifecycle = automationLifecycle(entity) } catch { return err("invalid_input", "Automation control history is invalid") }
  if (lifecycle.state === "deleted") return err("invalid_input", "Deleted automation cannot be resumed; create a new instance")
  if (Object.keys(entity.controls).length >= 4096) return err("invalid_input", "Automation control history limit reached")
  const controlId = crypto.randomUUID()
  return { ok: true, value: { changedEntityIds: [entity.id], apply: draft => {
    const target = draft.entities[entity.id]
    if (!hasEntityKind(target, "automation")) throw new Error("Automation instance disappeared")
    target.controls[controlId] = JSON.stringify({ state: command.state, supersedes: lifecycle.heads })
    target.updatedAt = context.nowIso
  } } }
}
