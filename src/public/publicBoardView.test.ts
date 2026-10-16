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
  it("Given bound option IDs and nested cards, When presenting a publication, Then lead values and status match visitor cards", () => {
    const view = publicBoardView({ ...snapshot, board: { ...snapshot.board,
      presentation: { preset: { key: "job-search", version: 1, bindings: {
        "field.priority": "priority", "option.priority.p0": "priority-high",
        "field.workMode": "mode", "option.workMode.remote": "mode-remote", "status.applied": "applied",
      } } } }, fields: [
        { id: "priority", title: "Priority", valueType: "select", required: false, rank: "0/1", options: [{ id: "priority-high", title: "Highest", rank: "0/1" }] },
        { id: "mode", title: "Mode", valueType: "select", required: false, rank: "1/1", options: [{ id: "mode-remote", title: "Anywhere", rank: "0/1" }] },
      ], cards: snapshot.cards.map(card => ({ ...card, values: { priority: "priority-high", mode: "mode-remote" } })) })
    expect(view.leads.get("card")).toMatchObject({ priority: "p0", workMode: "remote", status: "applied" })
    expect(view.leads.get("child")?.status).toBe("applied")
    expect(view.board).toMatchObject({ kind: "board", preset: { key: "job-search" } })
    expect(view.columns[0]).toMatchObject({ kind: "column", placement: { parentId: "board", rank: "0/1" } })
    expect(view.fields[0]).toMatchObject({ kind: "field", placement: { parentId: "board", rank: "0/1" } })
    expect(view.items[0]?.archivedAt).toBeNull()
  })
  it("Given presentation metadata referencing an unpublished field, When validating, Then reject the publication", () => {
    expect(() => validatePublicBoardProjection({ ...snapshot, board: { ...snapshot.board,
      presentation: { preset: { key: "job-search", version: 1, bindings: { "field.company": "private-field" } } } } })).toThrow()
  })
})
