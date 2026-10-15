import { describe, expect, it } from "vitest"
import { publicBoardView } from "./publicBoardView"
import { validatePublicBoardProjection, type PublicBoardProjection } from "./publicSchema"

const snapshot: PublicBoardProjection = {
  kind: "tincanban-public-board", version: 1, board: { id: "board", title: "Job search" },
  columns: [{ id: "applied", title: "Applied", rank: "0/1" }],
  fields: [{ id: "company", title: "Company", valueType: "text", required: true, rank: "0/1", options: [] }],
  cards: [{ id: "card", parentId: null, columnId: "applied", title: "Acme — Engineer", body: "Description", values: { company: "Acme" }, rank: "0/1" },
    { id: "child", parentId: "card", columnId: "applied", title: "Follow up", body: "", values: {}, rank: "1/1" }],
  discussions: [], files: [],
}

describe("public visitor presentation", () => {
  it("Given a legacy publication, When adapting for visitor components, Then nested cards keep their hierarchy and field definitions", () => {
    const view = publicBoardView(snapshot)
    expect(view.columns[0]?.items.map(item => item.id)).toEqual(["card"])
    expect(view.items.find(item => item.id === "child")?.placement.parentId).toBe("card")
    expect(view.fields[0]).toMatchObject({ id: "company", valueType: "text" })
    expect(view.board.title).toBe("Job search")
  })
  it("Given published presentation metadata, When adapting, Then visitor cards retain job bindings, column accents and narrative", () => {
    const projection = validatePublicBoardProjection({ ...snapshot, board: { ...snapshot.board,
      presentation: { entityName: "lead", preset: { key: "job-search", version: 1, bindings: { "field.company": "company", "status.applied": "applied" } } } },
      columns: [{ ...snapshot.columns[0], color: "#66b3ff", collapsible: true }] })
    const view = publicBoardView(projection)
    expect(view.board.preset?.key).toBe("job-search")
    expect(view.leads.get("card")).toMatchObject({ company: "Acme", role: "Engineer", status: "applied" })
    expect(view.columns[0]).toMatchObject({ color: "#66b3ff", collapsible: true })
    expect(view.items[0]?.body).toBe("Description")
  })
  it("Given presentation metadata referencing an unpublished field, When validating, Then reject the publication", () => {
    expect(() => validatePublicBoardProjection({ ...snapshot, board: { ...snapshot.board,
      presentation: { preset: { key: "job-search", version: 1, bindings: { "field.company": "private-field" } } } } })).toThrow()
  })
})
