import { describe, expect, it, vi } from "vitest"
import { boardRouteUrl, boardSlug, canonicalizeBoardRoute, createPrivateBoardRouteController, parseBoardRoute, readBoardRouteHint, rememberBoardRouteHint, resolveEligibleBoardRoute, resolveIdentitySignInReturnPath } from "./boardRoute"

describe("board routes", () => {
  it("parses legacy and slugged addresses while preserving message targets", () => {
    expect(parseBoardRoute("/boards/board-1", "?message=m-1", "#message-m-1")).toEqual({
      boardId: "board-1", slug: "", search: "?message=m-1", hash: "#message-m-1",
    })
    expect(parseBoardRoute("/boards/board-1/my-board", "?message=m-1", "#message-m-1")).toEqual({
      boardId: "board-1", slug: "my-board", search: "?message=m-1", hash: "#message-m-1",
    })
    expect(parseBoardRoute("/boards/board-1/a/second", "", "")).toBeNull()
  })

  it("builds stable readable slugs from titles", () => {
    expect(boardSlug("Hello, Déjà vu! Board #2")).toBe("hello-deja-vu-board-2")
    expect(boardSlug("Привет, мир! 東京 ２")).toBe("привет-мир-東京-2")
    expect(boardRouteUrl("board-1", "My board", new URL("https://example.test/boards/old?q=1#message"))).toBe(
      "/boards/board-1/my-board?q=1#message",
    )
  })

  it("canonicalizes stale slugs without dropping query or hash", () => {
    const replaceState = vi.fn()
    expect(canonicalizeBoardRoute({ pathname: "/boards/id/old", search: "?message=x", hash: "#x", state: { keep: true }, replaceState }, "id", "New Title")).toBe(true)
    expect(replaceState).toHaveBeenCalledWith({ keep: true }, "", "/boards/id/new-title?message=x#x")
  })

  it("resolves only an explicit eligible local board hint, never a default", () => {
    const route = parseBoardRoute("/boards/target-board/label", "", "")!
    expect(resolveEligibleBoardRoute(route, [{ boardId: "other", workspaceId: "workspace-1" }])).toBeNull()
    expect(resolveEligibleBoardRoute(route, [{ boardId: "target-board", workspaceId: "workspace-2" }])).toEqual({ boardId: "target-board", workspaceId: "workspace-2" })
  })

  it("restores the requested eligible board with query and hash, and falls back from an unavailable board route", () => {
    expect(resolveIdentitySignInReturnPath("/boards/board-b/old?filter=open#item-7", { id: "board-b", title: "Board B" }))
      .toBe("/boards/board-b/board-b?filter=open#item-7")
    expect(resolveIdentitySignInReturnPath("/boards/guest-board?filter=private#item", { id: "board-a", title: "Board A" }))
      .toBe("/boards/board-a/board-a")
    expect(resolveIdentitySignInReturnPath("/boards/guest-board", null)).toBe("/")
    expect(resolveIdentitySignInReturnPath("/settings?tab=profile#photo", { id: "board-a", title: "Board A" }))
      .toBe("/settings?tab=profile#photo")
  })

  it("keeps navigation hints separated by identity and treats malformed hints as absent", () => {
    const records = new Map<string, string>()
    const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) }
    rememberBoardRouteHint("person-a", "board-a", "workspace-a", storage)
    rememberBoardRouteHint("person-b", "board-b", "workspace-b", storage)
    expect(readBoardRouteHint("board-b", storage)).toBe("workspace-b")
    expect(readBoardRouteHint("board-a", storage)).toBeNull()
    records.set("tincanban.board-route-index.v1", "{broken")
    expect(readBoardRouteHint("board-b", storage)).toBeNull()
  })

  it("activates only the eligible board named by browser history", async () => {
    let location = { pathname: "/boards/target/old", search: "?message=m", hash: "#m" }
    let active: { boardId: string; title: string } | null = { boardId: "other", title: "Other" }
    const listeners = new Map<string, (event: Event) => void>()
    const switched: string[] = []
    const win = {
      get location() { return location }, history: { state: null, replaceState: vi.fn((_state, _title, url: string) => {
        const parsed = new URL(url, "https://example.test")
        location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash }
      }) },
      addEventListener: (name: string, listener: EventListenerOrEventListenerObject) => listeners.set(name, listener as (event: Event) => void),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as Window
    const controller = createPrivateBoardRouteController({
      getEligibleBoards: () => [{ boardId: "target", workspaceId: "workspace-target" }],
      getActiveBoard: () => active,
      activateBoard: async workspaceId => { switched.push(workspaceId); active = { boardId: "target", title: "New title" } },
      history: win,
    })
    const stop = controller.start()
    listeners.get("popstate")?.(new Event("popstate"))
    await Promise.resolve()
    expect(switched).toEqual(["workspace-target"])
    expect(location).toEqual({ pathname: "/boards/target/new-title", search: "?message=m", hash: "#m" })
    stop()
    expect(listeners.has("popstate")).toBe(false)
  })
})
