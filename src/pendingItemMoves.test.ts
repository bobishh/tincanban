import { describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "./domain/seeds"
import { isItemArchived } from "./domain/archive"
import type { Item } from "./domain/model"
import { beginPendingItemMove, projectPendingItemMoves } from "./pendingItemMoves"

function board() {
  const doc = createWorkspaceDoc(crypto.randomUUID(), "Moves", "owner", "blank")
  const columns = Object.values(doc.entities).filter(entity => entity.kind === "column")
  const item: Item = { id: "card", title: "Card", body: "", values: {}, placement: { parentId: columns[0].id, rank: "0/1" }, archivedAt: null, createdAt: "", updatedAt: "" }
  doc.entities[item.id] = item
  return { doc, columns, item }
}

describe("Pending item move presentation", () => {
  it("Given a pending move, when projected before persistence, then placement changes without changing the committed document and failure restores it", () => {
    const { doc, columns, item } = board()
    const finish = beginPendingItemMove(doc, { kind: "moveEntity", entityId: item.id, parentId: columns[1].id })
    try {
      expect(projectPendingItemMoves(doc).entities[item.id].placement.parentId).toBe(columns[1].id)
      expect(doc.entities[item.id].placement.parentId).toBe(columns[0].id)
      expect(projectPendingItemMoves(board().doc).entities.card.placement.parentId).not.toBe(columns[1].id)
    } finally { finish() }
    expect(projectPendingItemMoves(doc)).toBe(doc)
  })

  it("Given consecutive moves, when an earlier move finishes, then the later selection remains and rollback uses the latest committed base", () => {
    const { doc, columns, item } = board()
    const first = beginPendingItemMove(doc, { kind: "moveEntity", entityId: item.id, parentId: columns[1].id })
    const second = beginPendingItemMove(doc, { kind: "moveEntity", entityId: item.id, parentId: columns[2].id })
    try {
      doc.entities[item.id] = { ...item, placement: { ...item.placement, parentId: columns[1].id } }
      first()
      expect(projectPendingItemMoves(doc).entities[item.id].placement.parentId).toBe(columns[2].id)
    } finally { first(); second() }
    expect(projectPendingItemMoves(doc).entities[item.id].placement.parentId).toBe(columns[1].id)
  })

  it("Given pending archive then restore, when the archive fails, then restoration remains valid against the committed active item", () => {
    const { doc, columns, item } = board()
    const archive = beginPendingItemMove(doc, { kind: "setEntityArchived", entityId: item.id, archived: true })
    let restore = () => {}
    try {
      expect(isItemArchived(projectPendingItemMoves(doc).entities[item.id] as Item)).toBe(true)
      restore = beginPendingItemMove(doc, { kind: "restoreAndMove", entityId: item.id, parentId: columns[1].id })
      archive()
      const projected = projectPendingItemMoves(doc).entities[item.id] as Item
      expect(isItemArchived(projected)).toBe(false)
      expect(projected.placement.parentId).toBe(columns[1].id)
    } finally { archive(); restore() }
  })
})
