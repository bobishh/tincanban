import { entityKind, hasEntityKind, isItem, type WorkspaceDocumentV2 } from "./model"
import { canonicalizeJson } from "./identity"
import { isMemberProfileData, memberProfileEntityId } from "./avatarData"
import type { Command } from "./commandTypes"
import { automationEntityId, automationLifecycle, isAutomationOrigin } from "./automationLifecycle"
import { parseAutomationDefinition } from "./automationContract"
import { parseAutomationApproval } from "./automationApproval"

export type WorkspaceRole = "owner" | "editor" | "visitor" | "automation"

export type WorkspaceCapability =
  | "workspace.rename"
  | "content.write"
  | "chat.write"
  | "chat.profile"
  | "board.configure"
  | "workspace.import"
  | "access.manage"

const roleCapabilities: Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>> = {
  owner: new Set<WorkspaceCapability>([
    "workspace.rename",
    "content.write",
    "chat.write",
    "chat.profile",
    "board.configure",
    "workspace.import",
    "access.manage",
  ]),
  editor: new Set<WorkspaceCapability>(["workspace.rename", "content.write", "chat.write", "chat.profile"]),
  visitor: new Set<WorkspaceCapability>(["chat.profile"]),
  automation: new Set<WorkspaceCapability>(),
}

const capabilityErrors: Record<WorkspaceCapability, string> = {
  "workspace.rename": "Only owners and editors can rename this workspace",
  "content.write": "Visitors can only view this workspace",
  "chat.write": "Visitors can only view this workspace",
  "chat.profile": "Workspace profile updates are not allowed",
  "board.configure": "Only the owner can edit board structure",
  "workspace.import": "Only the owner can import into this workspace",
  "access.manage": "Only the owner can manage workspace access",
}

export function canWorkspace(role: WorkspaceRole, capability: WorkspaceCapability) {
  return roleCapabilities[role]?.has(capability) ?? false
}

export function assertWorkspaceCapability(role: WorkspaceRole, capability: WorkspaceCapability) {
  if (!canWorkspace(role, capability)) {
    throw new Error(role === "automation" ? "Automation grants cannot perform manual workspace actions" : capabilityErrors[capability])
  }
}

export function assertWorkspaceCommand(role: WorkspaceRole, doc: WorkspaceDocumentV2, command: Command): void {
  const capability = commandCapabilities[command.kind]
  if (capability === null) return // createWorkspace handler rejects commands on existing documents.
  const entityId = "entityId" in command ? command.entityId : ""
  assertWorkspaceCapability(role, capability === "entity" ? entityCapability(doc.entities[entityId]) : capability)
}

const commandCapabilities: Record<Command["kind"], WorkspaceCapability | "entity" | null> = {
  createWorkspace: null,
  migrateWorkspaceFormat: "board.configure",
  renameWorkspace: "workspace.rename",
  setWorkspaceArchived: "board.configure",
  createBoard: "board.configure",
  createColumn: "board.configure",
  createItem: "content.write",
  patchItem: "content.write",
  restoreItemVersion: "content.write",
  moveEntity: "entity",
  renameEntity: "entity",
  setEntityArchived: "entity",
  restoreAndMove: "entity",
  createField: "board.configure",
  patchField: "board.configure",
  createFieldOption: "board.configure",
  patchFieldOption: "board.configure",
  addDocument: "content.write",
  patchDocument: "content.write",
  createTemplate: "board.configure",
  patchTemplate: "board.configure",
  recordArtifact: "content.write",
  updateBoardSchema: "board.configure",
  updateWorkspaceSettings: "board.configure",
  setMemberAvatar: "chat.profile",
  createAutomation: "board.configure",
  configureAutomation: "board.configure",
  setAutomationState: "board.configure",
}

function entityCapability(entity: WorkspaceDocumentV2["entities"][string] | undefined): WorkspaceCapability {
  return entity && (isItem(entity) || entity.kind === "document" || entity.kind === "artifact")
    ? "content.write"
    : "board.configure"
}

export function assertWorkspaceTransition(role: WorkspaceRole, before: WorkspaceDocumentV2, after: WorkspaceDocumentV2, actorPersonId?: string) {
  const { entities: rawBeforeEntities, title: beforeTitle, ...beforeRoot } = before
  const { entities: rawAfterEntities, title: afterTitle, ...afterRoot } = after
  // The first Automerge change has an empty dependency view. Legacy and
  // partially hydrated documents can also lack the root map until migration.
  const beforeEntities = rawBeforeEntities ?? {}
  const afterEntities = rawAfterEntities ?? {}
  assertRootChanges(role, beforeTitle, afterTitle, beforeRoot, afterRoot)
  assertWorkspaceEntityTransitions(role, beforeEntities, afterEntities, new Set([...Object.keys(beforeEntities), ...Object.keys(afterEntities)]), actorPersonId)
}

export function assertWorkspaceRootTransition(role: WorkspaceRole, changedRootKeys: ReadonlySet<string>): void {
  if (changedRootKeys.has("title")) assertWorkspaceCapability(role, "workspace.rename")
  if ([...changedRootKeys].some(key => key !== "title" && key !== "entities")) assertWorkspaceCapability(role, "board.configure")
}

export function assertWorkspaceEntityTransitions(
  role: WorkspaceRole,
  beforeEntities: WorkspaceDocumentV2["entities"],
  afterEntities: WorkspaceDocumentV2["entities"],
  changedEntityIds: ReadonlySet<string>,
  actorPersonId?: string,
): void {
  for (const id of changedEntityIds) {
    const a = beforeEntities[id], b = afterEntities[id]
    if (canonicalizeJson(a ?? null) === canonicalizeJson(b ?? null)) continue
    if (id.startsWith("automation:") || hasEntityKind(a, "automation") || hasEntityKind(b, "automation")) {
      assertAutomationTransition(role, a, b)
      continue
    }
    if (id.startsWith("member-profile:") || hasEntityKind(a, "member_profile") || hasEntityKind(b, "member_profile")) {
      assertMemberProfileTransition(role, a, b, actorPersonId)
      continue
    }
    assertEntityTransition(role, a, b, afterEntities)
  }
}

function assertAutomationTransition(role: WorkspaceRole, before: WorkspaceDocumentV2["entities"][string] | undefined,
  after: WorkspaceDocumentV2["entities"][string] | undefined): void {
  assertWorkspaceCapability(role, "board.configure")
  if (!hasEntityKind(after, "automation")) throw new Error("Automation deletion must retain a tombstone")
  assertAutomationRecord(after)
  if (!before) return
  if (!hasEntityKind(before, "automation")) throw new Error("Automation record cannot replace another entity")
  const stable = (value: typeof after) => Object.fromEntries(Object.entries(value).filter(([key]) => !["controls", "updatedAt", "definition", "approval", "title"].includes(key)))
  if (canonicalizeJson(stable(before)) !== canonicalizeJson(stable(after))) throw new Error("Automation executor and placement are immutable")
  if (Object.entries(before.controls).some(([id, data]) => after.controls[id] !== data)) throw new Error("Automation control history and tombstones cannot be removed")
  if (automationLifecycle(before).state === "deleted") throw new Error("Deleted automation is immutable")
}

function assertAutomationRecord(after: Extract<WorkspaceDocumentV2["entities"][string], { kind: "automation" }>): void {
  const definition = parseAutomationDefinition(JSON.parse(after.definition))
  const approval = parseAutomationApproval(after.approval)
  if (!isAutomationOrigin(after.executor?.origin) || after.executor.personId !== approval.grant.payload.personId ||
    canonicalizeJson(approval.definition.payload) !== canonicalizeJson(definition)) throw new Error("Automation approval or executor is invalid")
  if (after.id !== automationEntityId(definition.id) || after.title !== definition.name || after.archivedAt !== null ||
    after.placement.parentId !== definition.scope.boardId || after.placement.rank !== "0/1") throw new Error("Automation record identity or placement is invalid")
  automationLifecycle(after)
}

function assertMemberProfileTransition(role: WorkspaceRole, before: WorkspaceDocumentV2["entities"][string] | undefined,
  after: WorkspaceDocumentV2["entities"][string] | undefined, actorPersonId?: string): void {
  const beforeProfile = hasEntityKind(before, "member_profile") ? before : undefined
  const afterProfile = hasEntityKind(after, "member_profile") ? after : undefined
  const profile = afterProfile ?? beforeProfile
  if (!profile) throw new Error("A participant may change only their own profile")
  assertProfileActor(profile, actorPersonId)
  if (before && !beforeProfile) throw new Error("Profile record cannot replace another entity")
  if (after && !afterProfile) throw new Error("Profile record cannot be replaced by another entity")
  if (beforeProfile && afterProfile) assertMemberProfileUpdate(beforeProfile, afterProfile)
  if (afterProfile && !isMemberProfileData(afterProfile.data)) throw new Error("Profile avatar data is invalid")
  assertWorkspaceCapability(role, "chat.profile")
}

function assertProfileActor(profile: Extract<WorkspaceDocumentV2["entities"][string], { kind: "member_profile" }>, actorPersonId?: string): void {
  if (!actorPersonId || profile.personId !== actorPersonId || profile.id !== memberProfileEntityId(actorPersonId)) {
    throw new Error("A participant may change only their own profile")
  }
}

function assertMemberProfileUpdate(before: Extract<WorkspaceDocumentV2["entities"][string], { kind: "member_profile" }>,
  after: Extract<WorkspaceDocumentV2["entities"][string], { kind: "member_profile" }>): void {
  const stable = (value: typeof before) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "data" && key !== "updatedAt"))
  if (canonicalizeJson(stable(before)) !== canonicalizeJson(stable(after)) || before.data === after.data || !isMemberProfileData(after.data)) {
    throw new Error("Profile updates may change only valid avatar data")
  }
}

function assertRootChanges(role: WorkspaceRole, beforeTitle: string, afterTitle: string, beforeRoot: object, afterRoot: object): void {
  if (beforeTitle !== afterTitle) assertWorkspaceCapability(role, "workspace.rename")
  if (canonicalizeJson(beforeRoot) !== canonicalizeJson(afterRoot)) assertWorkspaceCapability(role, "board.configure")
}

function assertEntityTransition(role: WorkspaceRole, before: WorkspaceDocumentV2["entities"][string] | undefined, after: WorkspaceDocumentV2["entities"][string] | undefined, entities: WorkspaceDocumentV2["entities"]): void {
  if (!isContentChange(before, after)) return assertWorkspaceCapability(role, "board.configure")
  assertWorkspaceCapability(role, "content.write")
  const parent = entities[after.placement.parentId ?? ""]
  if (isItem(after) && !(parent && (isItem(parent) || parent.kind === "column"))) throw new Error("Invalid item parent")
}

function isContentChange(before: WorkspaceDocumentV2["entities"][string] | undefined, after: WorkspaceDocumentV2["entities"][string] | undefined): after is WorkspaceDocumentV2["entities"][string] {
  return Boolean(after && (isItem(after) || after.kind === "document" || after.kind === "artifact") && (!before || entityKind(before) === entityKind(after)))
}
