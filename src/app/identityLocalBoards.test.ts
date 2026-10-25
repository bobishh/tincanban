import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { createWorkspaceDoc } from "../domain/seeds"
import { forkWorkspaceDocumentV2 } from "../domain/workspaceBundle"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { planIdentityLocalBoards, selectedIdentityLocalBoardIds } from "./identityLocalBoards"

beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
})

function workspace(id: string, ownerPersonId: string, title = "Untitled") {
  return Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(id, title, ownerPersonId, "blank", "2026-10-25T00:00:00.000Z"))
}

it("Given only the untouched local Untitled seed, When planning an Identity switch, Then omit it from the board choice", () => {
  const doc = workspace("guest-default", "guest")
  const plan = planIdentityLocalBoards("guest", [{ doc, role: "owner" }])
  expect(plan).toEqual({ previousPersonId: "guest", discardUntouchedDefaultIds: ["guest-default"], ownedBoards: [] })
})

it("Given an edited local Untitled board and other people's boards, When planning an Identity switch, Then offer only current owner boards", () => {
  const edited = Automerge.change(workspace("guest-edited", "guest"), draft => {
    const board = Object.values(draft.entities).find(entity => "kind" in entity && entity.kind === "board")!
    board.title = "My Untitled board"
  })
  const foreign = workspace("someone-elses", "other", "Shared board")
  const adopted = workspace("guest-current-owner", "prior-owner", "Adopted board")
  const plan = planIdentityLocalBoards("guest", [
    { doc: edited, role: "owner" },
    { doc: adopted, role: "owner" },
    { doc: foreign, role: "visitor" },
    { doc: workspace("not-owned", "guest", "Not owned"), role: "visitor" },
  ])
  expect(plan).toEqual({ previousPersonId: "guest", discardUntouchedDefaultIds: [], ownedBoards: [
    { workspaceId: "guest-edited", title: "Untitled" }, { workspaceId: "guest-current-owner", title: "Adopted board" },
  ] })
})

it("Given an imported Untitled board with user content in one fresh Automerge change, When planning a switch, Then keep it in the ownership choice", () => {
  const source = workspace("source", "guest")
  const column = Object.values(source.entities).find(entity => "kind" in entity && entity.kind === "column")!
  const withItem = Automerge.change(source, draft => {
    draft.entities["user-item"] = {
      id: "user-item", title: "Keep this", body: "User content", values: {},
      placement: { parentId: column.id, rank: "0/1" }, archivedAt: null,
      createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
    }
  })
  const imported = forkWorkspaceDocumentV2(withItem, "guest-import", "guest")
  expect(imported.ok).toBe(true)
  if (!imported.ok) return
  expect(Automerge.getAllChanges(imported.value)).toHaveLength(1)
  const plan = planIdentityLocalBoards("guest", [{ doc: imported.value, role: "owner" }])
  expect(plan.ownedBoards).toEqual([{ workspaceId: "guest-import", title: "Untitled" }])
  Automerge.free(imported.value)
})

it("Given an Add choice, When resolving it, Then select only the explicitly chosen locally owned boards", () => {
  const plan = { previousPersonId: "guest", discardUntouchedDefaultIds: [], ownedBoards: [
    { workspaceId: "guest-a", title: "A" }, { workspaceId: "guest-b", title: "B" },
  ] }
  expect(selectedIdentityLocalBoardIds(plan, { kind: "add", workspaceIds: ["guest-b"] })).toEqual(["guest-b"])
})

it("Given a stale choice for a board absent from the plan, When resolving Add, Then reject it", () => {
  const plan = { previousPersonId: "guest", discardUntouchedDefaultIds: [], ownedBoards: [{ workspaceId: "guest-a", title: "A" }] }
  expect(() => selectedIdentityLocalBoardIds(plan, { kind: "add", workspaceIds: ["foreign-board"] }))
    .toThrow(/not in the local ownership choice/i)
})

it("Given the user chooses Stay on my boards, When resolving the choice, Then select no boards", () => {
  const plan = { previousPersonId: "guest", discardUntouchedDefaultIds: ["guest-default"], ownedBoards: [] }
  expect(selectedIdentityLocalBoardIds(plan, { kind: "stay" })).toEqual([])
})
