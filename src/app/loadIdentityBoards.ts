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
import { hasEntityKind } from "../domain/model"
import { parseBoardRouteUrl, resolveEligibleBoardRoute, type EligibleBoardRoute } from "./boardRoute"

type App = ReturnType<typeof useTincanban>
export type IdentityWorkspaceRecovery = (workspaceIds: string[], options?: { routesOnly?: boolean }) => Promise<void>

export class IdentityBoardLoadPending extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "IdentityBoardLoadPending"
  }
}

/** Load boards for an already approved Identity; failed delivery remains independently retryable. */
export async function loadIdentityBoards(app: App, returnPath = "/", recoverPeers?: IdentityWorkspaceRecovery): Promise<void> {
  const initialSelection = app.captureWorkspaceSelection()
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
        throw new IdentityBoardLoadPending("Your board catalog is still loading. Retry loading boards.")
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
    await recoverPeers?.([...ids], { routesOnly: true })
    guard()
    let storageFailure: unknown
    for (const config of await getReplicaConfigurations(profile.identity.personId)) {
      if (!ids.has(config.workspaceId)) continue
      guard()
      try {
        if (!await createBlindReplica(config, app, guard, async () => {}).pull()) {
          throw new IdentityBoardLoadPending("Your boards are still loading. Retry loading boards.")
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
          try { await app.withWorkspaceDoc(id, () => undefined) } catch { absent.push(id) }
        }
        return absent
      }
      await recoverPeers([...ids])
      guard()
      waitingForPeers = (await missing()).length > 0
    }
    await refreshAvailableWorkspaces()
    await restoreBoardSelection(app, returnPath, ids.size === 0, initialSelection, guard)
    if (waitingForPeers) {
      throw new IdentityBoardLoadPending("Your boards are waiting for an available peer or stored copy. Retry loading boards.", storageFailure)
    }
  })
}

async function restoreBoardSelection(app: App, returnPath: string, emptyCatalog: boolean,
  initialSelection: ReturnType<App["captureWorkspaceSelection"]>, guard: () => void): Promise<void> {
  const available = app.availableWorkspaces.value
  const route = parseBoardRouteUrl(returnPath)
  const loaded = await readLoadedWorkspaceRoutes(app, available, guard)
  if (!initialSelection.isCurrent()) {
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
      const route = await app.withWorkspaceDoc(workspace.id, document => {
        if (document.id !== workspace.id) return null
        const board = Object.values(document.entities).find(entity => hasEntityKind(entity, "board"))
        return board ? { boardId: board.id, workspaceId: workspace.id, emptyDefault: isEmptyDefaultBoard(document) } : null
      })
      if (route) eligible.push(route)
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
    const pending = cause instanceof IdentityBoardLoadPending
    recordIdentityBrowserSignIn(phase, pending ? "pending" : "failed", {
      errorCode: phase === "catalog" ? (pending ? "catalog_pending" : "catalog_failed") : (pending ? "boards_pending" : "boards_failed"),
      elapsedMs: performance.now() - started,
    })
    throw cause
  }
}
