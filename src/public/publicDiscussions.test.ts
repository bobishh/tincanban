import { describe, expect, it } from "vitest"
import { publicDiscussionView } from "./publicDiscussions"
import type { PublicBoardProjection } from "./publicSchema"

function snapshot(): PublicBoardProjection {
  return {
    kind: "tincanban-public-board", version: 1, board: { id: "board", title: "Hiring" },
    columns: [{ id: "todo", title: "To do", rank: "0/1" }],
    fields: [{ id: "role", title: "Role", valueType: "text", required: false, rank: "0/1", options: [] }],
    cards: [{ id: "card", parentId: null, columnId: "todo", title: "Engineer", body: "Details", values: {}, rank: "0/1" }],
    discussions: [
      { id: "root", threadId: "root", replyTo: null, author: "Alice", body: "**Question**", createdAt: "2026-10-16T10:00:00Z", targets: [{ type: "card", id: "card" }] },
      { id: "reply", threadId: "root", replyTo: "root", author: "Bob", body: "Answer", createdAt: "2026-10-16T10:01:00Z", targets: [{ type: "field", id: "role", cardId: "card" }] },
      { id: "board-note", threadId: "board-note", replyTo: null, author: "Alice", body: "Board note", createdAt: "2026-10-16T10:02:00Z", targets: [{ type: "board", id: "board" }] },
    ], files: [],
  }
}

describe("published visitor discussions", () => {
  it("Given published replies and field targets, When adapting for shared chat, Then preserve Markdown, reply roots and source references without inventing private identities", () => {
    const view = publicDiscussionView(snapshot())
    expect(view.allMessages[0]).toMatchObject({ personId: "", name: "Alice", body: "**Question**", workspaceId: "public:board" })
    expect(view.allMessages[1]?.context).toEqual({ references: [{ workspaceScope: "public:board", boardId: "board", itemId: "card", fieldId: "role" }], mentions: [], replyTo: "root", conversationRootId: "root" })
    expect(view.referenceChoices.find(choice => choice.anchor.itemId === "card")?.title).toBe("Engineer")
    expect(view.fieldTitles.role).toBe("Role")
  })

  it("Given an item with replies and unrelated board messages, When opening its visitor discussion, Then reuse shared conversation filtering and latest-thread selection", () => {
    const view = publicDiscussionView(snapshot())
    expect(view.cardDiscussions.get("card")).toEqual({ count: 2, messageId: "reply" })
    const discussion = view.cardWindow("card")!
    expect(view.messages(discussion).map(message => message.id)).toEqual(["root", "reply"])
    const thread = view.threadWindow("reply")!
    expect(thread).toMatchObject({ id: "conversation:root", rootId: "root", targetId: "reply", context: { replyTo: "root", conversationRootId: "root" } })
    expect(view.messages(thread).map(message => message.id)).toEqual(["root", "reply"])
    expect(view.messages(view.boardWindow()).map(message => message.id)).toEqual(["root", "reply", "board-note"])
  })

  it("Given missing or external discussion references, When resolving navigation, Then expose no unavailable card or invented thread", () => {
    const projection = snapshot()
    projection.discussions = []
    const view = publicDiscussionView(projection)
    expect(view.cardWindow("private-card")).toBeNull()
    expect(view.threadWindow("private-message")).toBeNull()
    expect(view.cardDiscussions.size).toBe(0)
    expect(view.messages(view.cardWindow("card")!)).toEqual([])
    expect(view.referenceCard({ workspaceScope: "private", boardId: "board", itemId: "card" })).toBeNull()
    expect(view.referenceCard({ workspaceScope: view.scope, boardId: "board", itemId: "card", fieldId: "role" })).toBe("card")
    expect(view.referenceCard({ workspaceScope: view.scope, boardId: "board", itemId: "private-card" })).toBeNull()
  })
})
