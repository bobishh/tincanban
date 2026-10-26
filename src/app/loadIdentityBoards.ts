import { isUntouchedDefaultBoard } from "./identityLocalBoards"
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

/** One sign-in completes only after its catalog and existing workspace contents are available. */
export async function loadIdentityBoards(app: App, returnPath = "/"): Promise<void> {
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
        throw new Error("Your board catalog is still loading. Select Sign in to retry.")
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
        throw new Error("Your boards are still loading. Select Sign in to retry.")
      }
    }
    guard()
    await refreshAvailableWorkspaces()
    const available = app.availableWorkspaces.value
    const route = parseBoardRouteUrl(returnPath)
    const loaded = await readLoadedWorkspaceRoutes(app, available, guard)
    const saved = loaded.filter(workspace => !workspace.untouchedDefault)
    const eligible = saved.length ? saved : loaded
    const activeAvailable = eligible.some(workspace => workspace.workspaceId === app.activeWorkspace.id)
    const requested = route ? resolveEligibleBoardRoute(route, eligible)?.workspaceId : undefined
    if (requested && requested !== app.activeWorkspace.id) await app.switchWorkspace(requested)
    else if (requested || activeAvailable) return
    else if (eligible[0]) await app.switchWorkspace(eligible[0].workspaceId)
    else if (!ids.size) await app.createWorkspaceAsync("Untitled", "blank")
    else throw new Error("Your boards are known, but their contents could not be loaded. Select Sign in to retry.")
    guard()
  })
}

async function readLoadedWorkspaceRoutes(app: App,
  available: readonly { id: string }[], guard: () => void): Promise<Array<EligibleBoardRoute & { untouchedDefault: boolean }>> {
  const eligible: Array<EligibleBoardRoute & { untouchedDefault: boolean }> = []
  for (const workspace of available) {
    guard()
    try {
      const document = await app.readWorkspaceDoc(workspace.id) as WorkspaceDocumentV2
      if (document.id !== workspace.id) continue
      const board = Object.values(document.entities).find(entity => hasEntityKind(entity, "board"))
      if (board) eligible.push({ boardId: board.id, workspaceId: workspace.id, untouchedDefault: isUntouchedDefaultBoard(document) })
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
