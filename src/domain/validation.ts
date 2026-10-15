import type { z } from "zod"
import { entitySchema, workspaceSchema } from "./entitySchemas"
import type { CommandResult, EntityKind } from "./model"
import type { Item, WorkspaceDocumentV2, WorkspaceEntity } from "./model"
import { memberProfileEntityId } from "./avatarData"
import { automationEntityId, automationLifecycle } from "./automationLifecycle"
import { parseAutomationDefinition } from "./automationContract"
import { parseAutomationApproval } from "./automationApproval"
import { canonicalizeJson } from "./identity"
import { assertApplicationSourceRecord } from "./applicationSourceData"

function validate<T>(schema: z.ZodType<T>, input: unknown): CommandResult<T> {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]!
  return { ok: false, error: {
    code: issue.path[0] === "formatVersion" ? "unsupported_format" : "invalid_input",
    message: `${issue.path.join(".") || "Object"}: ${issue.message}`,
    field: issue.path.join(".") || undefined,
  } }
}
export const validateEntity = (input: unknown) => validate(entitySchema, input)
export function validateWorkspaceDoc(input: unknown): CommandResult<WorkspaceDocumentV2> {
  const parsed = validate(workspaceSchema, input)
  if (!parsed.ok) return parsed
  const doc = parsed.value as WorkspaceDocumentV2
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (entity.kind !== "application_source" && !id.startsWith("application-source:")) continue
    try {
      if (id !== entity.id) throw new Error("Source entity ID mismatch")
      assertApplicationSourceRecord(entity, doc.entities, doc.id)
    } catch { return invalid(`entities.${id}`, "Application source scope, record or original reference is invalid") }
  }
  const profileError = validateMemberProfiles(doc)
  if (profileError) return profileError
  const automationError = validateAutomations(doc)
  if (automationError) return automationError
  const archiveError = validateArchiveReferences(doc)
  if (archiveError) return archiveError
  const transitionError = validateItemTransitions(doc)
  if (transitionError) return transitionError
  return parsed as CommandResult<WorkspaceDocumentV2>
}

function validateAutomations(doc: WorkspaceDocumentV2): CommandResult<never> | undefined {
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (entity.kind !== "automation") continue
    try {
      if (!validAutomationRecord(doc, id, entity)) {
        return invalid(`entities.${id}`, "Automation scope, identity or placement is invalid")
      }
      automationLifecycle(entity)
    } catch { return invalid(`entities.${id}`, "Automation control history is invalid") }
  }
}

function validAutomationRecord(doc: WorkspaceDocumentV2, id: string,
  entity: Extract<WorkspaceEntity, { kind: "automation" }>): boolean {
  const definition = parseAutomationDefinition(JSON.parse(entity.definition))
  const approval = parseAutomationApproval(entity.approval)
  const board = doc.entities[definition.scope.boardId]
  return id === entity.id && id === automationEntityId(definition.id) && definition.scope.workspaceId === doc.id &&
    board?.kind === "board" && entity.placement.parentId === board.id && entity.placement.rank === "0/1" &&
    entity.archivedAt === null && entity.title === definition.name && isIso(entity.createdAt) && isIso(entity.updatedAt) &&
    canonicalizeJson(approval.definition.payload) === canonicalizeJson(definition) && approval.grant.payload.personId === entity.executor.personId
}

function validateMemberProfiles(doc: WorkspaceDocumentV2): CommandResult<never> | undefined {
  for (const entity of Object.values(doc.entities)) {
    if (!("kind" in entity) || entity.kind !== "member_profile") continue
    if (entity.id !== memberProfileEntityId(entity.personId) || entity.title !== "Member profile" ||
      entity.placement.parentId !== null || entity.placement.rank !== "0/1" || entity.archivedAt !== null ||
      !isIso(entity.createdAt) || !isIso(entity.updatedAt)) {
      return invalid(`entities.${entity.id}`, "Member profile identity or placement is invalid")
    }
  }
}

function isIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function validateArchiveReferences(doc: WorkspaceDocumentV2): CommandResult<never> | undefined {
  for (const board of Object.values(doc.entities).filter(entity => "kind" in entity && entity.kind === "board")) {
    const archive = board.archiveColumnId ? doc.entities[board.archiveColumnId] : undefined
    if (board.archiveColumnId && (!archive || !("kind" in archive) || archive.kind !== "column" || archive.archivedAt || archive.placement.parentId !== board.id))
      return invalid(`entities.${board.id}.archiveColumnId`, "Archive column must identify an active column on this board")
    const legacy = Object.values(doc.entities).filter(entity => "kind" in entity && entity.kind === "column" && entity.archive === true && entity.placement.parentId === board.id && !entity.archivedAt)
    if (legacy.length > 1) return invalid(`entities.${board.id}.archiveColumnId`, "Board has multiple archive columns")
    if (board.archiveColumnId !== undefined && legacy.some(column => column.id !== board.archiveColumnId))
      return invalid(`entities.${board.id}.archiveColumnId`, "Archive marker conflicts with board archive reference")
  }
}

function validateItemTransitions(doc: WorkspaceDocumentV2): CommandResult<never> | undefined {
  for (const item of Object.values(doc.entities).filter(isItemRecord)) {
    const lifecycleError = validateLifecycle(item)
    if (lifecycleError) return lifecycleError
    const workflowError = validateWorkflow(doc, item)
    if (workflowError) return workflowError
  }
}

function validateLifecycle(item: Item): CommandResult<never> | undefined {
  if (!item.lifecycle) return
  const lifecycle = parseTransition(item.lifecycle) as { state?: string; changedAt?: string } | undefined
  if (lifecycle && (lifecycle.state === "active" || lifecycle.state === "archived") && typeof lifecycle.changedAt === "string" && Number.isFinite(Date.parse(lifecycle.changedAt))) return
  return invalid(`entities.${item.id}.lifecycle`, "Lifecycle transition is invalid")
}

function validateWorkflow(doc: WorkspaceDocumentV2, item: Item): CommandResult<never> | undefined {
  if (!item.workflow) return
  const workflow = parseTransition(item.workflow) as { columnId?: string; changedAt?: string } | undefined
  if (workflow && typeof workflow.columnId === "string" && typeof workflow.changedAt === "string" && Number.isFinite(Date.parse(workflow.changedAt)) && workflowColumnId(doc, item.id) === workflow.columnId) return
  return invalid(`entities.${item.id}.workflow`, "Workflow transition must be valid and match item placement")
}

function invalid(field: string, message: string): CommandResult<never> {
  return { ok: false, error: { code: "invalid_input", field, message } }
}

function isItemRecord(entity: WorkspaceEntity): entity is Item {
  return !("kind" in entity) && "body" in entity && typeof entity.body === "string" && "values" in entity && Boolean(entity.values) && typeof entity.values === "object"
}

function workflowColumnId(doc: WorkspaceDocumentV2, itemId: string): string | undefined {
  const seen = new Set<string>()
  let currentId: string | null = itemId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const current: WorkspaceEntity | undefined = doc.entities[currentId]
    if (!current) return undefined
    if ("kind" in current && current.kind === "column") return current.id
    currentId = current.placement.parentId
  }
  return undefined
}

function parseTransition(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch { return undefined }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const allowedParents: Record<EntityKind, readonly (string | null)[]> = {
  board: [null], column: ["board"], field: ["board"], item: ["column", "item"],
  document: ["item"], artifact: ["item"], document_template: [null], template: [null], member_profile: [null], automation: ["board"], application_source: ["item"],
}
export function validatePlacementParent(childKind: string, parentKind: string | null): CommandResult<void> {
  if (!Object.hasOwn(allowedParents, childKind)) return { ok: false, error: { code: "invalid_input", message: `Unknown entity kind: ${childKind}` } }
  const parents = allowedParents[childKind as EntityKind]
  return parents.includes(parentKind) ? { ok: true, value: undefined }
    : { ok: false, error: { code: "invalid_parent", message: `${childKind} parent must be ${parents.map(value => value ?? "null").join(" or ")}` } }
}
