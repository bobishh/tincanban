import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { decideAccess, inheritLocalMoveAccess } from "./workspaceAccess"

const decision = vi.hoisted(() => vi.fn(() => "editor"))
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
afterEach(() => { vi.unstubAllGlobals() })

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
