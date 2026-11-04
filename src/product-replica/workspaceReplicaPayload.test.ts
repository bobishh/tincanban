import { readFile } from "node:fs/promises"
import { beforeAll, expect, test, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { decodeBlindBytes, encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { encodeWorkspaceDocumentChanges, readWorkspaceReplicaSnapshot, type WorkspaceReplicaSnapshot } from "./workspaceReplicaPayload"

beforeAll(async () => { await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")) })
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function fixture() {
  const before = Automerge.from({ title: "Initial", notes: "" })
  const document = encodeBlindBytes(Automerge.save(before))
  const after = Automerge.change(before, draft => { draft.title = "Updated" })
  const snapshot: WorkspaceReplicaSnapshot = { version: 1, workspaceId: "board", document,
    authorization: { version: 1, records: ["initial proof"], authority: { epoch: 1 } }, chat: null }
  const updated: WorkspaceReplicaSnapshot = { ...snapshot, document: encodeBlindBytes(Automerge.save(after)),
    authorization: { version: 1, records: ["initial proof", "edit proof"], authority: { epoch: 1 } } }
  return { before, after, snapshot, updated, close: () => Automerge.free(after) }
}

test("Given a document delta and a concurrent local edit, when replayed twice, then preserve both edits without duplicating changes", async () => {
  const f = fixture()
  let local = Automerge.load<{ title: string; notes: string }>(decodeBlindBytes(f.snapshot.document))
  try {
    local = Automerge.change(local, draft => { draft.notes = "Concurrent local note" })
    let bytes = Automerge.save(local)
    const delta = encodeWorkspaceDocumentChanges(f.snapshot, f.updated)!
    for (let pass = 0; pass < 2; pass++) {
      const snapshot = await readWorkspaceReplicaSnapshot(delta, "board", async () => bytes)
      const current = Automerge.load(bytes), incoming = Automerge.load<{ notes: string }>(decodeBlindBytes(snapshot.document))
      try {
        expect(incoming.notes).toBe("")
        bytes = Automerge.save(Automerge.merge(current, incoming))
      } finally { Automerge.free(current); Automerge.free(incoming) }
      expect(snapshot.authorization).toEqual(f.updated.authorization)
    }
    const merged = Automerge.load<{ title: string; notes: string }>(bytes)
    try {
      expect(merged.title).toBe("Updated")
      expect(merged.notes).toBe("Concurrent local note")
      expect(Automerge.getAllChanges(merged)).toHaveLength(3)
    } finally { Automerge.free(merged) }
  } finally { Automerge.free(local); f.close() }
})

test.each(["policy", "chat", "attachments", "history", "unrelated document"] as const)(
  "Given a %s change, when preparing replica delivery, then retain a full snapshot", field => {
    const f = fixture()
    let unrelated: ReturnType<typeof Automerge.from> | undefined
    try {
      const next = { ...f.updated }
      if (field === "policy") next.authorization = { version: 1, records: [], authority: { epoch: 2 } }
      if (field === "chat") next.chat = { messages: ["new message"] }
      if (field === "attachments") next.attachments = []
      if (field === "history") next.history = { signed: "baseline" }
      if (field === "unrelated document") { unrelated = Automerge.from({ title: "Unrelated" }); next.document = encodeBlindBytes(Automerge.save(unrelated)) }
      expect(encodeWorkspaceDocumentChanges(f.snapshot, next)).toBeUndefined()
    } finally { if (unrelated) Automerge.free(unrelated); f.close() }
  })

test.each([null, [], { version: 1, kind: "document-changes", changes: ["change"] },
  { version: 3, kind: "document-changes", changes: [] }, { version: 3, kind: "document-changes", changes: [1] },
  { version: 3, kind: "document-changes", changes: ["change"], history: {} },
  { version: 3, kind: "document-changes", changes: ["change"], document: "ambiguous" },
  { version: 1, kind: "future", document: "unknown format" }, { version: 2, document: "missing history" }])(
  "Given a malformed replica payload %j, when decoded, then reject before reading local history", async value => {
    const read = vi.fn<() => Promise<Uint8Array>>()
    const payload = value && !Array.isArray(value) ? { workspaceId: "board", authorization: { signed: true }, chat: null, ...value } : value
    await expect(readWorkspaceReplicaSnapshot(encoded(payload), "board", read)).rejects.toThrow(/snapshot/)
    expect(read).not.toHaveBeenCalled()
  })

test("Given an existing full snapshot, when decoded, then preserve it without requiring a local document", async () => {
  const f = fixture(), read = vi.fn<() => Promise<Uint8Array>>()
  try {
    expect(await readWorkspaceReplicaSnapshot(encoded(f.snapshot), "board", read)).toEqual(f.snapshot)
    expect(read).not.toHaveBeenCalled()
  } finally { f.close() }
})

test.each(["unavailable head", "head before supplied changes"] as const)(
  "Given a delta with an %s, when decoded, then reject instead of acknowledging an incomplete sender state", async scenario => {
    const f = fixture()
    const base = Automerge.load(decodeBlindBytes(f.snapshot.document))
    try {
      const payload = JSON.parse(new TextDecoder().decode(encodeWorkspaceDocumentChanges(f.snapshot, f.updated)!)) as { heads: string[] }
      payload.heads = scenario === "unavailable head" ? ["f".repeat(64)] : Automerge.getHeads(base)
      await expect(readWorkspaceReplicaSnapshot(encoded(payload), "board", async () => decodeBlindBytes(f.snapshot.document)))
        .rejects.toThrow(/dependencies|snapshot/)
    } finally { Automerge.free(base); f.close() }
  })
