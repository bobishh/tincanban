import { isEmptyDefaultBoard } from "./identityLocalBoards"
import { connectAdoptedIdentityBoards } from "./connectAdoptedIdentityBoards"
import type { useTincanban } from "../state"
import { isCurrentIdentityProfile } from "../domain/identity"
import { defaultStorage } from "../storage"
import { refreshAvailableWorkspaces } from "../statePersistence"
import { createIdentityReplica } from "../sync/identityReplicaStore"
import { createBlindReplica } from "../sync/blindReplicaStore"
import { getIdentityReplicaConfigurations, getReplicaConfigurations } from "../sync/privateReplicaRepository"
import { recordIdentityBrowserSignIn } from "./identityBrowserSignIn"
import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { parseBoardRouteUrl, resolveEligibleBoardRoute, type EligibleBoardRoute } from "./boardRoute"

type App = ReturnType<typeof useTincanban>

/** Load boards for an already approved Identity; failed delivery remains independently retryable. */
export async function loadIdentityBoards(app: App, returnPath = "/"): Promise<void> {
  const initialWorkspaceId = app.activeWorkspace.id
  const profile = app.getCurrentProfile()
  if (!profile) throw new Error("Signed-in profile is unavailable")
  const guard = () => {
    if (!isCurrentIdentityProfile(profile) || app.getCurrentProfile()?.identity.personId !== profile.identity.personId) {
      throw new Error("Identity changed while loading boards")
    }
  }
  await stage("catalog", async () => {
    for (const config of await getIdentityReplicaConfigurations(profile.identity.personId)) {
      guard()
      if (!await createIdentityReplica(config, profile, guard, { includeRecoveryEvidence: false }).pull()) {
        throw new Error("Your board catalog is still loading. Retry loading boards.")
      }
    }
    await app.refreshIdentity()
    guard()
    await connectAdoptedIdentityBoards(app, guard)
  })
  await stage("boards", async () => {
    const root = await defaultStorage.loadPersonalRoot()
    if (!root || root.identity.personId !== profile.identity.personId) throw new Error("Your board catalog is unavailable")
    const ids = new Set(Object.values(root.workspaces).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
    for (const config of await getReplicaConfigurations(profile.identity.personId)) {
      if (!ids.has(config.workspaceId)) continue
      guard()
      if (!await createBlindReplica(config, app, guard, async () => {}).pull()) {
        throw new Error("Your boards are still loading. Retry loading boards.")
      }
    }
    guard()
    await refreshAvailableWorkspaces()
    await restoreBoardSelection(app, returnPath, ids.size === 0, initialWorkspaceId, guard)
  })
}

async function restoreBoardSelection(app: App, returnPath: string, emptyCatalog: boolean, initialWorkspaceId: string, guard: () => void): Promise<void> {
  const available = app.availableWorkspaces.value
  const route = parseBoardRouteUrl(returnPath)
  const loaded = await readLoadedWorkspaceRoutes(app, available, guard)
  const selectionChanged = app.activeWorkspace.id !== initialWorkspaceId
  const saved = loaded.filter(workspace => !workspace.emptyDefault)
  const eligible = !selectionChanged && saved.length ? saved : loaded
  const activeAvailable = eligible.some(workspace => workspace.workspaceId === app.activeWorkspace.id)
  const requested = !selectionChanged && route ? resolveEligibleBoardRoute(route, eligible)?.workspaceId : undefined
  const selected = requested ?? (activeAvailable ? app.activeWorkspace.id : eligible[0]?.workspaceId)
  if (selected) {
    if (selected !== app.activeWorkspace.id) await app.switchWorkspace(selected)
  }
  else if (emptyCatalog) await app.createWorkspaceAsync("Untitled", "blank")
  else throw new Error("Your boards are known, but their contents could not be loaded. Retry loading boards.")
  guard()
  recordIdentityBrowserSignIn("selection", "completed", {
    selection: !selected || eligible.find(workspace => workspace.workspaceId === selected)?.emptyDefault ? "empty_default" : "saved",
  })
}

async function readLoadedWorkspaceRoutes(app: App,
  available: readonly { id: string }[], guard: () => void): Promise<Array<EligibleBoardRoute & { emptyDefault: boolean }>> {
  const eligible: Array<EligibleBoardRoute & { emptyDefault: boolean }> = []
  for (const workspace of available) {
    guard()
    try {
      const document = await app.readWorkspaceDoc(workspace.id) as WorkspaceDocumentV2
      if (document.id !== workspace.id) continue
      const board = Object.values(document.entities).find(entity => hasEntityKind(entity, "board"))
      if (board) eligible.push({ boardId: board.id, workspaceId: workspace.id, emptyDefault: isEmptyDefaultBoard(document) })
    } catch { /* Unreadable workspaces cannot be route targets. */ }
  }
  guard()
  return eligible
}

async function stage(phase: "catalog" | "boards", operation: () => Promise<void>) {
  const started = performance.now()
  recordIdentityBrowserSignIn(phase, "started")
  try {
    await operation()
    recordIdentityBrowserSignIn(phase, "completed", { elapsedMs: performance.now() - started })
  } catch (cause) {
    recordIdentityBrowserSignIn(phase, "failed", { errorCode: phase === "catalog" ? "catalog_failed" : "boards_failed", elapsedMs: performance.now() - started })
    throw cause
  }
}
