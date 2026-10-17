import { describe, expect, it } from "vitest"
import { assertWorkspaceTransition } from "./permissions"
import { canonicalizeJson } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { validateEntity, validateWorkspaceDoc, type WorkspaceDocumentV2, type WorkspaceEntity } from "./model"

const time = "2026-10-14T10:00:00.000Z"
function fixture(): WorkspaceDocumentV2 {
  const doc = createWorkspaceDoc("workspace", "Applications", "owner", "blank")
  const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
  doc.entities.column = { id: "column", kind: "column", title: "Applied",
    placement: { parentId: board.id, rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time }
  doc.entities.card = { id: "card", title: "Editable label", body: "", values: {},
    placement: { parentId: "column", rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time }
  return doc
}

function source() {
  return { id: "application-source:original", kind: "application_source", title: "Application source",
    placement: { parentId: "card", rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time,
    data: canonicalizeJson({ kind: "application-source-observation", version: 1, recordId: "original",
      workspaceId: "workspace", cardId: "card", applicationId: "workspace:card",
      observation: { phase: "original", origin: "manual", status: "pending", observedAt: time,
        jobUrl: "https://example.com/jobs/original" } }) }
}

function withSource(): WorkspaceDocumentV2 {
  const doc = fixture()
  doc.entities[source().id] = source() as unknown as WorkspaceEntity
  return doc
}

describe("Immutable original posting records (Requirement 8)", () => {
  it("Given a pending capture, When validating the separate child entity, Then it is accepted without invented page evidence", () => {
    expect(validateEntity(source()).ok).toBe(true)
    expect(validateWorkspaceDoc(withSource()).ok).toBe(true)
  })

  it.each(["owner", "editor"] as const)("Given a saved source, When %s overwrites, moves, disguises or deletes it, Then original evidence is protected", role => {
    const before = withSource()
    for (const change of ["data", "placement", "kind", "delete"] as const) {
      const after = structuredClone(before)
      const record = after.entities[source().id] as unknown as Record<string, unknown>
      if (change === "delete") delete after.entities[source().id]
      else if (change === "data") record.data = source().data.replace("jobs/original", "jobs/rewritten")
      else if (change === "placement") record.placement = { parentId: "other-card", rank: "0/1" }
      else delete record.kind
      expect(() => assertWorkspaceTransition(role, before, after, "owner")).toThrow(/immutable/i)
    }
  })

  it("Given original evidence, When editing the visible card label, Then the source remains unchanged", () => {
    const before = withSource(), after = structuredClone(before)
    after.entities.card!.title = "Another title"
    expect(() => assertWorkspaceTransition("editor", before, after, "editor")).not.toThrow()
    expect(after.entities[source().id]).toEqual(before.entities[source().id])
  })

  it("Given an existing card, When a visitor or automation tries to create a source, Then ordinary manual permissions cannot authorize it", () => {
    const before = fixture(), after = withSource()
    for (const role of ["visitor", "automation"] as const) {
      expect(() => assertWorkspaceTransition(role, before, after, "actor")).toThrow()
    }
  })

  it("Given a pending capture, When adding fabricated original text or foreign scope, Then the workspace rejects it", () => {
    for (const invalidData of [
      { observation: { phase: "original", origin: "manual", status: "pending", observedAt: time, text: "Invented" } },
      { workspaceId: "different-workspace" },
      { applicationId: "different-application" },
      { observation: { phase: "refresh", origin: "website", status: "unavailable", observedAt: time, originalRecordId: "missing" } },
    ]) {
      const doc = withSource(), record = doc.entities[source().id] as unknown as { data: string }
      const data = JSON.parse(record.data) as Record<string, unknown>
      record.data = canonicalizeJson({ ...data, ...invalidData })
      expect(validateWorkspaceDoc(doc).ok).toBe(false)
    }
  })
})
