import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
const f = vi.hoisted(() => ({ identityPull: vi.fn(), workspacePull: vi.fn(), roots: vi.fn(),
  identityConfigs: vi.fn(), workspaceConfigs: vi.fn(), refreshCatalog: vi.fn() }))
vi.mock("../sync/identityReplicaStore", () => ({ createIdentityReplica: () => ({ pull: f.identityPull }) }))
vi.mock("../sync/blindReplicaStore", () => ({ createBlindReplica: () => ({ pull: f.workspacePull }) }))
vi.mock("../sync/privateReplicaRepository", () => ({ getIdentityReplicaConfigurations: f.identityConfigs, getReplicaConfigurations: f.workspaceConfigs }))
vi.mock("../storage", () => ({ defaultStorage: { loadPersonalRoot: f.roots } }))
vi.mock("../statePersistence", () => ({ refreshAvailableWorkspaces: f.refreshCatalog }))
vi.mock("./connectAdoptedIdentityBoards", () => ({ connectAdoptedIdentityBoards: vi.fn() }))
vi.mock("../domain/identity", () => ({ isCurrentIdentityProfile: () => true }))
import { loadIdentityBoards } from "./loadIdentityBoards"

beforeEach(() => {
  vi.clearAllMocks()
  f.identityConfigs.mockResolvedValue([{ purpose: "identity", personId: "bo", origin: "https://rusty.example", scopeId: "catalog" }])
  f.workspaceConfigs.mockResolvedValue([{ workspaceId: "job-search", origin: "https://rusty.example", scopeId: "board" }])
  f.roots.mockResolvedValue({ identity: { personId: "bo" }, workspaces: { "job-search": { workspaceId: "job-search", forgotten: false } } })
  f.identityPull.mockResolvedValue(true)
  f.workspacePull.mockResolvedValue(true)
})
function app() {
  return { getCurrentProfile: () => ({ identity: { personId: "bo" } }), refreshIdentity: vi.fn(),
    activeWorkspace: { id: "guest-default" }, availableWorkspaces: { value: [{ id: "job-search" }] },
    readWorkspaceDoc: vi.fn(async (id: string) => ({ id, entities: { board: { id: `board-${id}`, kind: "board" } } })),
    switchWorkspace: vi.fn(), createWorkspaceAsync: vi.fn() }
}
it("Given an owned catalog on Rusty and only the guest default active, when sign-in loads boards, then activate the existing board after both pulls", async () => {
  const state = app()
  await loadIdentityBoards(state as never)
  expect(f.identityPull).toHaveBeenCalledOnce()
  expect(f.workspacePull).toHaveBeenCalledOnce()
  expect(state.switchWorkspace).toHaveBeenCalledWith("job-search")
  expect(state.createWorkspaceAsync).not.toHaveBeenCalled()
})
it("Given catalog lookup fails, when sign-in loads boards, then expose failure without creating another Untitled", async () => {
  const state = app()
  f.identityPull.mockRejectedValueOnce(new Error("Rusty is unreachable"))
  await expect(loadIdentityBoards(state as never)).rejects.toThrow("Rusty is unreachable")
  expect(state.createWorkspaceAsync).not.toHaveBeenCalled()
  expect(state.switchWorkspace).not.toHaveBeenCalled()
})

it("Given two available boards and a deep link to the inactive one, when sign-in loads boards, then activate that exact board", async () => {
  const state = app()
  state.activeWorkspace.id = "workspace-a"
  state.availableWorkspaces.value = [{ id: "workspace-a" }, { id: "workspace-b" }]
  f.roots.mockResolvedValue({ identity: { personId: "bo" }, workspaces: {
    "workspace-a": { workspaceId: "workspace-a", forgotten: false },
    "workspace-b": { workspaceId: "workspace-b", forgotten: false },
  } })
  f.workspaceConfigs.mockResolvedValue([
    { workspaceId: "workspace-a", origin: "https://rusty.example", scopeId: "board-a" },
    { workspaceId: "workspace-b", origin: "https://rusty.example", scopeId: "board-b" },
  ])

  await loadIdentityBoards(state as never, "/boards/board-workspace-b/card?filter=open#item-7")

  expect(state.switchWorkspace).toHaveBeenCalledWith("workspace-b")
  expect(f.workspacePull).toHaveBeenCalledTimes(2)
})

it("Given an old route for a board absent from the approved catalog, when sign-in loads boards, then keep the available board", async () => {
  const state = app()
  state.activeWorkspace.id = "workspace-a"
  state.availableWorkspaces.value = [{ id: "workspace-a" }]

  await loadIdentityBoards(state as never, "/boards/guest-private-board")

  expect(state.switchWorkspace).not.toHaveBeenCalled()
})


beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
})

it("Given an untouched default active after an interrupted login and an existing saved board, when sign-in resumes at the default route, then open the saved board without deleting either document", async () => {
  const state = app()
  const empty = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("guest-default", "Untitled", "bo", "blank"))
  const saved = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("job-search", "Saved board", "bo", "blank"))
  const defaultBoard = Object.values(empty.entities).find(entity => entity.kind === "board")!
  state.availableWorkspaces.value = [{ id: "guest-default" }, { id: "job-search" }]
  state.readWorkspaceDoc.mockImplementation(async id => (id === "guest-default" ? empty : saved) as never)
  try {
    await loadIdentityBoards(state as never, `/boards/${defaultBoard.id}`)
    expect(state.switchWorkspace).toHaveBeenCalledWith("job-search")
    expect(state.createWorkspaceAsync).not.toHaveBeenCalled()
    expect(Object.values(empty.entities).some(entity => entity.id === defaultBoard.id)).toBe(true)
  } finally { Automerge.free(empty); Automerge.free(saved) }
})

it("Given an edited Untitled active beside a saved board, when sign-in resumes, then retain that edited board", async () => {
  const state = app()
  const seed = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("guest-default", "Untitled", "bo", "blank"))
  const edited = Automerge.change(seed, draft => {
    Object.values(draft.entities).find(entity => entity.kind === "board")!.title = "Edited board"
  })
  const saved = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("job-search", "Saved board", "bo", "blank"))
  state.availableWorkspaces.value = [{ id: "guest-default" }, { id: "job-search" }]
  state.readWorkspaceDoc.mockImplementation(async id => (id === "guest-default" ? edited : saved) as never)
  try {
    await loadIdentityBoards(state as never)
    expect(state.switchWorkspace).not.toHaveBeenCalled()
  } finally { Automerge.free(edited); Automerge.free(saved) }
})

it("Given sign-in added only a member profile to the empty starter, when a saved board is restored, then select the saved board", async () => {
  const state = app()
  const seed = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("guest-default", "Untitled", "bo", "blank"))
  const empty = Automerge.change(seed, draft => {
    draft.entities["member-profile:bo"] = { id: "member-profile:bo", kind: "member_profile", personId: "bo",
      data: JSON.stringify({ avatarData: null, changedAt: "2026-10-26T11:00:00.000Z" }), title: "Member profile",
      placement: { parentId: null, rank: "0/1" }, archivedAt: null,
      createdAt: "2026-10-26T11:00:00.000Z", updatedAt: "2026-10-26T11:00:00.000Z" }
  })
  const saved = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("job-search", "Saved board", "bo", "blank"))
  state.availableWorkspaces.value = [{ id: "guest-default" }, { id: "job-search" }]
  state.readWorkspaceDoc.mockImplementation(async id => (id === "guest-default" ? empty : saved) as never)
  try {
    await loadIdentityBoards(state as never)
    expect(state.switchWorkspace).toHaveBeenCalledWith("job-search")
    expect(state.createWorkspaceAsync).not.toHaveBeenCalled()
  } finally { Automerge.free(empty); Automerge.free(saved) }
})
