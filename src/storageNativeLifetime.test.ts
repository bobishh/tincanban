import { readFile } from "node:fs/promises"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { WorkspaceStorage } from "./storage"
import * as CausalEvidence from "./causalEvidence"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, init: vi.fn(actual.init), load: vi.fn(actual.load) }
})
vi.mock("./causalEvidence", async () => {
  const actual = await vi.importActual<typeof CausalEvidence>("./causalEvidence")
  return { ...actual, replayAdmittedJournal: vi.fn(actual.replayAdmittedJournal) }
})
beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })
beforeEach(() => { vi.mocked(Automerge.init).mockClear(); vi.mocked(Automerge.load).mockClear() })
function allocatedDocuments() {
  return [...vi.mocked(Automerge.init).mock.results, ...vi.mocked(Automerge.load).mock.results]
    .filter(result => result.type === "return").map(result => result.value)
}
function liveDocuments() {
  return allocatedDocuments().filter(doc => { try { Automerge.stats(doc); return true } catch { return false } })
}
afterEach(() => { for (const doc of liveDocuments()) Automerge.free(doc); vi.restoreAllMocks() })

it("Given an unavailable board, when recovery repeatedly checks its saved copy, then no unreturned native document remains live", async () => {
  const storage = new WorkspaceStorage()
  for (let attempt = 0; attempt < 4; attempt++) await expect(storage.loadWorkspaceDoc(crypto.randomUUID())).resolves.toBeNull()
  expect(liveDocuments()).toHaveLength(0)
})

it("Given a local journal read fails, when loading a board rejects, then release any native document allocated before the read", async () => {
  const storage = new WorkspaceStorage(), failure = new Error("Synthetic local journal read failure")
  vi.spyOn(storage, "listChanges").mockRejectedValueOnce(failure)
  await expect(storage.loadWorkspaceDoc(crypto.randomUUID())).rejects.toBe(failure)
  expect(liveDocuments()).toHaveLength(0)
})

it("Given journal replay fails after native allocation, when no document can be returned, then release it and preserve the replay error", async () => {
  const storage = new WorkspaceStorage(), workspaceId = crypto.randomUUID(), failure = new Error("Synthetic journal replay failure")
  vi.spyOn(storage, "listChanges").mockResolvedValueOnce([{ workspaceId, changeHash: "pending-change", bytes: Uint8Array.of(1), addedAt: new Date().toISOString() }])
  vi.mocked(CausalEvidence.replayAdmittedJournal).mockImplementationOnce(() => { throw failure })
  await expect(storage.loadWorkspaceDoc(workspaceId)).rejects.toBe(failure)
  expect(liveDocuments()).toHaveLength(0)
})
