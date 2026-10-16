import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Board, WorkspaceDocumentV2 } from "../domain/model"
import { snapshotPublicBoardSource } from "./publicProjection"
import { createBrowserBoardPublication as createPublicBoardPublication } from "../app/publicBoardPublication"

const mocks = vi.hoisted(() => ({ messages: [] as unknown[], reads: [] as string[] }))
vi.mock("../chat/service", () => ({ getChatScope: async () => "mesh-scope", loadChat: async () => ({ messages: mocks.messages, profiles: [] }) }))
vi.mock("../attachments", () => ({ readAttachment: async (reference: { fileName: string }) => {
  mocks.reads.push(reference.fileName)
  if (reference.fileName === "offline.pdf") throw new Error("No connected peer can provide this file")
  return new TextEncoder().encode(reference.fileName)
} }))

function fixture(): WorkspaceDocumentV2 {
  const place = (parentId: string | null, rank = "0/1") => ({ parentId, rank })
  return { id: "private-workspace", ownerPersonId: "private-owner", entities: {
    board: { id: "board", kind: "board", title: "Public", placement: place(null), archivedAt: null, archiveColumnId: "archive" },
    todo: { id: "todo", kind: "column", title: "To do", placement: place("board"), archivedAt: null },
    archive: { id: "archive", kind: "column", title: "private archive sentinel", placement: place("board", "1/1"), archivedAt: null },
    select: { id: "select", kind: "field", title: "Stage", valueType: "select", required: false, options: {
      visible: { id: "visible", title: "Active", rank: "0/1", archivedAt: null },
      hidden: { id: "hidden", title: "private option sentinel", rank: "1/1", archivedAt: "2026-01-01" },
    }, placement: place("board"), archivedAt: null },
    hiddenField: { id: "hiddenField", kind: "field", title: "private field sentinel", valueType: "text", required: false, placement: place("board", "1/1"), archivedAt: "2026-01-01" },
    card: { id: "card", title: "Public card", body: "Published body", values: { select: "hidden", hiddenField: "private value sentinel" }, placement: place("todo"), archivedAt: null },
    archivedCard: { id: "archivedCard", title: "archived card", body: "archived body", values: {}, placement: place("archive"), archivedAt: null, lifecycle: JSON.stringify({ state: "archived", changedAt: "2026-01-01" }) },
    other: { id: "other", kind: "board", title: "private other board", placement: place(null), archivedAt: null },
    privateFile: { id: "privateFile", kind: "document", title: "private file", documentKind: "attachment", format: "path", content: "/private/file", file: null, placement: place("other"), archivedAt: null },
  } } as unknown as WorkspaceDocumentV2
}
function message(id: string, itemId: string, fieldId?: string) {
  return { id: `private-device:${id}`, workspaceId: "mesh-scope", personId: "private-person", createdAt: "2026-10-10T10:00:00Z", body: id,
    context: { references: [{ workspaceScope: "mesh-scope", boardId: "board", itemId, ...(fieldId ? { fieldId } : {}) }], mentions: [] }, record: {} }
}
beforeEach(() => { mocks.messages = []; mocks.reads = [] })

describe("publication boundary regressions", () => {
  it("Given archived fields and options, When publishing, Then keep them hidden while preserving the visitor archive surface", async () => {
    const publication = await createPublicBoardPublication(fixture(), "private-workspace", "board")
    expect(publication.projection.columns.map(column => column.id)).toEqual(["todo", "archive"])
    expect(publication.projection.columns[1]).toMatchObject({ archive: true })
    expect(publication.projection.board.presentation?.archiveColumnId).toBe("archive")
    expect(publication.projection.cards.map(card => card.id)).toEqual(["card", "archivedCard"])
    expect(publication.projection.cards[1]).toMatchObject({ id: "archivedCard", columnId: "archive", parentId: null })
    expect(publication.projection.cards[0].values).toEqual({})
    expect(JSON.stringify(publication.projection)).not.toMatch(/hiddenField|private other board|private value sentinel/)
    expect(mocks.reads).toEqual([])
  })
  it("Given a restored card retaining an old timestamp, When publishing, Then canonical active lifecycle includes its current content", async () => {
    const document = fixture()
    document.entities.card = { ...document.entities.card, archivedAt: "2026-01-01", lifecycle: JSON.stringify({ state: "active", changedAt: "2026-10-10" }) } as never
    expect((await createPublicBoardPublication(document, "private-workspace", "board")).projection.cards.map(card => card.id)).toContain("card")
  })
  it.each(["title", "narrative", "overview"])("Given a discussion anchored to card %s, When publishing, Then its thread stays attached to the public card", async field => {
    mocks.messages = [message(`discussion-${field}`, "card", field)]
    const publication = await createPublicBoardPublication(fixture(), "private-workspace", "board")
    expect(publication.projection.discussions).toHaveLength(1)
    expect(publication.projection.discussions[0].targets).toEqual([{ type: "card", id: "card" }])
  })
  it("Given private and archived discussion anchors, When publishing, Then only the private anchor is excluded", async () => {
    mocks.messages = [message("private thread", "card", "hiddenField"), message("archived thread", "archivedCard")]
    expect((await createPublicBoardPublication(fixture(), "private-workspace", "board")).projection.discussions.map(item => item.body)).toEqual(["archived thread"])
  })
  it("Given a selected-board snapshot, When the source changes, Then captured content stays independent and unrelated metadata is absent", () => {
    const original = fixture()
    const snapshot = snapshotPublicBoardSource(original, "board")
    original.entities.card.title = "Changed privately"
    expect(snapshot.entities.card.title).toBe("Public card")
    expect(snapshot.entities.other).toBeUndefined()
    expect(snapshot.entities.privateFile).toBeUndefined()
    expect(snapshot.id).toBeUndefined()
    expect(snapshot.ownerPersonId).toBeUndefined()
  })
  it("Given display settings in the CRDT, When publishing, Then retain visitor presentation while removing private bindings", async () => {
    const document = fixture()
    Object.assign(document.entities.board!, { entityName: "lead", preset: { key: "job-search", version: 1, bindings: {
      "status.lead": "todo", "status.archived": "archive", "field.stage": "select", "field.private": "hiddenField", "option.stage.active": "visible", "option.stage.hidden": "hidden",
    } }, employee_profile: { stack: "private preferences", work_profile: "private preferences" }, cardStageButtons: [{ columnId: "todo" }, { columnId: "archive" }] })
    Object.assign(document.entities.todo!, { color: "#66b3ff", collapsible: true })
    const publication = await createPublicBoardPublication(document, "private-workspace", "board")
    expect(publication.projection.board.presentation).toEqual({ entityName: "lead", archiveColumnId: "archive", preset: { key: "job-search", version: 1,
      bindings: { "status.lead": "todo", "status.archived": "archive", "field.stage": "select", "option.stage.active": "visible" } }, cardStageButtons: [{ columnId: "todo" }, { columnId: "archive" }] })
    expect(publication.projection.columns[0]).toMatchObject({ color: "#66b3ff", collapsible: true })
    expect(JSON.stringify(publication.projection)).not.toMatch(/hiddenField|private preferences|employee_profile/)
    expect((document.entities.board as Board).preset?.bindings["status.archived"]).toBe("archive")
  })
  it("Given an attachment stage failure, When creating a publication, Then later files are not uploaded and no complete plan is returned", async () => {
    const document = fixture()
    for (const id of ["first", "second"]) document.entities[id] = { id, kind: "document", title: id, documentKind: "note", format: "markdown", content: `${id} bytes`, file: null, placement: { parentId: "board", rank: "0/1" }, archivedAt: null } as never
    const stage = vi.fn(async () => { throw new Error("Stage unavailable") })
    await expect(createPublicBoardPublication(document, "private-workspace", "board", stage)).rejects.toThrow("Stage unavailable")
    expect(stage).toHaveBeenCalledTimes(1)
  })
  it("Given a blob filename containing a private source path, When publishing, Then the manifest exposes only its basename", async () => {
    const document = fixture()
    document.entities.file = { id: "file", kind: "document", title: "Public handout", documentKind: "attachment", format: "pdf", content: null,
      file: { type: "blob", fileName: "/Users/private-person/export/release.pdf", mimeType: "application/pdf", byteLength: 1, sha256: "private-blob-id" },
      placement: { parentId: "card", rank: "0/1" }, archivedAt: null } as never
    const { projection } = await createPublicBoardPublication(document, "private-workspace", "board")
    expect(projection.files[0].fileName).toBe("release.pdf")
    expect(JSON.stringify(projection)).not.toMatch(/Users|private-person|export|private-blob-id/)
  })
  it("Given attachment retrieval throws after peer discovery, When publishing, Then failure identifies the file and recovery action", async () => {
    const document = fixture()
    document.entities.file = { id: "file", kind: "document", title: "Handout", documentKind: "attachment", format: "pdf", content: null,
      file: { type: "blob", fileName: "offline.pdf", mimeType: "application/pdf", byteLength: 1, sha256: "private-blob-id" },
      placement: { parentId: "card", rank: "0/1" }, archivedAt: null } as never
    await expect(createPublicBoardPublication(document, "private-workspace", "board")).rejects.toThrow(/offline\.pdf.*unavailable.*reconnect/i)
  })
})
