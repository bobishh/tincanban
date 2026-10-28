import { describe, expect, it } from "vitest"
import { prepareCommand } from "./commandHandlers"
import { assertWorkspaceCommand, assertWorkspaceTransition } from "./permissions"
import { createWorkspaceDoc } from "../test/boardFixture"

describe("board publication host ownership", () => {
  it("Given an owner and two boards, when selecting a publication host, then change only the selected board and preserve its content", () => {
    const doc = createWorkspaceDoc("workspace", "Job search", "owner", "blank")
    const board = Object.values(doc.entities).find(entity => "kind" in entity && entity.kind === "board")!
    doc.entities.other = { ...structuredClone(board), id: "other", title: "Private board" }
    const command = { kind: "setBoardPublicationOrigin" as const, boardId: board.id, origin: "https://rusty.example" }
    const before = structuredClone(doc)
    assertWorkspaceCommand("owner", doc, command)
    const result = prepareCommand(doc as never, command, "2026-10-28T10:00:00Z", [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    result.value.apply(doc)
    expect(doc.entities[board.id]).toMatchObject({ publicationOrigin: "https://rusty.example" })
    expect(result.value.changedEntityIds).toEqual([board.id])
    expect(Object.values(doc.entities).filter(entity => entity.id !== board.id)).toEqual(Object.values(before.entities).filter(entity => entity.id !== board.id))
    expect(() => assertWorkspaceTransition("owner", before, doc, "owner")).not.toThrow()
    expect(() => assertWorkspaceTransition("editor", before, doc, "editor")).toThrow()
    expect(() => assertWorkspaceCommand("editor", before, command)).toThrow()
  })

  it.each(["https://user:password@rusty.example", "http://remote.example", "https://rusty.example/private", "javascript:alert(1)"])(
    "rejects an unsafe publication host: %s", origin => {
      const doc = createWorkspaceDoc("workspace", "Job search", "owner", "blank")
      const board = Object.values(doc.entities).find(entity => "kind" in entity && entity.kind === "board")!
      const result = prepareCommand(doc as never, { kind: "setBoardPublicationOrigin", boardId: board.id, origin }, "2026-10-28T10:00:00Z", [])
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    },
  )
})
