import { describe, expect, it, vi } from "vitest"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { createBoardAddressController } from "./useBoardAddress"

const doc = (id: string, boardId: string, title: string) => ({ id, title, entities: { [boardId]: { id: boardId, kind: "board", title } } })

describe("private board address integration", () => {
  it("loads only entitled workspace summaries on explicit target resolution and activates exact board", async () => {
    const records = new Map([ ["workspace-a", doc("workspace-a", "board-a", "A")], ["workspace-b", doc("workspace-b", "board-target", "Current title")] ])
    let active = { id: "workspace-a" }
    const readWorkspaceDoc = vi.fn(async (id: string) => records.get(id)! as unknown as WorkspaceDocumentV2)
    const switched: string[] = []
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }, { id: "workspace-b" }],
      getActiveWorkspaceId: () => active.id,
      getActiveBoard: () => active.id === "workspace-b" ? { id: "board-target", title: "Current title" } : { id: "board-a", title: "A" },
      getIdentityId: () => "person-1",
      readWorkspaceDoc,
      switchWorkspace: async id => { switched.push(id); active = { id } },
    }, historyAt("/boards/board-target/old-title?message=m#message-m"))
    expect(await integration.resolveAddress()).toBe("available")
    expect(readWorkspaceDoc.mock.calls.map(([id]) => id)).toEqual(["workspace-a", "workspace-b"])
    expect(switched).toEqual(["workspace-b"])
    expect(integration.history.location()).toEqual({ pathname: "/boards/board-target/current-title", search: "?message=m", hash: "#message-m" })
  })

  it("rejects inaccessible targets without exposing the unrelated active board", async () => {
    const onUnavailable = vi.fn()
    const switchWorkspace = vi.fn()
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-a" }],
      getActiveWorkspaceId: () => "workspace-a",
      getActiveBoard: () => ({ id: "board-a", title: "Unrelated" }),
      getIdentityId: () => "person-1",
      readWorkspaceDoc: async () => doc("workspace-a", "board-a", "Unrelated") as unknown as WorkspaceDocumentV2,
      switchWorkspace,
      onUnavailable,
    }, historyAt("/boards/private-target/shared-slug"))
    expect(await integration.resolveAddress()).toBe("unavailable")
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledWith("private-target")
  })

  it("uses the exact hinted workspace only when it remains in current identity catalog", async () => {
    const readWorkspaceDoc = vi.fn(async (id: string) => { void id; return doc("workspace-other", "target", "Target") as unknown as WorkspaceDocumentV2 })
    const integration = createBoardAddressController({
      getAvailableWorkspaces: () => [{ id: "workspace-eligible" }],
      getHintedWorkspaceId: () => "workspace-foreign",
      getActiveWorkspaceId: () => "workspace-eligible",
      getActiveBoard: () => ({ id: "other", title: "Other" }),
      getIdentityId: () => "person-current",
      readWorkspaceDoc,
      switchWorkspace: vi.fn(),
    }, historyAt("/boards/target/target"))
    expect(await integration.resolveAddress()).toBe("unavailable")
    expect(readWorkspaceDoc.mock.calls.map(([id]) => id)).toEqual(["workspace-eligible"])
  })
})

function historyAt(path: string) {
  const url = new URL(path, "https://example.test")
  const listeners = new Set<(event: Event) => void>()
  const history = {
    location: () => ({ pathname: url.pathname, search: url.search, hash: url.hash }),
    pushState: vi.fn((_state: unknown, _title: string, next: string) => { url.href = new URL(next, url).href }),
    replaceState: vi.fn((_state: unknown, _title: string, next: string) => { url.href = new URL(next, url).href }),
    addEventListener: (_type: string, callback: (event: Event) => void) => listeners.add(callback),
    removeEventListener: (_type: string, callback: (event: Event) => void) => listeners.delete(callback),
    fire: () => { for (const listener of listeners) listener(new Event("popstate")) },
  }
  return history
}
