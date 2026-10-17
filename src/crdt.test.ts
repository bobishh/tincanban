import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { initializeAutomerge, mergeWorkspaceDocs, newWorkspaceDoc, saveWorkspaceDoc, loadWorkspaceDoc, updateWorkspaceDoc, workspaceHeads } from "./crdt"
import type { Workspace } from "./types"

const emptyWorkspace: Workspace = { items: [], documents: [], templates: [], artifacts: [] }

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("workspace CRDT", () => {
  it("Given unchanged persisted state, when reconciliation merges it without adopting its result, then the active document remains writable", () => {
    const active = newWorkspaceDoc(emptyWorkspace)
    const persisted = loadWorkspaceDoc(saveWorkspaceDoc(active))
    const merged = mergeWorkspaceDocs(active, persisted)

    expect(workspaceHeads(merged)).toEqual(workspaceHeads(active))
    expect(() => updateWorkspaceDoc(active, emptyWorkspace, "Update lead")).not.toThrow()
  })
})
