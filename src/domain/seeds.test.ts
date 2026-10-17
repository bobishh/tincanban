import { hasEntityKind } from "./model"
import { describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "../test/boardFixture"
import { validateWorkspaceDoc } from "./model"

describe("Workspace creation and seeds (Requirement 1.3)", () => {
  it("creates an independent Blank board workspace with To do / Doing / Done and no job search fields", () => {
    const ws = createWorkspaceDoc("ws_blank", "Personal Items", "person_123", "blank")

    expect(ws.id).toBe("ws_blank")
    expect(ws.title).toBe("Personal Items")
    expect(ws.ownerPersonId).toBe("person_123")
    expect(ws.archivedAt).toBeNull()
    expect(ws.migration).toBeNull()

    const validation = validateWorkspaceDoc(ws)
    expect(validation.ok).toBe(true)

    const entities = Object.values(ws.entities)
    const boards = entities.filter((e) => hasEntityKind(e, "board"))
    expect(boards).toHaveLength(1)
    const board = boards[0]
    expect(board.preset?.key).toBe("blank")
    expect(board.archiveColumnId).toBeNull()

    const columns = entities.filter((e) => hasEntityKind(e, "column"))
    expect(columns.map((c) => c.title)).toEqual(["To do", "Doing", "Done"])
    for (const col of columns) {
      expect(col.placement.parentId).toBe(board.id)
    }

    // Absolutely no fields in blank board
    const fields = entities.filter((e) => hasEntityKind(e, "field"))
    expect(fields).toHaveLength(0)
  })

  it("creates a Job search workspace with Lead, Applied, Interview, Offer, Archive and bound fields", () => {
    const ws = createWorkspaceDoc("ws_jobs", "Job Search", "person_123", "job-search")

    const validation = validateWorkspaceDoc(ws)
    expect(validation.ok).toBe(true)

    const entities = Object.values(ws.entities)
    const board = entities.find((e) => hasEntityKind(e, "board"))!
    expect(board.preset?.key).toBe("job-search")

    const columns = entities.filter((e) => hasEntityKind(e, "column"))
    expect(columns.map((c) => c.title)).toEqual(["Lead", "Applied", "Interview", "Rejected", "Offer", "Archive"])

    const rejectedCol = columns.find((c) => c.title === "Rejected")
    expect(rejectedCol?.archive).toBeUndefined()

    const archiveCol = columns.find((c) => c.title === "Archive")
    expect(archiveCol?.collapsible).toBe(true)
    expect(board.archiveColumnId).toBe(archiveCol?.id)

    // Check bound status keys
    const bindings = board.preset!.bindings
    expect(bindings["status.lead"]).toBeDefined()
    expect(bindings["status.applied"]).toBeDefined()
    expect(bindings["status.interview"]).toBeDefined()
    expect(bindings["status.rejected"]).toBe(rejectedCol?.id)
    expect(bindings["status.offer"]).toBeDefined()
    expect(bindings["status.archived"]).toBe(archiveCol?.id)

    // Check fields
    const fields = entities.filter((e) => hasEntityKind(e, "field"))
    const fieldTitles = fields.map((f) => f.title)
    expect(fieldTitles).toContain("Company")
    expect(fieldTitles).toContain("Role")
    expect(fieldTitles).toContain("Work mode")
    expect(fieldTitles).toContain("Priority")
    expect(fieldTitles).toContain("Fit score")
    expect(fieldTitles).toContain("Rejection notes / retrospective")

    expect(bindings["field.company"]).toBeDefined()
    expect(bindings["field.role"]).toBeDefined()
    expect(bindings["field.workMode"]).toBeDefined()
    expect(bindings["field.priority"]).toBeDefined()
    expect(bindings["field.rejectionReason"]).toBeDefined()
  })

  it("ensures two created workspaces have completely distinct entity IDs and don't leak state", () => {
    const ws1 = createWorkspaceDoc("ws_1", "Board 1", "person_1", "job-search")
    const ws2 = createWorkspaceDoc("ws_2", "Board 2", "person_1", "blank")

    const ids1 = new Set(Object.keys(ws1.entities))
    const ids2 = new Set(Object.keys(ws2.entities))

    for (const id of ids1) {
      expect(ids2.has(id)).toBe(false)
    }

    // Ensure no job-search fields leaked into blank
    const blankFields = Object.values(ws2.entities).filter((e) => hasEntityKind(e, "field"))
    expect(blankFields).toHaveLength(0)
  })
})
