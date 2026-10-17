import { describe, expect, it } from "vitest"
import { hasEntityKind, type Item } from "./domain/model"
import { createWorkspaceDoc } from "./test/boardFixture"
import { projectWorkspace } from "./stateProjection"

const changedAt = "2026-10-07T12:00:00.000Z"

function item(id: string, parentId: string, archived: boolean): Item {
  return {
    id,
    title: `${id} — Engineer`,
    body: "",
    values: {},
    placement: { parentId, rank: "0/1" },
    createdAt: changedAt,
    updatedAt: changedAt,
    lifecycle: JSON.stringify({ state: archived ? "archived" : "active", changedAt }),
    workflow: JSON.stringify({ columnId: parentId, changedAt }),
  }
}

describe("legacy projection archive authority", () => {
  it("uses current archive role for legacy status mapping and lifecycle for archived state", () => {
    const doc = createWorkspaceDoc("projection-archive-authority", "Job search", "owner", "job-search")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    if (!hasEntityKind(board, "board")) throw new Error("Expected board")
    const formerArchiveId = board.archiveColumnId!
    const currentArchiveId = board.preset!.bindings["status.lead"]!
    doc.entities[board.id] = { ...board, archiveColumnId: currentArchiveId }
    doc.entities.active = item("active", formerArchiveId, false)
    doc.entities.archived = item("archived", formerArchiveId, true)

    const projection = projectWorkspace(doc as never)
    expect(projection.items.find(lead => lead.id === "active")?.id).toBe("active")
    expect(projection.items.find(lead => lead.id === "archived")?.id).toBe("archived")
  })

  it("does not infer archive state from the former preset binding after role is cleared", () => {
    const doc = createWorkspaceDoc("projection-cleared-archive", "Job search", "owner", "job-search")
    const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
    if (!hasEntityKind(board, "board")) throw new Error("Expected board")
    const formerArchiveId = board.archiveColumnId!
    doc.entities[board.id] = { ...board, archiveColumnId: null }
    doc.entities.active = item("active", formerArchiveId, false)

    expect(projectWorkspace(doc as never).items.find(lead => lead.id === "active")?.id).toBe("active")
  })
})
