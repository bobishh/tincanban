import { describe, expect, it } from "vitest";
import { createWorkspaceDoc } from "../../../src/test/boardFixture";
import { hasEntityKind } from "../../../src/domain/model";
import { createPublicBoardPublication } from "../../../src/public/publicProjection";
import { automationPublicProjection } from "../src/publicBoardDelivery";

async function fixture() {
  const document = createWorkspaceDoc("workspace", "Published board", "owner", "job-search");
  const board = Object.values(document.entities).find(entity => hasEntityKind(entity, "board"))!;
  const column = Object.values(document.entities).find(entity => hasEntityKind(entity, "column") && entity.placement.parentId === board.id)!;
  document.entities.card = { id: "card", title: "Application", body: "Original description", values: {},
    placement: { parentId: column.id, rank: "0/1" }, archivedAt: null, createdAt: "2026-10-28", updatedAt: "2026-10-28" };
  document.entities.note = { id: "note", kind: "document", documentKind: "note", title: "Interview notes",
    format: "markdown", content: "Current retained discussion notes", file: null,
    placement: { parentId: "card", rank: "0/1" }, archivedAt: null };
  const { projection: current } = await createPublicBoardPublication(document, document.id, board.id, undefined, {});
  return { document, board, current };
}

describe("automation public projection", () => {
  it("Given a published card with inline narrative notes, when automation delivers a new card, then preserve notes in the existing card description", async () => {
    const { document, board, current } = await fixture();
    document.entities.newCard = { ...document.entities.card, id: "newCard", title: "New application" };
    const next = await automationPublicProjection(document, document.id, board.id, current);
    expect(next.cards.find(card => card.id === "card")?.body).toBe(current.cards[0]!.body);
    expect(next.cards.find(card => card.id === "card")?.body).toContain("Current retained discussion notes");
    expect(next.cards.some(card => card.id === "newCard")).toBe(true);
    expect(next.files).toEqual(current.files);
  });

  it("Given confirmed public discussion authors, when automation delivers a card update, then retain the exact discussion and author presentation together", async () => {
    const { document, board, current } = await fixture();
    current.discussions = [{ id: "discussion", threadId: "discussion", replyTo: null,
      targets: [{ type: "card", id: "card" }], authorId: "public-author", author: "Participant",
      createdAt: "2026-10-28T10:00:00.000Z", body: "Retained discussion" }];
    current.discussionAuthors = [{ id: "public-author", avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA" }];
    const next = await automationPublicProjection(document, document.id, board.id, current);
    expect(next.discussions).toEqual(current.discussions);
    expect(next.discussionAuthors).toEqual(current.discussionAuthors);
  });

  it("Given retained public content referring to an unavailable card, when automation prepares delivery, then reject the incoherent projection", async () => {
    const { document, board, current } = await fixture();
    current.files[0]!.parentId = "missing-card";
    await expect(automationPublicProjection(document, document.id, board.id, current)).rejects.toThrow("File parent is outside publication");
    expect(document.entities.note).toBeDefined();
  });
});
