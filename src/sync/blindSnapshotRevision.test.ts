import { beforeEach, expect, test, vi } from "vitest"
import { createBlindSnapshotRevision } from "./blindSnapshotRevision"

const state = vi.hoisted(() => ({ revision: "saved-1" as string | undefined, authority: "authority-1",
  chatRevision: "generation-1:0", historicalReads: 0,
  chat: { version: 1, messages: [] as unknown[], profiles: [] as unknown[], typing: [] as unknown[] },
  duringChat: undefined as (() => void) | undefined }))
vi.mock("../storage", () => ({ defaultStorage: { readWorkspaceRevision: async () => state.revision } }))
vi.mock("../chat/service", () => ({
  exportChat: async () => { state.historicalReads++; state.duringChat?.(); return state.chat },
  readChatContentRevision: async () => { const revision = state.chatRevision; state.duringChat?.(); return revision },
}))
vi.mock("./changeAuthorization", () => ({ localWorkspaceAdmissionAuthority: async () => ({ fingerprint: state.authority }) }))

beforeEach(() => {
  state.revision = "saved-1"; state.authority = "authority-1"
  state.chat = { version: 1, messages: [], profiles: [], typing: [] }
  state.duringChat = undefined
  state.chatRevision = "generation-1:0"; state.historicalReads = 0
})

function fixture() {
  const app = { readWorkspaceDoc: vi.fn().mockResolvedValue({ id: "board", ownerPersonId: "owner" }), getCurrentProfile: () => null }
  return { app, read: createBlindSnapshotRevision(app) }
}

test("Given unchanged durable evidence, When polling repeats, Then root metadata is read once and typing cannot force historical snapshot work", async () => {
  const f = fixture(), first = await f.read("board")
  expect(first).toBeTruthy()
  state.chat.typing = ["ephemeral typing"]
  expect(await f.read("board")).toBe(first)
  expect(f.app.readWorkspaceDoc).toHaveBeenCalledOnce()
  expect(state.historicalReads).toBe(0)
})

test.each(["document-or-proofs", "authority", "message", "profile"])("Given changed %s, When polling repeats, Then snapshot revision changes", async change => {
  const f = fixture(), before = await f.read("board")
  if (change === "document-or-proofs") state.revision = "saved-2"
  if (change === "authority") state.authority = "authority-2"
  if (change === "message") state.chat.messages = ["new message"]
  if (change === "profile") state.chat.profiles = ["renamed profile"]
  if (change === "message" || change === "profile") state.chatRevision = "generation-1:1"
  expect(await f.read("board")).not.toBe(before)
})

test.each(["revision", "authority", "chat-content"])("Given %s changes during the read, When binding a snapshot revision, Then reuse is unavailable", async change => {
  const f = fixture()
  state.duringChat = () => {
    if (change === "revision") state.revision = "saved-2"
    else if (change === "authority") state.authority = "authority-2"
    else state.chatRevision = "generation-1:1"
  }
  expect(await f.read("board")).toBeUndefined()
})

test("Given an old journal without a revision, When polling, Then revision reuse is disabled without loading historical document metadata", async () => {
  state.revision = undefined
  const f = fixture()
  expect(await f.read("board")).toBeUndefined()
  expect(f.app.readWorkspaceDoc).not.toHaveBeenCalled()
})
