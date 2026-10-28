import { describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "../test/boardFixture"
import { hasEntityKind } from "./model"
import { prepareCommand } from "./commandHandlers"
import type { Command } from "./commandTypes"

function fixture() {
  const doc = createWorkspaceDoc("workspace", "Board", "owner", "blank")
  const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
  const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
  doc.entities.card = { id: "card", title: "Existing card", body: "Retained body", values: {},
    placement: { parentId: column.id, rank: "0/1" }, archivedAt: null, createdAt: "2026-10-28", updatedAt: "2026-10-28" }
  const commands: Command[] = [
    { kind: "createItem", id: board.id, parentId: column.id, title: "Replacement" },
    { kind: "createTemplate", id: board.id, title: "Replacement", markdown: "New template" },
    { kind: "addDocument", id: board.id, itemId: "card", title: "Replacement", documentKind: "note", format: "markdown", content: "New note" },
    { kind: "recordArtifact", id: board.id, itemId: "card", title: "Replacement", templateId: "template", artifactKind: "pdf",
      pdf: { type: "blob", sha256: "a".repeat(43), byteLength: 1, fileName: "result.pdf", mimeType: "application/pdf" } },
  ]
  return { doc, board, commands }
}

describe("creation identity", () => {
  it.each([0, 1, 2, 3])("Given an existing board ID, when creation command %i reuses it, then reject rather than overwrite the board", index => {
    const { doc, board, commands } = fixture()
    const retained = structuredClone(doc.entities[board.id])
    const result = prepareCommand(doc, commands[index]!, "2026-10-28", [], "owner")
    if (result.ok) result.value.apply(doc)
    expect(doc.entities[board.id]).toEqual(retained)
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } })
  })

  it.each([0, 1, 2, 3])("Given a fresh ID, when creation command %i runs, then preserve supported creation", index => {
    const { doc, commands } = fixture()
    const command = { ...commands[index]!, id: "new-entity" } as Command
    const result = prepareCommand(doc, command, "2026-10-28", [], "owner")
    expect(result.ok).toBe(true)
    if (result.ok) result.value.apply(doc)
    expect(doc.entities["new-entity"].title).toBe("Replacement")
  })
})
