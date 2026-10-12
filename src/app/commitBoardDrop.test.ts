import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { commitBoardDrop } from "./commitBoardDrop"
import type { AppBoardContext } from "./useAppBoard"
import type { Item } from "../domain/model"

const at = "2026-01-01T00:00:00.000Z"

function setup(item: Item, fail = false, activeBoard = true) {
  const regular = { id: "lead", title: "Lead", archive: false }
  const archive = { id: "archive", title: "Archive", archive: true }
  const executeCommandAsync = vi.fn(async () => { if (fail) throw new Error("offline") })
  const core = {
    tincanban: {
      activeBoard: ref(activeBoard ? { id: "board" } : null),
      activeWorkspace: { id: "workspace" },
      genericColumns: ref([regular, archive]),
      getActiveDoc: () => ({ entities: { [item.id]: item } }),
      getPresentedWorkspaceDoc: () => ({ entities: { [item.id]: item } }),
      executeCommandAsync,
    },
    notice: ref(""),
    archiveUndo: ref(undefined),
  } as unknown as AppBoardContext
  const presentation = { highlightMoved: vi.fn() }
  const drag = (targetId: string, beforeId: string | null = null, kind: "item" | "column" = "item") => ({
    id: kind === "column" ? "archive" : item.id, kind, source: { nextElementSibling: null } as unknown as HTMLElement,
    sourceParentId: "lead", target: { targetId, beforeId }, title: item.title,
  })
  return { core, presentation, executeCommandAsync, drag }
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item", title: "Card", body: "", values: {}, placement: { parentId: "lead", rank: "0/1" },
    createdAt: at, updatedAt: at, ...overrides,
  }
}

describe("board drop commits", () => {
  it("ignores missing targets and inactive boards", async () => {
    const { core, presentation, executeCommandAsync, drag } = setup(item())
    await commitBoardDrop({ ...drag("lead"), target: null }, core, presentation)
    const inactive = setup(item(), false, false)
    await commitBoardDrop(inactive.drag("lead"), inactive.core, inactive.presentation)
    expect(executeCommandAsync).not.toHaveBeenCalled()
    expect(inactive.executeCommandAsync).not.toHaveBeenCalled()
    expect(presentation.highlightMoved).not.toHaveBeenCalled()
  })

  it("archives active cards and exposes undo only after accepted commit", async () => {
    const { core, presentation, executeCommandAsync, drag } = setup(item())
    await commitBoardDrop(drag("archive"), core, presentation)
    expect(executeCommandAsync).toHaveBeenCalledWith({ kind: "setEntityArchived", entityId: "item", archived: true })
    expect(core.archiveUndo.value).toEqual({ workspaceId: "workspace", itemId: "item", title: "Card" })
    expect(core.notice.value).toBe("Item archived")
    expect(presentation.highlightMoved).toHaveBeenCalledWith("item", "item")
  })

  it("restores archived cards when dropped into active workflow", async () => {
    const archived = item({ lifecycle: JSON.stringify({ state: "archived", changedAt: at }) })
    const { core, presentation, executeCommandAsync, drag } = setup(archived)
    await commitBoardDrop(drag("lead", "before-card"), core, presentation)
    expect(executeCommandAsync).toHaveBeenCalledWith({ kind: "restoreAndMove", entityId: "item", parentId: "lead", beforeId: "before-card" })
    expect(core.notice.value).toBe("Item moved")
    expect(core.archiveUndo.value).toBeUndefined()
  })

  it("skips already archived cards dropped on archive and unchanged visible positions", async () => {
    vi.stubGlobal("HTMLElement", class HTMLElement {})
    const archived = item({ lifecycle: JSON.stringify({ state: "archived", changedAt: at }) })
    const first = setup(archived)
    await commitBoardDrop(first.drag("archive"), first.core, first.presentation)
    expect(first.executeCommandAsync).not.toHaveBeenCalled()

    const samePosition = setup(item())
    await commitBoardDrop(samePosition.drag("lead"), samePosition.core, samePosition.presentation)
    expect(samePosition.executeCommandAsync).not.toHaveBeenCalled()
  })

  it("reorders columns and reports move failures without announcing success", async () => {
    const base = setup(item())
    await commitBoardDrop(base.drag("board", "lead", "column"), base.core, base.presentation)
    expect(base.executeCommandAsync).toHaveBeenCalledWith({ kind: "moveEntity", entityId: "archive", parentId: "board", beforeId: "lead" })
    expect(base.presentation.highlightMoved).toHaveBeenCalledWith("archive", "column")
    expect(base.core.notice.value).toBe("Column moved")

    const failed = setup(item(), true)
    await commitBoardDrop(failed.drag("archive"), failed.core, failed.presentation)
    expect(failed.core.notice.value).toBe("Move failed: offline")
    expect(failed.presentation.highlightMoved).not.toHaveBeenCalled()
    expect(failed.core.archiveUndo.value).toBeUndefined()
  })
})
