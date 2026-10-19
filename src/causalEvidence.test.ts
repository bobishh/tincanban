import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { StoredChange } from "./storageJournal"
import { replayAdmittedJournal } from "./causalEvidence"

vi.mock("@automerge/automerge/slim", async importOriginal => {
  const actual = await importOriginal<typeof Automerge>()
  return {
    ...actual,
    applyChanges: vi.fn(actual.applyChanges),
    stats: vi.fn(actual.stats),
  }
})

const realApplyChanges = vi.mocked(Automerge.applyChanges).getMockImplementation()!
const realStats = vi.mocked(Automerge.stats).getMockImplementation()!

beforeAll(async () => Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")))
beforeEach(() => {
  vi.mocked(Automerge.applyChanges).mockReset().mockImplementation(realApplyChanges)
  vi.mocked(Automerge.stats).mockReset().mockImplementation(realStats)
})
afterAll(() => vi.clearAllMocks())

function storedChange(changeHash: string, bytes: Uint8Array): StoredChange {
  return { workspaceId: "workspace", changeHash, bytes, addedAt: "2026-10-19T00:00:00.000Z" }
}

function asWorkspaceDocument(doc: Automerge.Doc<{ count: number }>): Automerge.Doc<WorkspaceDocumentV2> {
  return doc as unknown as Automerge.Doc<WorkspaceDocumentV2>
}

it("Given malformed bytes beside an independent valid change, When replay falls back per change, Then it keeps the valid change and the real WASM engine remains usable", () => {
  const base = Automerge.from({ count: 0 })
  const updated = Automerge.change(Automerge.clone(base), draft => { draft.count = 1 })
  const validBytes = Automerge.getLastLocalChange(updated)!
  const validHash = Automerge.decodeChange(validBytes).hash

  const replayed = replayAdmittedJournal(asWorkspaceDocument(base), [
    storedChange("a".repeat(64), new Uint8Array([1, 2, 3])),
    storedChange(validHash, validBytes),
  ]) as unknown as Automerge.Doc<{ count: number }>

  expect(replayed.count).toBe(1)
  expect(Automerge.getHeads(replayed)).toEqual(Automerge.getHeads(updated))
})

it("Given a change whose dependency is absent, When replay buffers it and the dependency later arrives, Then both changes apply and WASM remains usable", () => {
  const source = Automerge.from({ count: 0 })
  const dependencyBytes = Automerge.getLastLocalChange(source)!
  const dependent = Automerge.change(source, draft => { draft.count = 1 })
  const dependentBytes = Automerge.getLastLocalChange(dependent)!
  const target = Automerge.from({ count: 0 })

  const buffered = replayAdmittedJournal(asWorkspaceDocument(target), [
    storedChange(Automerge.decodeChange(dependentBytes).hash, dependentBytes),
  ]) as unknown as Automerge.Doc<{ count: number }>
  expect(Automerge.getHeads(buffered)).toBeDefined()

  const completed = Automerge.applyChanges(buffered, [dependencyBytes])[0]
  expect(completed.count).toBe(1)
  expect(Automerge.hasHeads(completed, Automerge.getHeads(dependent))).toBe(true)
})

it("Given a fatal batch failure followed by a poisoned-engine probe, When replay catches the batch, Then it rethrows the first failure without retrying each change", () => {
  const firstFailure = new Error("synthetic fatal WASM failure")
  const secondaryFailure = new Error("Module terminated")
  const doc = asWorkspaceDocument(Automerge.from({ count: 0 }))
  const apply = vi.mocked(Automerge.applyChanges).mockReset().mockImplementation(() => { throw firstFailure })
  vi.mocked(Automerge.stats).mockReset().mockImplementation(() => { throw secondaryFailure })

  let thrown: unknown
  try { replayAdmittedJournal(doc, [
    storedChange("1".repeat(64), new Uint8Array([1])),
    storedChange("2".repeat(64), new Uint8Array([2])),
  ]) } catch (error) { thrown = error }
  expect(thrown).toBe(firstFailure)
  expect(apply).toHaveBeenCalledTimes(1)
})

it("Given an ordinary batch error then a fatal per-change failure, When the engine probe fails, Then replay preserves the fatal failure and stops retries", () => {
  const batchFailure = new Error("synthetic ordinary batch rejection")
  const firstFatalFailure = new Error("synthetic fatal WASM failure")
  const secondaryFailure = new Error("Module terminated")
  const doc = asWorkspaceDocument(Automerge.from({ count: 0 }))
  const apply = vi.mocked(Automerge.applyChanges).mockReset()
    .mockImplementationOnce(() => { throw batchFailure })
    .mockImplementationOnce(() => { throw firstFatalFailure })
  vi.mocked(Automerge.stats).mockReset()
    .mockImplementationOnce(realStats)
    .mockImplementationOnce(() => { throw secondaryFailure })

  let thrown: unknown
  try { replayAdmittedJournal(doc, [
    storedChange("1".repeat(64), new Uint8Array([1])),
    storedChange("2".repeat(64), new Uint8Array([2])),
  ]) } catch (error) { thrown = error }
  expect(thrown).toBe(firstFatalFailure)
  expect(apply).toHaveBeenCalledTimes(2)
})
