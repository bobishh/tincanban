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
export async function loadIdentityBoards(app: App, returnPath = "/", recoverPeers?: (workspaceIds: string[]) => Promise<void>): Promise<void> {
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
    let storageFailure: unknown
    for (const config of await getReplicaConfigurations(profile.identity.personId)) {
      if (!ids.has(config.workspaceId)) continue
      guard()
      try {
        if (!await createBlindReplica(config, app, guard, async () => {}).pull()) {
          throw new Error("Your boards are still loading. Retry loading boards.")
        }
      } catch (cause) {
        guard()
        if (!recoverPeers) throw cause
        storageFailure = cause
      }
    }
    guard()
    let waitingForPeers = false
    if (recoverPeers) {
      const missing = async () => {
        const absent: string[] = []
        for (const id of ids) {
          guard()
          try { await app.readWorkspaceDoc(id) } catch { absent.push(id) }
        }
        return absent
      }
      await recoverPeers(await missing())
      guard()
      waitingForPeers = (await missing()).length > 0
    }
    await refreshAvailableWorkspaces()
    await restoreBoardSelection(app, returnPath, ids.size === 0, initialWorkspaceId, guard)
    if (waitingForPeers) throw storageFailure ?? new Error("Your boards are waiting for an available peer or stored copy. Retry loading boards.")
  })
}

async function restoreBoardSelection(app: App, returnPath: string, emptyCatalog: boolean, initialWorkspaceId: string, guard: () => void): Promise<void> {
  const available = app.availableWorkspaces.value
  const route = parseBoardRouteUrl(returnPath)
  const loaded = await readLoadedWorkspaceRoutes(app, available, guard)
  if (app.activeWorkspace.id !== initialWorkspaceId) {
    // A newly created board may not be in the directory snapshot read above.
    // Its committed active projection takes precedence over this older lookup.
    const current = app.getActiveDoc()
    if (current) recordSelectedBoard(isEmptyDefaultBoard(current))
    return
  }
  const saved = loaded.filter(workspace => !workspace.emptyDefault)
  const eligible = saved.length ? saved : loaded
  const activeAvailable = eligible.some(workspace => workspace.workspaceId === app.activeWorkspace.id)
  const requested = route ? resolveEligibleBoardRoute(route, eligible)?.workspaceId : undefined
  const selected = requested ?? (activeAvailable ? app.activeWorkspace.id : eligible[0]?.workspaceId)
  if (selected) {
    if (selected !== app.activeWorkspace.id) await app.switchWorkspace(selected)
  }
  else if (emptyCatalog) await app.createWorkspaceAsync("Untitled", "blank")
  else throw new Error("Your boards are known, but their contents could not be loaded. Retry loading boards.")
  guard()
  recordSelectedBoard(!selected || eligible.find(workspace => workspace.workspaceId === selected)?.emptyDefault)
}

function recordSelectedBoard(emptyDefault: boolean | undefined): void {
  recordIdentityBrowserSignIn("selection", "completed", { selection: emptyDefault ? "empty_default" : "saved" })
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
