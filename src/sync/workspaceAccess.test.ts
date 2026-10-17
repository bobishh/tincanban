import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { createWorkspaceDoc } from "../test/boardFixture"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { decideAccess, inheritLocalMoveAccess } from "./workspaceAccess"

const decision = vi.hoisted(() => vi.fn<(input?: unknown) => string>(() => "editor"))
const stages = vi.hoisted(() => [] as string[])
vi.mock("./startupDiagnostics", () => ({ diagnoseStartupStep: async (stage: string, step: () => unknown) => {
  stages.push(`${stage}:started`)
  const result = await step()
  stages.push(`${stage}:completed`)
  return result
} }))
vi.mock("@meta-uber/mesh-replication/runtime", () => ({ meshRustRuntime: () => ({ state: { decideWorkspaceAccess: decision } }) }))
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("Given admitted access inherited by a trusted local move, When ten minutes pass with identical signed authority, Then local access stays cached without serializing or checking historical data again", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000)
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access after idle", "owner", "blank"))
  const evidence = { snapshot: { ownerPersonId: "owner" } }
  decision.mockReturnValue("editor")
  await decideAccess(doc, evidence)
  const moved = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Trusted local move" })
  inheritLocalMoveAccess(doc, moved)
  const calls = decision.mock.calls.length
  stages.length = 0
  clock.mockReturnValue(700_000)
  await expect(decideAccess(moved, evidence)).resolves.toBe("editor")
  expect(decision).toHaveBeenCalledTimes(calls)
  expect(stages).toEqual([])
})

it("Given an automation grant valid for one more millisecond, When its exact expiry arrives, Then access revalidates immediately and expired visitor access remains cached", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100)
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Automation expiry", "owner", "blank"))
  const evidence = { snapshot: {}, grant: { payload: { automation: { expiresAt: 101 } } } }
  decision.mockReturnValue("automation")
  await decideAccess(doc, evidence)
  const calls = decision.mock.calls.length
  clock.mockReturnValue(101)
  decision.mockReturnValue("visitor")
  await expect(decideAccess(doc, evidence)).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
  clock.mockReturnValue(700_000)
  await expect(decideAccess(doc, evidence)).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})

it("Given previously checked access, When the system clock moves before its validation time, Then the time-sensitive policy must run again", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100)
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Clock rollback", "owner", "blank"))
  const evidence = { snapshot: {} }
  await decideAccess(doc, evidence)
  const calls = decision.mock.calls.length
  clock.mockReturnValue(99)
  await decideAccess(doc, evidence)
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})

it("Given an automation response crossing its deadline, When asynchronous validation finishes, Then expired automation is returned as visitor immediately", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100)
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Delayed automation result", "owner", "blank"))
  decision.mockImplementationOnce(() => { clock.mockReturnValue(101); return "automation" })
  await expect(decideAccess(doc, { snapshot: {}, grant: { payload: { automation: { expiresAt: 101 } } } })).resolves.toBe("visitor")
})

it("Given an in-flight check inherited before a trusted move, When that check fails, Then the new document can check again instead of retaining a rejected promise", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Failed access recovery", "owner", "blank"))
  const evidence = { snapshot: {} }
  decision.mockImplementationOnce(() => { throw new Error("Policy unavailable") })
  const first = decideAccess(doc, evidence)
  const failed = expect(first).rejects.toThrow("Policy unavailable")
  const moved = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Moved" })
  inheritLocalMoveAccess(doc, moved)
  await failed
  decision.mockReturnValue("editor")
  await expect(decideAccess(moved, evidence)).resolves.toBe("editor")
})

it("Given a caller-owned authority object, When its grant changes after validation starts, Then the verified result and cache remain bound to the original private input", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Input ownership", "owner", "blank"))
  const evidence = { snapshot: {}, grant: { payload: { role: "visitor" } } }
  decision.mockImplementationOnce(input => (input as { grant: { payload: { role: string } } }).grant.payload.role)
  const checking = decideAccess(doc, evidence)
  evidence.grant.payload.role = "editor"
  await expect(checking).resolves.toBe("visitor")
  await expect(decideAccess(doc, { snapshot: {}, grant: { payload: { role: "visitor" } } })).resolves.toBe("visitor")
})

it("Given uncached access, When checking permissions, Then checkpoints precede document serialization and policy execution", async () => {
  stages.length = 0
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  decision.mockImplementationOnce(() => {
    expect(stages).toEqual(["access-serialize:started", "access-serialize:completed", "access-policy:started"])
    return "editor"
  })
  await expect(decideAccess(doc, { snapshot: {} })).resolves.toBe("editor")
  expect(stages.at(-1)).toBe("access-policy:completed")
  Automerge.free(doc)
})

it("revalidates revoked authority after a trusted move instead of retaining cached editor rights", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  const evidence = { snapshot: { ownerPersonId: "owner" }, revocations: [] as string[] }
  decision.mockReturnValue("editor")
  await expect(decideAccess(doc, evidence)).resolves.toBe("editor")
  const moved = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Trusted local move fixture" })
  inheritLocalMoveAccess(doc, moved)
  const calls = decision.mock.calls.length
  await expect(decideAccess(moved, evidence)).resolves.toBe("editor")
  expect(decision).toHaveBeenCalledTimes(calls)
  decision.mockReturnValue("visitor")
  await expect(decideAccess(moved, { ...evidence, revocations: ["revoked device"] })).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})

it("Given cached access after a trusted local move, When certificate sets reorder, Then access stays cached and changed certificates still revalidate", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Certificate sets", "owner", "blank"))
  const certificates = [{ signature: "a" }, { signature: "b" }]
  const evidence = { snapshot: { genesisOwner: { certificates } }, identity: { certificates } }
  decision.mockReturnValue("editor")
  await decideAccess(doc, evidence)
  const moved = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Trusted move" })
  inheritLocalMoveAccess(doc, moved)
  const calls = decision.mock.calls.length
  const reordered = { snapshot: { genesisOwner: { certificates: [...certificates].reverse() } }, identity: { certificates: [...certificates].reverse() } }
  await expect(decideAccess(moved, reordered)).resolves.toBe("editor")
  expect(decision).toHaveBeenCalledTimes(calls)
  decision.mockReturnValue("visitor")
  await expect(decideAccess(moved, { ...reordered, identity: { certificates: [{ signature: "other" }] } })).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})

it("revalidates an unrelated document change even with identical authority", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  const evidence = { snapshot: { ownerPersonId: "owner" } }
  await decideAccess(doc, evidence)
  const calls = decision.mock.calls.length
  const changed = Automerge.change(Automerge.clone(doc), draft => { draft.ownerPersonId = "untrusted owner" })
  decision.mockReturnValue("visitor")
  await expect(decideAccess(changed, evidence)).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})

it("Given browser access validation, When sending a saved document, Then ownership transfers without cloning a number array", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  const expected = Automerge.save(doc)
  const messages: unknown[] = []
  class AccessWorker {
    onmessage?: (event: { data: { id: number; role: string } | { type: "ready" } }) => void
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } })) }
    postMessage(request: { id: number; input: { snapshot: { document: Uint8Array } } }, transfer: Transferable[]) {
      const document = request.input.snapshot.document
      expect(document).toBeInstanceOf(Uint8Array)
      expect(transfer).toEqual([document.buffer])
      const received = structuredClone(request, { transfer })
      expect(document.byteLength).toBe(0)
      expect(received.input.snapshot.document).toEqual(expected)
      messages.push(received)
      queueMicrotask(() => this.onmessage?.({ data: { id: received.id, role: "owner" } }))
    }
    terminate() {}
  }
  vi.stubGlobal("window", { addEventListener: vi.fn() })
  vi.stubGlobal("Worker", AccessWorker)
  await expect(decideAccess(doc, { snapshot: {} })).resolves.toBe("owner")
  expect(messages).toHaveLength(1)
  Automerge.free(doc)
})
