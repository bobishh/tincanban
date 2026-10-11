import { describe, expect, it, vi } from "vitest"
import { createPublicBoardPublication, validatePublicBoardProjection } from "./publicProjection"
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
  it("publishes only selected active board structure and nested cards in stable order", async () => {
    const { projection } = await createPublicBoardPublication(fixture() as never, "private-workspace-id", "selected-board")
    expect(projection.board.id).toBe("selected-board")
    expect(projection.columns.map(column => column.id)).toEqual(["column-b", "column-a"])
    expect(projection.fields.map(field => field.id)).toEqual(["field-a"])
    expect(projection.cards.map(card => [card.id, card.parentId])).toEqual([["card-a", null], ["card-b", "card-a"]])
    expect(projection.files.map(file => [file.title, file.fileName])).toEqual([["Board notes", "Board notes.md"]])
    expect(JSON.stringify(projection)).not.toMatch(/private-workspace-id|private-owner|sentinel|secret|other-board/)
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
    const { projection } = await createPublicBoardPublication(fixture() as never, "private-workspace-id", "selected-board")
    expect(() => validatePublicBoardProjection({ ...projection, extra: "private" })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, cards: [{ ...projection.cards[0], values: { unknown: "leak" } }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, board: { ...projection.board, id: "not valid!" } })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, cards: projection.cards.map(card => ({ ...card, parentId: card.id })) })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, cards: [...projection.cards, { ...projection.cards[0], id: "card-a" }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, discussions: [{ id: "discussion", threadId: "discussion", replyTo: null, targets: [{ type: "card", id: "private-card" }], author: "Author", createdAt: "2026-10-10", body: "private" }] })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, board: { ...projection.board, title: "x".repeat(3 * 1024 * 1024) } })).toThrow()
    expect(() => validatePublicBoardProjection({ ...projection, fields: [{ ...projection.fields[0], options: [{ id: "archived-option", title: "bad", rank: "!" }] }] })).toThrow()
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
