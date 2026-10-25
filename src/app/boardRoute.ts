export interface BoardRoute {
  boardId: string
  slug: string
  search: string
  hash: string
}

export interface EligibleBoardRoute {
  boardId: string
  workspaceId: string
}

const boardRouteHintStorageKey = "tincanban.board-route-index.v1"
interface BoardRouteHintIndex {
  version: 1
  activeIdentityId: string
  identities: Record<string, Record<string, string>>
}

/** A local navigation hint only. It never proves that the current identity may open a board. */
export function readBoardRouteHint(boardId: string, storage?: Pick<Storage, "getItem">): string | null {
  if (!boardId) return null
  try {
    storage ??= globalThis.localStorage
    const value: unknown = JSON.parse(storage.getItem(boardRouteHintStorageKey) ?? "null")
    if (!isBoardRouteHintIndex(value)) return null
    const workspaceId = value.identities[value.activeIdentityId]?.[boardId]
    return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null
  } catch { return null }
}

/** Whether this browser has an identity-scoped route index; this only selects private startup. */
export function hasBoardRouteIdentityHint(storage?: Pick<Storage, "getItem">): boolean {
  try {
    storage ??= globalThis.localStorage
    const value: unknown = JSON.parse(storage.getItem(boardRouteHintStorageKey) ?? "null")
    return isBoardRouteHintIndex(value) && Boolean(value.activeIdentityId)
  } catch { return false }
}

export function rememberBoardRouteHint(identityId: string, boardId: string, workspaceId: string,
  storage?: Pick<Storage, "getItem" | "setItem">): void {
  if (!identityId || !boardId || !workspaceId) return
  try {
    storage ??= globalThis.localStorage
    const previous: unknown = JSON.parse(storage.getItem(boardRouteHintStorageKey) ?? "null")
    const index: BoardRouteHintIndex = isBoardRouteHintIndex(previous)
      ? structuredClone(previous)
      : { version: 1, activeIdentityId: identityId, identities: {} }
    index.activeIdentityId = identityId
    index.identities[identityId] ??= {}
    index.identities[identityId][boardId] = workspaceId
    storage.setItem(boardRouteHintStorageKey, JSON.stringify(index))
  } catch { /* Navigation hints are optional and never affect access. */ }
}

function isBoardRouteHintIndex(value: unknown): value is BoardRouteHintIndex {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("activeIdentityId" in value) || typeof value.activeIdentityId !== "string" ||
      !("identities" in value) || !value.identities || typeof value.identities !== "object") return false
  const identities = value.identities as Record<string, unknown>
  return Object.values(identities).every(mapping => !!mapping && typeof mapping === "object" &&
    Object.entries(mapping).every(([key, target]) => key.length > 0 && typeof target === "string" && target.length > 0))
}

export function parseBoardRoute(pathname: string, search = "", hash = ""): BoardRoute | null {
  const match = /^\/boards\/([^/]+)(?:\/([^/]+))?\/?$/u.exec(pathname)
  if (!match) return null
  try {
    const boardId = decodeURIComponent(match[1]!)
    const slug = match[2] ? decodeURIComponent(match[2]) : ""
    if (!boardId || hasForbiddenRouteCharacters(boardId) || hasForbiddenRouteCharacters(slug)) return null
    return { boardId, slug, search, hash }
  } catch {
    return null
  }
}

export function parseBoardRouteUrl(path: string): BoardRoute | null {
  try {
    const url = new URL(path, "https://tincanban.invalid")
    return parseBoardRoute(url.pathname, url.search, url.hash)
  } catch { return null }
}

/** Restore a board route only when board loading selected that exact eligible board. */
export function resolveIdentitySignInReturnPath(path: string,
  activeBoard: { id: string; title: string } | null): string {
  const route = parseBoardRouteUrl(path)
  if (route && activeBoard?.id === route.boardId) return boardRouteUrl(activeBoard.id, activeBoard.title, route)
  if (path === "/" || isBoardAddressPath(safePathname(path))) {
    return activeBoard ? boardRouteUrl(activeBoard.id, activeBoard.title) : "/"
  }
  return path
}

function safePathname(path: string): string {
  try { return new URL(path, "https://tincanban.invalid").pathname }
  catch { return path }
}

function hasForbiddenRouteCharacters(value: string): boolean {
  return value.includes("/") || value.includes("\\") || [...value].some(character => character.charCodeAt(0) < 32)
}

export function isBoardAddressPath(pathname: string): boolean {
  return /^\/boards(?:\/|$)/u.test(pathname)
}

export function boardSlug(title: string): string {
  const normalized = title.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
  return normalized.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "") || "board"
}

export function boardRouteUrl(boardId: string, title: string, location?: Pick<URL, "search" | "hash">): string {
  return `/boards/${encodeURIComponent(boardId)}/${encodeURIComponent(boardSlug(title))}${location?.search ?? ""}${location?.hash ?? ""}`
}

export interface BoardRouteHistory {
  pathname: string
  search: string
  hash: string
  state: unknown
  replaceState(state: unknown, title: string, url: string): void
}

export function canonicalizeBoardRoute(history: BoardRouteHistory, boardId: string, title: string): boolean {
  const route = parseBoardRoute(history.pathname, history.search, history.hash)
  if (!route || route.boardId !== boardId) return false
  const canonical = boardRouteUrl(boardId, title, history)
  const current = `${history.pathname}${history.search}${history.hash}`
  if (canonical === current) return false
  history.replaceState(history.state, "", canonical)
  return true
}

/** Resolve URL hints only against caller-supplied locally eligible board references. */
export function resolveEligibleBoardRoute(route: BoardRoute, eligible: readonly EligibleBoardRoute[]): EligibleBoardRoute | null {
  return eligible.find(candidate => candidate.boardId === route.boardId) ?? null
}

export interface PrivateBoardRouteControllerOptions {
  getEligibleBoards(): readonly EligibleBoardRoute[]
  getActiveBoard(): { boardId: string; title: string } | null
  getIdentityId?(): string | null
  activateBoard(workspaceId: string): Promise<void>
  onUnavailable?(route: BoardRoute): void
  history?: Window
}

/** Private route controller. Board references select candidates; activation must retain normal access checks. */
export function createPrivateBoardRouteController(options: PrivateBoardRouteControllerOptions) {
  const history = options.history ?? window
  const routeHistory = (): BoardRouteHistory => ({
    pathname: history.location.pathname, search: history.location.search, hash: history.location.hash,
    state: history.history.state,
    replaceState: (state, title, url) => history.history.replaceState(state, title, url),
  })
  async function resolveAddress(): Promise<boolean> {
    const route = parseBoardRoute(history.location.pathname, history.location.search, history.location.hash)
    if (!route) return false
    const candidate = resolveEligibleBoardRoute(route, options.getEligibleBoards())
    if (!candidate) {
      options.onUnavailable?.(route)
      return false
    }
    const active = options.getActiveBoard()
    if (active?.boardId !== candidate.boardId) await options.activateBoard(candidate.workspaceId)
    const resolved = options.getActiveBoard()
    if (resolved?.boardId === candidate.boardId) sync(candidate.boardId, resolved.title)
    return resolved?.boardId === candidate.boardId
  }
  const onPopState = () => { void resolveAddress() }
  function sync(boardId: string, title: string) {
    const current = parseBoardRoute(history.location.pathname, history.location.search, history.location.hash)
    const candidate = options.getEligibleBoards().find(item => item.boardId === boardId)
    const identityId = options.getIdentityId?.()
    if (candidate && identityId) rememberBoardRouteHint(identityId, boardId, candidate.workspaceId)
    const url = boardRouteUrl(boardId, title, history.location)
    if (current?.boardId === boardId) canonicalizeBoardRoute(routeHistory(), boardId, title)
    else history.history.pushState(history.history.state, "", url)
  }
  return {
    resolveAddress,
    start() { history.addEventListener("popstate", onPopState); return () => history.removeEventListener("popstate", onPopState) },
    sync,
  }
}
