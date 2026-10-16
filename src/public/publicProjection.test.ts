import { describe, expect, it, vi } from "vitest"
import { validatePublicBoardProjection } from "./publicProjection"
import { createBrowserBoardPublication as createPublicBoardPublication } from "../app/publicBoardPublication"
import { loadChat } from "../chat/service"
import { readAttachment } from "../attachments"

vi.mock("../chat/service", () => ({ getChatScope: vi.fn(async () => "resolved-mesh-scope"), loadChat: vi.fn(async () => ({ messages: [], profiles: [] })) }))
vi.mock("../attachments", () => ({ readAttachment: vi.fn(async (reference: { fileName: string }) => reference.fileName === "unavailable.pdf" ? undefined : new TextEncoder().encode(reference.fileName)) }))

function fixture() {
  const boardId = "selected-board"
  const foreignBoardId = "other-board"
  return {
    kind: "workspace" as const,
    formatVersion: 3 as const,
    id: "private-workspace-id",
    title: "Private workspace title",
    archivedAt: null,
    ownerPersonId: "private-owner",
    migration: null,
    chat: "private chat sentinel",
    credentials: "private key sentinel",
    entities: {
      [boardId]: { id: boardId, kind: "board", title: "Published board", placement: { parentId: null, rank: "0/1" }, archivedAt: null,
        preset: null, cardStageButtons: [], priorityPolicy: null, archiveColumnId: null },
      "column-a": { id: "column-a", kind: "column", title: "Doing", placement: { parentId: boardId, rank: "2/1" }, archivedAt: null },
      "column-b": { id: "column-b", kind: "column", title: "To do", archive: true, placement: { parentId: boardId, rank: "1/1" }, archivedAt: null },
      "field-a": { id: "field-a", kind: "field", title: "Company", valueType: "text", required: false, placement: { parentId: boardId, rank: "1/1" }, archivedAt: null },
      "card-a": { id: "card-a", title: "Nested parent", body: "public body", values: { "field-a": "public value", secretField: "private field sentinel" }, placement: { parentId: "column-a", rank: "1/1" }, archivedAt: null },
      "card-b": { id: "card-b", title: "Nested child", body: "child body", values: { "field-a": "child value" }, placement: { parentId: "card-a", rank: "1/1" }, archivedAt: null },
      "card-archived": { id: "card-archived", title: "archived sentinel", body: "archived body sentinel", values: {}, placement: { parentId: "column-b", rank: "2/1" }, archivedAt: null, lifecycle: JSON.stringify({ state: "archived", changedAt: "2026-01-01" }) },
      "cross-card": { id: "cross-card", title: "cross sentinel", body: "foreign", values: {}, placement: { parentId: foreignBoardId, rank: "1/1" }, archivedAt: null },
      [foreignBoardId]: { id: foreignBoardId, kind: "board", title: "other board sentinel", placement: { parentId: null, rank: "1/1" }, archivedAt: null },
      "public-note": { id: "public-note", kind: "document", title: "Board notes", documentKind: "note", format: "markdown", content: "public attachment body", file: null, placement: { parentId: boardId, rank: "3/1" }, archivedAt: null },
      "private-document": { id: "private-document", kind: "document", title: "private file sentinel", content: "private document sentinel", file: null, placement: { parentId: foreignBoardId, rank: "3/1" }, archivedAt: null },
      "private-automation": { id: "private-automation", kind: "automation", title: "private automation sentinel", definition: "secret", approval: "secret", executor: { origin: "secret", personId: "secret" }, controls: {}, placement: { parentId: boardId, rank: "4/1" }, archivedAt: null },
    },
  }
}

describe("public board projection", () => {
  it("Given the board's archive surface and independent collapse settings, When delivering the board, Then preserve the same visitor placement and settings", async () => {
    const doc = fixture()
    doc.entities["selected-board"].archiveColumnId = "column-b" as never
    Object.assign(doc.entities["column-b"], { collapsible: true })
    Object.assign(doc.entities["column-a"], { collapsible: false })
    doc.entities["card-archived"].placement.parentId = "column-a"
    const { projection } = await createPublicBoardPublication(doc as never, doc.id, "selected-board")
    expect(projection.board.presentation).toMatchObject({ archiveColumnId: "column-b" })
    expect(projection.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "column-b", archive: true, collapsible: true }),
      expect.objectContaining({ id: "column-a", collapsible: false }),
    ]))
    expect(projection.cards.find(card => card.id === "card-archived")).toMatchObject({ columnId: "column-b", parentId: null })
    expect(projection.cards.filter(card => card.id === "card-archived")).toHaveLength(1)
  })

  it("Given caller-owned admitted chat and file readers, When building a board view, Then avoid private browser storage adapters", async () => {
    vi.mocked(loadChat).mockClear()
    const { projection } = await createPublicBoardPublication(fixture() as never, "private-workspace-id", "selected-board", undefined, {
      chat: { scope: "resolved-mesh-scope", messages: [], profiles: [] },
      readFile: async () => undefined,
    })
    expect(projection.board.id).toBe("selected-board")
    expect(loadChat).not.toHaveBeenCalled()
  })

  it("publishes only selected active board structure and nested cards in stable order", async () => {
    const { projection } = await createPublicBoardPublication(fixture() as never, "private-workspace-id", "selected-board")
    expect(projection.board.id).toBe("selected-board")
    expect(projection.columns.map(column => column.id)).toEqual(["column-b", "column-a"])
    expect(projection.fields.map(field => field.id)).toEqual(["field-a"])
    expect(projection.cards.map(card => [card.id, card.parentId])).toEqual([["card-a", null], ["card-b", "card-a"]])
    expect(projection.files.map(file => [file.title, file.fileName])).toEqual([["Board notes", "Board notes.md"]])
    expect(JSON.stringify(projection)).not.toMatch(/private-workspace-id|private-owner|sentinel|secret|other-board/)
  })

  it("Given column and automatic priority settings, When publishing, Then preserve visitor presentation and effective card values", async () => {
    const doc = fixture() as unknown as { entities: Record<string, Record<string, unknown>> }
    Object.assign(doc.entities["selected-board"], { entityName: "lead", preset: { key: "job-search", version: 1, bindings: {
      "field.priority": "priority", "option.priority.p0": "high", "field.fitScore": "fit", "status.lead": "column-a",
    } }, priorityPolicy: { version: 1, evaluator: "weighted-rules-v1", priorityFieldId: "priority", fitFieldId: "fit",
      rules: [{ id: "match", fieldId: "field-a", operator: "is_set", value: null, weight: 8 }], bands: [{ optionId: "high", minScore: 0 }] } })
    for (const id of ["column-a", "column-b"]) Object.assign(doc.entities[id], { collapsible: true, color: "#66b3ff" })
    doc.entities.priority = { ...doc.entities["field-a"], id: "priority", valueType: "select", options: { high: { id: "high", title: "Highest", rank: "0/1", archivedAt: null } } }
    doc.entities.fit = { ...doc.entities["field-a"], id: "fit", valueType: "number", min: 0, max: 10 }
    const { projection } = await createPublicBoardPublication(doc as never, "private-workspace-id", "selected-board")
    expect(projection.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "column-a", collapsible: true, color: "#66b3ff" }),
      expect.objectContaining({ id: "column-b", collapsible: true, color: "#66b3ff" }),
    ]))
    expect(projection.board.presentation).toMatchObject({ entityName: "lead", preset: { bindings: { "option.priority.p0": "high" } } })
    expect(projection.cards[0]?.values).toMatchObject({ priority: "high", fit: 8 })
    expect(JSON.stringify(projection)).not.toMatch(/priorityPolicy|employee_profile|private-owner/)
  })

  it("publishes only anchored discussion threads with opaque IDs and safe references", async () => {
    const root = { id: "device-private:root", workspaceId: "resolved-mesh-scope", personId: "person-private", createdAt: "2026-10-10T10:00:00Z", body: "public discussion", record: {}, context: { references: [{ workspaceScope: "resolved-mesh-scope", boardId: "selected-board", itemId: "card-a", selection: { exact: "private quote sentinel", prefix: "secret prefix", suffix: "secret suffix", start: 0, end: 20 } }], mentions: ["private-person-id"] } }
    const reply = { ...root, id: "device-private:reply", createdAt: "2026-10-10T11:00:00Z", body: "public reply", context: { references: [], mentions: [], replyTo: root.id, conversationRootId: root.id } }
    const unrelated = { ...root, id: "device-private:other", body: "other board sentinel", context: { references: [{ workspaceScope: "resolved-mesh-scope", boardId: "other-board", itemId: "cross-card" }], mentions: [] } }
    vi.mocked(loadChat).mockResolvedValue({ messages: [root, reply, unrelated] as never, profiles: [{ workspaceId: "resolved-mesh-scope", personId: "person-private", name: "Public label", revision: 1, record: {} }] })
    const { projection } = await createPublicBoardPublication(fixture() as never, "private-workspace-id", "selected-board")
    expect(projection.discussions.map(message => message.body)).toEqual(["public discussion", "public reply"])
    expect(projection.discussions[1].replyTo).toBe(projection.discussions[0].id)
    expect(projection.discussions[0].author).toBe("Public label")
    expect(JSON.stringify(projection)).not.toMatch(/device-private|person-private|private-person-id|other board sentinel|private quote sentinel|secret prefix|secret suffix/)
    expect(() => validatePublicBoardProjection({ ...projection, discussions: projection.discussions.map(message => ({ ...message, targets: [{ ...message.targets[0], selection: { exact: "private quote sentinel", prefix: "", suffix: "", start: 0, end: 20 } }] })) })).toThrow()
  })

  it("rejects malformed, cross-linked and oversized public snapshots", async () => {
    const doc = fixture()
    doc.entities["selected-board"].archiveColumnId = "column-b" as never
    const { projection } = await createPublicBoardPublication(doc as never, "private-workspace-id", "selected-board")
    expect(() => validatePublicBoardProjection({ ...projection, extra: "private" })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, cards: [{ ...projection.cards[0], values: { unknown: "leak" } }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, board: { ...projection.board, id: "not valid!" } })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, cards: projection.cards.map(card => ({ ...card, parentId: card.id })) })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, cards: [...projection.cards, { ...projection.cards[0], id: "card-a" }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, discussions: [{ id: "discussion", threadId: "discussion", replyTo: null, targets: [{ type: "card", id: "private-card" }], author: "Author", createdAt: "2026-10-10", body: "private" }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, board: { ...projection.board, title: "x".repeat(3 * 1024 * 1024) } })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, fields: [{ ...projection.fields[0], options: [{ id: "archived-option", title: "bad", rank: "!" }] }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, board: { ...projection.board, presentation: { ...projection.board.presentation, archiveColumnId: "missing" } } })).toThrow(/Archive column binding/)
    expect(() => validatePublicBoardProjection({ ...projection, cards: projection.cards.map(card => card.id === "card-archived" ? { ...card, parentId: "card-a" } : card) })).toThrow(/archive root/)
  })

  it("publishes authorized file bytes and both artifact files, while rejecting local paths and unavailable blobs", async () => {
    const workspace = fixture() as unknown as { entities: Record<string, unknown> }
    const ref = (fileName: string) => ({ type: "blob" as const, fileName, mimeType: "application/pdf", byteLength: 10, sha256: "source-hash" })
    workspace.entities["card-file"] = { id: "card-file", kind: "document", documentKind: "attachment", title: "Card file", format: "pdf", content: null, file: ref("card.pdf"), placement: { parentId: "card-a", rank: "2/1" }, archivedAt: null } as never
    workspace.entities.artifact = { id: "artifact", kind: "artifact", artifactKind: "cv", templateId: "private-template-id", title: "Profile", pdf: ref("profile.pdf"), sourceMarkdown: ref("profile.md"), placement: { parentId: "card-a", rank: "3/1" }, archivedAt: null } as never
    const result = await createPublicBoardPublication(workspace as never, "private-workspace-id", "selected-board")
    expect(result.projection.files.map(file => file.fileName)).toEqual(expect.arrayContaining(["card.pdf", "profile.pdf", "profile.md"]))
    expect(result.assets).toHaveLength(4)
    expect(readAttachment).toHaveBeenCalled()
    expect(JSON.stringify(result.projection)).not.toContain("private-template-id")

    workspace.entities["private-path"] = { id: "private-path", kind: "document", documentKind: "attachment", title: "Secret path", format: "path", content: "/Users/private/secret.pdf", file: null, placement: { parentId: "card-a", rank: "4/1" }, archivedAt: null } as never
    await expect(createPublicBoardPublication(workspace as never, "private-workspace-id", "selected-board")).rejects.toThrow(/private local path/)
    delete workspace.entities["private-path"]
    workspace.entities["unavailable-file"] = { id: "unavailable-file", kind: "document", documentKind: "attachment", title: "Unavailable", format: "pdf", content: null, file: ref("unavailable.pdf"), placement: { parentId: "card-a", rank: "5/1" }, archivedAt: null } as never
    await expect(createPublicBoardPublication(workspace as never, "private-workspace-id", "selected-board")).rejects.toThrow(/unavailable/)
  })
})
