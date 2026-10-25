import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson } from "../domain/identityCrypto"
import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceRole } from "../domain/permissions"
import type { LocalProfile } from "../domain/identity"
import { defaultStorage } from "../storage"
import { workspaceRole } from "../sync/changeAuthorization"
import { readPendingLocalWorkspaceOwnershipIntent } from "../sync/localWorkspaceOwnership"

export type LocalIdentityBoardCandidate = {
  doc: Automerge.Doc<WorkspaceDocumentV2>
  role: WorkspaceRole
}

export type IdentityLocalBoardChoicePlan = {
  previousPersonId: string
  discardUntouchedDefaultIds: string[]
  ownedBoards: Array<{ workspaceId: string; title: string }>
}

export type IdentityLocalBoardChoice =
  | { kind: "stay" }
  | { kind: "add"; workspaceIds: string[] }

/** Classify durable owned content before changing the active Identity. */
export async function readIdentityLocalBoardPlan(profile: LocalProfile, targetPersonId?: string): Promise<IdentityLocalBoardChoicePlan> {
  const candidates: LocalIdentityBoardCandidate[] = []
  const pending = new Set(targetPersonId ? await readPendingLocalWorkspaceOwnershipIntent(profile, targetPersonId) : [])
  try {
    const workspaces = [...await defaultStorage.listWorkspaces(), ...await defaultStorage.listArchivedWorkspaces()]
    for (const workspace of workspaces) {
      const loaded = await defaultStorage.loadWorkspaceDoc(workspace.id)
      if (!loaded) throw new Error("A local board is unavailable; sign-in has not changed its ownership")
      const candidate: LocalIdentityBoardCandidate = { doc: loaded.doc, role: "visitor" }
      candidates.push(candidate)
      if (!pending.has(workspace.id)) candidate.role = await workspaceRole(loaded.doc, profile)
    }
    return planIdentityLocalBoards(profile.identity.personId, candidates)
  } finally {
    for (const candidate of candidates) Automerge.free(candidate.doc)
  }
}

export function planIdentityLocalBoards(
  previousPersonId: string,
  candidates: LocalIdentityBoardCandidate[],
): IdentityLocalBoardChoicePlan {
  // `role` comes from signed current workspace authority. `doc.ownerPersonId`
  // is immutable genesis ownership and can belong to a former owner.
  const owned = candidates.filter(({ doc, role }) => role === "owner" && doc.id.length > 0)
  const untouchedDefaults = owned.filter(({ doc }) => isUntouchedDefaultBoard(doc))
  const defaultIds = new Set(untouchedDefaults.map(({ doc }) => doc.id))
  return {
    previousPersonId,
    discardUntouchedDefaultIds: [...defaultIds],
    ownedBoards: owned.filter(({ doc }) => !defaultIds.has(doc.id))
      .map(({ doc }) => ({ workspaceId: doc.id, title: doc.title })),
  }
}

/** Resolve explicit UI choice to the selected local-owner set; transfer logic stays with mesh authority. */
export function selectedIdentityLocalBoardIds(
  plan: IdentityLocalBoardChoicePlan,
  choice: IdentityLocalBoardChoice,
): string[] {
  if (choice.kind === "stay") return []
  const allowed = new Set(plan.ownedBoards.map(board => board.workspaceId))
  const selected = new Set(choice.workspaceIds)
  if (selected.size !== choice.workspaceIds.length || [...selected].some(id => !allowed.has(id))) {
    throw new Error("Selected board is not in the local ownership choice")
  }
  return plan.ownedBoards.filter(board => selected.has(board.workspaceId)).map(board => board.workspaceId)
}

function isUntouchedDefaultBoard(doc: Automerge.Doc<WorkspaceDocumentV2>): boolean {
  if (doc.title !== "Untitled" || Automerge.getAllChanges(doc).length !== 1) return false
  const boards = Object.values(doc.entities).filter(entity => hasEntityKind(entity, "board"))
  if (boards.length !== 1 || boards[0]?.title !== "Untitled" || boards[0].preset?.key !== "blank") return false
  try {
    const expected = createWorkspaceDoc("identity-local-board-baseline", "Untitled", "baseline-owner", "blank",
      "2000-01-01T00:00:00.000Z")
    return canonicalizeJson(normalizeSeed(doc)) === canonicalizeJson(normalizeSeed(expected))
  } catch {
    return false
  }
}

function normalizeSeed(value: WorkspaceDocumentV2): unknown {
  const idAliases = new Map<string, string>([[value.id, "workspace"]])
  for (const entity of Object.values(value.entities)) {
    if (hasEntityKind(entity, "board")) idAliases.set(entity.id, "board")
    else if ("placement" in entity) idAliases.set(entity.id, `${entity.kind}:${entity.placement.rank}`)
    if (hasEntityKind(entity, "field") && entity.valueType === "select") {
      for (const option of Object.values(entity.options)) {
        idAliases.set(option.id, `option:${entity.placement.rank}:${option.rank}`)
      }
    }
  }
  const visit = (current: unknown, key = ""): unknown => {
    if (typeof current === "string") {
      if (key === "createdAt" || key === "updatedAt") return "<seed-time>"
      if (key === "ownerPersonId") return "<seed-owner>"
      return idAliases.get(current) ?? current
    }
    if (Array.isArray(current)) return current.map(item => visit(item))
    if (!current || typeof current !== "object") return current
    const entries = Object.entries(current as Record<string, unknown>).map(([entryKey, entryValue]) => {
      const alias = key === "entities" || key === "options" ? idAliases.get(entryKey) ?? entryKey : entryKey
      return [alias, visit(entryValue, entryKey)] as const
    })
    return Object.fromEntries(entries)
  }
  return visit(value)
}
