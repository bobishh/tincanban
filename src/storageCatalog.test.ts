import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "./test/boardFixture"
import { includesWorkspaceHeads } from "./storageCatalog"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, getAllChanges: vi.fn(actual.getAllChanges) }
})
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm("/automerge.wasm")
})

it("checks ancestor and merged branch heads using metadata without expanding text operations", () => {
  const base = Automerge.from(createWorkspaceDoc("catalog-heads", "Long text ".repeat(1000), "owner", "blank"))
  const first = Automerge.change(Automerge.clone(base), draft => { draft.title = "First branch" })
  const second = Automerge.change(Automerge.clone(base), draft => { draft.title = "Second branch" })
  const merged = Automerge.merge(Automerge.clone(first), second)
  const expanded = vi.mocked(Automerge.getAllChanges)
  expanded.mockClear()
  try {
    expect(includesWorkspaceHeads(first, Automerge.getHeads(base))).toBe(true)
    expect(includesWorkspaceHeads(first, Automerge.getHeads(second))).toBe(false)
    expect(includesWorkspaceHeads(merged, Automerge.getHeads(first))).toBe(true)
    expect(includesWorkspaceHeads(merged, Automerge.getHeads(second))).toBe(true)
    expect(expanded.mock.calls.length).toBe(0)
  } finally { for (const doc of [base, first, second, merged]) Automerge.free(doc) }
})
