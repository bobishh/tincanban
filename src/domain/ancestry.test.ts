import { describe, expect, it } from "vitest"
import {
  sortEntitiesByRank,
  derivePlacementIssues,
  childrenIndex,
  getAncestryPath,
  getChildren,
  getVisibleChildren,
  indexedChildren,
  isEntityVisible,
  visibleIndexedChildren,
  renumberSiblings,
} from "./ancestry"
import type { Item, Column, Board, WorkspaceEntity } from "./model"

describe("Ancestry and placement projection (Requirement 1.4)", () => {
  it("indexes sorted children in one entity pass and walks ancestry without enumerating the entity record", () => {
    const board: Board = {
      id: "board_index", kind: "board", title: "Board", placement: { parentId: null, rank: "0/1" },
      archivedAt: null, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", preset: null,
    }
    const column: Column = {
      id: "column_index", kind: "column", title: "To do", placement: { parentId: board.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
    }
    const item: Item = {
      id: "item_index", title: "Item", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", body: "", values: {},
    }
    const entities: Record<string, WorkspaceEntity> = {
      [board.id]: board, [column.id]: column, [item.id]: item,
    }
    let enumerations = 0
    const counted = new Proxy(entities, {
      ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target) },
    })
    const index = childrenIndex(counted)

    expect(enumerations).toBe(1)
    expect(indexedChildren(index, column.id).map(entity => entity.id)).toEqual(getChildren(entities, column.id).map(entity => entity.id))
    expect(visibleIndexedChildren(index, entities, column.id).map(entity => entity.id)).toEqual(getVisibleChildren(entities, column.id).map(entity => entity.id))

    const noEnumeration = new Proxy(entities, {
      ownKeys() { throw new Error("Ancestry walk must follow parent IDs directly") },
    })
    expect(getAncestryPath(noEnumeration, item.id).path).toEqual([item.id, column.id, board.id])
  })

  it("breaks equal-rank ties deterministically by entity ID", () => {
    const itemA: Item = {
      id: "item_a",
      title: "Item A",
      placement: { parentId: "col_1", rank: "1/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }
    const itemB: Item = {
      id: "item_b",
      title: "Item B",
      placement: { parentId: "col_1", rank: "1/1" }, // same rank
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const sorted1 = sortEntitiesByRank([itemB, itemA])
    expect(sorted1.map((t) => t.id)).toEqual(["item_a", "item_b"])

    // Renumbering equal ranks separates them into consecutive integers
    const renumbered = renumberSiblings([itemB, itemA])
    expect(renumbered[0].placement.rank).toBe("0/1")
    expect(renumbered[1].placement.rank).toBe("1/1")
  })

  it("detects cycles, missing parents, and invalid parent kinds deterministically without hanging", () => {
    const board: Board = {
      id: "board_1",
      kind: "board",
      title: "Board",
      placement: { parentId: null, rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      preset: null,
    }

    const col: Column = {
      id: "col_1",
      kind: "column",
      title: "Col",
      placement: { parentId: "board_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
    }

    // Item cycle: A -> B -> A
    const itemA: Item = {
      id: "item_a",
      title: "A",
      placement: { parentId: "item_b", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }
    const itemB: Item = {
      id: "item_b",
      title: "B",
      placement: { parentId: "item_a", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    // Item with missing parent
    const itemMissing: Item = {
      id: "item_orphan",
      title: "Orphan",
      placement: { parentId: "non_existent_id", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    // Item with invalid parent kind (item parent is board)
    const itemBadParent: Item = {
      id: "item_bad_parent",
      title: "Bad Parent",
      placement: { parentId: "board_1", rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const entities: Record<string, WorkspaceEntity> = {
      [board.id]: board,
      [col.id]: col,
      [itemA.id]: itemA,
      [itemB.id]: itemB,
      [itemMissing.id]: itemMissing,
      [itemBadParent.id]: itemBadParent,
    }

    const issues = derivePlacementIssues(entities)
    expect(issues).toHaveLength(4)

    const cycleIssueA = issues.find((i) => i.entityId === "item_a")
    expect(cycleIssueA?.type).toBe("cycle")

    const orphanIssue = issues.find((i) => i.entityId === "item_orphan")
    expect(orphanIssue?.type).toBe("missing-parent")

    const badParentIssue = issues.find((i) => i.entityId === "item_bad_parent")
    expect(badParentIssue?.type).toBe("invalid-parent-kind")
  })

  it("enforces inherited visibility: child is hidden if parent is archived, and separately archived child stays archived on parent restore", () => {
    const board: Board = {
      id: "board_1",
      kind: "board",
      title: "Board",
      placement: { parentId: null, rank: "0/1" },
      archivedAt: null,
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      preset: null,
    }

    const col: Column = {
      id: "col_1",
      kind: "column",
      title: "Col",
      placement: { parentId: "board_1", rank: "0/1" },
      archivedAt: "2026-01-01T00:00:00.000Z", // Column is archived
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
    }

    const liveChild: Item = {
      id: "child_live",
      title: "Live Child",
      placement: { parentId: "col_1", rank: "0/1" },
      archivedAt: null, // Child is NOT archived, but parent column is archived
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const archivedChild: Item = {
      id: "child_archived",
      title: "Archived Child",
      placement: { parentId: "col_1", rank: "1/1" },
      archivedAt: "2026-01-01T00:00:00.000Z", // Child is separately archived
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
      body: "",
      values: {},
    }

    const entities: Record<string, WorkspaceEntity> = {
      [board.id]: board,
      [col.id]: col,
      [liveChild.id]: liveChild,
      [archivedChild.id]: archivedChild,
    }

    // Because column is archived, neither child is visible on board
    expect(isEntityVisible(entities, "child_live")).toBe(false)
    expect(isEntityVisible(entities, "child_archived")).toBe(false)
    expect(getVisibleChildren(entities, "col_1")).toHaveLength(0)

    // When column is restored (col.archivedAt = false)
    entities["col_1"] = { ...col, archivedAt: null }
    expect(isEntityVisible(entities, "child_live")).toBe(true)
    // Separately archived child must STILL be not visible
    expect(isEntityVisible(entities, "child_archived")).toBe(false)

    const visibleChildren = getVisibleChildren(entities, "col_1")
    expect(visibleChildren.map((c) => c.id)).toEqual(["child_live"])
  })
})
