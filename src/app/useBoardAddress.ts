import { computed, onBeforeUnmount, ref, watch } from "vue"
import { hasEntityKind, type Board, type WorkspaceDocumentV2 } from "../domain/model"
import type { useTincanban } from "../state"
import { boardRouteUrl, canonicalizeBoardRoute, isBoardAddressPath, parseBoardRoute, readBoardRouteHint, rememberBoardRouteHint } from "./boardRoute"
import { pairingLocationClearedEvent } from "../sync/deviceSyncInviteView"

type WorkspaceAddressApi = Pick<ReturnType<typeof useTincanban>, "ready" | "availableWorkspaces" | "activeWorkspace" |
  "activeBoard" | "docVersion" | "getCurrentProfile" | "readWorkspaceDoc" | "switchWorkspace">

interface BoardAddressLocation { pathname: string; search: string; hash: string }
export interface BoardAddressHistory {
  location(): BoardAddressLocation
  pushState(state: unknown, title: string, url: string): void
  replaceState(state: unknown, title: string, url: string): void
  addEventListener(type: "popstate", listener: () => void): void
  removeEventListener(type: "popstate", listener: () => void): void
}

export interface BoardAddressRuntime {
  getAvailableWorkspaces(): readonly { id: string }[]
  getActiveWorkspaceId(): string
  getActiveBoard(): { id: string; title: string } | null
  getIdentityId(): string | null
  getHintedWorkspaceId?(boardId: string): string | null
  readWorkspaceDoc(workspaceId: string): Promise<WorkspaceDocumentV2>
  switchWorkspace(workspaceId: string): Promise<void>
  onUnavailable?(boardId: string): void
}

export type BoardAddressStatus = "idle" | "resolving" | "available" | "unavailable"

export function createBoardAddressController(runtime: BoardAddressRuntime, history: BoardAddressHistory) {
  const location = () => history.location()
  const eligibleWorkspaceIds = () => new Set(runtime.getAvailableWorkspaces().map(workspace => workspace.id))

  async function resolveAddress(): Promise<BoardAddressStatus> {
    const route = currentRoute()
    if (!route) return isBoardAddressPath(location().pathname) ? unavailable("") : "idle"
    const identityId = runtime.getIdentityId()
    if (!identityId) return unavailable(route.boardId)
    const targetWorkspaceId = await findTargetWorkspace(route, identityId)
    if (!targetWorkspaceId || !await activateTarget(targetWorkspaceId, route, identityId)) return unavailable(route.boardId)
    const activeBoard = runtime.getActiveBoard()!
    rememberBoardRouteHint(identityId, activeBoard.id, targetWorkspaceId)
    const afterSwitch = location()
    canonicalizeBoardRoute({ ...afterSwitch, state: null, replaceState: (state, title, url) => history.replaceState(state, title, url) }, activeBoard.id, activeBoard.title)
    return "available"
  }

  /** Reveal an already-loaded exact local target while its startup history check runs. */
  function resolveActivePreview(): BoardAddressStatus {
    const route = currentRoute()
    if (!route) return isBoardAddressPath(location().pathname) ? unavailable("") : "idle"
    const identityId = runtime.getIdentityId()
    const workspaceId = runtime.getActiveWorkspaceId()
    const activeBoard = runtime.getActiveBoard()
    if (!identityId || !eligibleWorkspaceIds().has(workspaceId) || activeBoard?.id !== route.boardId) return "resolving"
    rememberBoardRouteHint(identityId, activeBoard.id, workspaceId)
    const current = location()
    canonicalizeBoardRoute({ ...current, state: null, replaceState: (state, title, url) => history.replaceState(state, title, url) }, activeBoard.id, activeBoard.title)
    return "available"
  }

  function currentRoute() {
    const current = location()
    return parseBoardRoute(current.pathname, current.search, current.hash)
  }

  function unavailable(boardId: string): BoardAddressStatus {
    runtime.onUnavailable?.(boardId)
    return "unavailable"
  }

  async function findTargetWorkspace(route: NonNullable<ReturnType<typeof parseBoardRoute>>, identityId: string): Promise<string | null> {
    const eligible = eligibleWorkspaceIds()
    const hinted = runtime.getHintedWorkspaceId?.(route.boardId) ?? null
    const candidates = [...new Set([...(hinted && eligible.has(hinted) ? [hinted] : []), ...eligible])]
    for (const workspaceId of candidates) {
      if (!isCurrentEligibleIdentity(identityId, workspaceId)) return null
      const document = await readEligibleDocument(workspaceId, route, identityId)
      if (document) return workspaceId
    }
    return null
  }

  async function readEligibleDocument(workspaceId: string, route: NonNullable<ReturnType<typeof parseBoardRoute>>, identityId: string): Promise<WorkspaceDocumentV2 | null> {
    try {
      const document = await runtime.readWorkspaceDoc(workspaceId)
      if (!isCurrentEligibleIdentity(identityId, workspaceId) || document.id !== workspaceId) return null
      return boardIn(document)?.id === route.boardId ? document : null
    } catch { return null /* A stale local catalog entry is not an eligible target. */ }
  }

  function isCurrentEligibleIdentity(identityId: string, workspaceId: string): boolean {
    return runtime.getIdentityId() === identityId && eligibleWorkspaceIds().has(workspaceId)
  }

  async function activateTarget(workspaceId: string, route: NonNullable<ReturnType<typeof parseBoardRoute>>, identityId: string): Promise<boolean> {
    if (!isCurrentEligibleIdentity(identityId, workspaceId)) return false
    try {
      if (runtime.getActiveWorkspaceId() !== workspaceId) await runtime.switchWorkspace(workspaceId)
    } catch { return false }
    const board = runtime.getActiveBoard()
    return isCurrentEligibleIdentity(identityId, workspaceId) && board?.id === route.boardId
  }

  function syncActiveBoard(workspaceId: string) {
    const board = runtime.getActiveBoard()
    if (!board || !eligibleWorkspaceIds().has(workspaceId)) return
    const identityId = runtime.getIdentityId()
    if (identityId) rememberBoardRouteHint(identityId, board.id, workspaceId)
    const current = location()
    const route = parseBoardRoute(current.pathname, current.search, current.hash)
    const url = boardRouteUrl(board.id, board.title, current)
    if (route?.boardId === board.id) {
      canonicalizeBoardRoute({ ...current, state: null, replaceState: (state, title, next) => history.replaceState(state, title, next) }, board.id, board.title)
    } else if (current.pathname === "/" || route) history.pushState(null, "", url)
  }

  return {
    resolveAddress,
    resolveActivePreview,
    syncActiveBoard,
    history: { location },
    start(onPopState: () => void) { history.addEventListener("popstate", onPopState); return () => history.removeEventListener("popstate", onPopState) },
  }
}

export function useBoardAddress(app: WorkspaceAddressApi) {
  const status = ref<BoardAddressStatus>(isBoardAddressPath(window.location.pathname) ? "resolving" : "idle")
  const unavailableBoardId = ref("")
  let generation = 0
  const controller = createBoardAddressController({
    getAvailableWorkspaces: () => app.availableWorkspaces.value,
    getActiveWorkspaceId: () => app.activeWorkspace.id,
    getActiveBoard: () => app.activeBoard.value,
    getIdentityId: () => app.getCurrentProfile()?.identity.personId ?? null,
    getHintedWorkspaceId: boardId => readBoardRouteHint(boardId),
    readWorkspaceDoc: async workspaceId => await app.readWorkspaceDoc(workspaceId) as WorkspaceDocumentV2,
    switchWorkspace: app.switchWorkspace,
    onUnavailable: boardId => { unavailableBoardId.value = boardId },
  }, browserHistory())

  async function resolveCurrentAddress() {
    const currentGeneration = ++generation
    unavailableBoardId.value = ""
    status.value = isBoardAddressPath(window.location.pathname) ? "resolving" : "idle"
    const result = app.ready.value ? await controller.resolveAddress() : controller.resolveActivePreview()
    if (currentGeneration !== generation) return
    status.value = result
  }
  function navigateToActiveBoard() {
    generation++
    controller.syncActiveBoard(app.activeWorkspace.id)
    const board = app.activeBoard.value
    if (board && parseBoardRoute(window.location.pathname)?.boardId === board.id) {
      unavailableBoardId.value = ""
      status.value = "available"
    }
  }
  const stopPopState = controller.start(() => { void resolveCurrentAddress() })
  let observedWorkspaceId = app.activeWorkspace.id
  watch(() => [app.ready.value, app.activeWorkspace.id, app.activeBoard.value?.id,
    app.getCurrentProfile()?.identity.personId, app.availableWorkspaces.value.map(workspace => workspace.id).join("\u0000")],
  (snapshot, previous) => {
    // After startup, workspace changes are user navigation and the sync watcher
    // below updates the URL. Only resolve broadly while booting or at readiness.
    if (!snapshot[0] || !previous || !previous[0]) void resolveCurrentAddress()
  }, { immediate: true })
  const onPairingLocationCleared = () => {
    if (app.ready.value) navigateToActiveBoard()
  }
  window.addEventListener(pairingLocationClearedEvent, onPairingLocationCleared)
  watch(() => app.getCurrentProfile()?.identity.personId, (identityId, previousIdentityId) => {
    if (previousIdentityId && identityId !== previousIdentityId && isBoardAddressPath(window.location.pathname)) {
      void resolveCurrentAddress()
    }
  })
  watch([() => app.ready.value, () => app.activeWorkspace.id, () => app.activeBoard.value?.id,
    () => app.activeBoard.value?.title, () => app.docVersion.value], () => {
    const workspaceId = app.activeWorkspace.id
    const workspaceChanged = workspaceId !== observedWorkspaceId
    observedWorkspaceId = workspaceId
    if (!app.ready.value || status.value === "resolving") return
    if (status.value === "unavailable") {
      if (!workspaceChanged) return
      status.value = "idle"
      unavailableBoardId.value = ""
    }
    controller.syncActiveBoard(workspaceId)
  }, { immediate: true })
  onBeforeUnmount(() => {
    generation++
    stopPopState()
    window.removeEventListener(pairingLocationClearedEvent, onPairingLocationCleared)
  })

  return {
    status: computed(() => status.value),
    unavailableBoardId: computed(() => unavailableBoardId.value),
    retry: resolveCurrentAddress,
    navigateToActiveBoard,
  }
}

function browserHistory(): BoardAddressHistory {
  return {
    location: () => ({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }),
    pushState: (state, title, url) => window.history.pushState(state, title, url),
    replaceState: (state, title, url) => window.history.replaceState(state, title, url),
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  }
}

function boardIn(document: WorkspaceDocumentV2): Board | undefined {
  return Object.values(document.entities).find((entity): entity is Board => hasEntityKind(entity, "board"))
}
