import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "./test/boardFixture"
import { createWorkspaceViewReader, workspaceEntitiesAtHeads } from "./crdtHistory"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm("/automerge.wasm")
})

it("matches full historical views across branches, conflicts, deletion and entity-map replacement", () => {
  const initial = Automerge.from(createWorkspaceDoc("historical-entities", "Board", "owner", "blank"))
  const column = Object.values(initial.entities).find(entity => entity.kind === "column")!
  const first = Automerge.change(Automerge.clone(initial), draft => { draft.entities[column.id]!.title = "First branch" })
  const second = Automerge.change(Automerge.clone(initial), draft => { draft.entities[column.id]!.title = "Second branch" })
  const merged = Automerge.merge(Automerge.clone(first), second)
  const deleted = Automerge.change(Automerge.clone(merged), draft => { delete draft.entities[column.id] })
  const replaced = Automerge.change(Automerge.clone(deleted), draft => { draft.entities = {} })
  try {
    for (const heads of [[], ...[initial, first, second, merged, deleted, replaced].map(Automerge.getHeads)]) {
      const full = Automerge.view(replaced, heads).entities ?? {}
      const scoped = workspaceEntitiesAtHeads(replaced, heads)
      expect(Object.keys(scoped).sort()).toEqual(Object.keys(full).sort())
      for (const id of [...Object.keys(full), column.id, "missing"]) expect(scoped[id]).toEqual(full[id])
    }
  } finally { for (const doc of [initial, first, second, merged, deleted, replaced]) Automerge.free(doc) }
})

it("reads entity keys containing slashes as keys rather than materialization paths", () => {
  let doc = Automerge.from(createWorkspaceDoc("entity-key", "Board", "owner", "blank"))
  const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
  const copy = JSON.parse(JSON.stringify(column)) as typeof column
  doc = Automerge.change(doc, draft => { draft.entities["entity/with/slashes"] = { ...copy, id: "entity/with/slashes" } })
  try {
    expect(workspaceEntitiesAtHeads(doc, Automerge.getHeads(doc))["entity/with/slashes"]).toEqual(doc.entities["entity/with/slashes"])
  } finally { Automerge.free(doc) }
})

it("materializes repeated preview heads once per document reader", () => {
  const doc = Automerge.from(createWorkspaceDoc("preview-cache", "Board", "owner", "blank"))
  try {
    const read = createWorkspaceViewReader(doc)
    const heads = Automerge.getHeads(doc)
    expect(read([...heads])).toBe(read(heads))
    expect(read([]).entities).toBeUndefined()
    expect(createWorkspaceViewReader(doc)(heads)).not.toBe(read(heads))
  } finally { Automerge.free(doc) }
})
