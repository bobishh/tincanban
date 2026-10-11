import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { computeWorkspaceAdmission, computeWorkspaceDocumentAdmission, indexOperationParents, touchedPathsForChange, indexAdmissionOperations } from "./workspaceAdmissionCore"

vi.mock("@automerge/automerge/slim", async importOriginal => {
  const original = await importOriginal<typeof Automerge>()
  return { ...original, decodeChange: vi.fn(original.decodeChange) }
})

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm("/automerge.wasm")
})

describe("workspace admission operation paths", () => {
  it("Given long text history, When indexing admission, Then retain distinct object targets instead of character operations and preserve exact paths", () => {
    let doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("compact-index", "Board", "owner", "blank"))
    doc = Automerge.change(doc, draft => { draft.title = "x".repeat(10_000) })
    const bytes = Automerge.getAllChanges(doc)
    const decoded = bytes.map(change => Automerge.decodeChange(change))
    const expectedParents = indexOperationParents(decoded)
    const indexed = indexAdmissionOperations(bytes)
    expect(indexed.objectParents).toEqual(expectedParents)
    expect(indexed.operationCount).toBe(decoded.reduce((count, change) => count + change.ops.length, 0))
    for (const change of decoded) {
      const targets = indexed.targetsByHash.get(change.hash)!
      expect(targets.length).toBeLessThanOrEqual(change.ops.length)
      expect(targets.every(target => Object.keys(target).every(key => key === "obj" || key === "key"))).toBe(true)
      expect(touchedPathsForChange(targets, indexed.objectParents)).toEqual(touchedPathsForChange(change.ops, expectedParents))
    }
    // Replacing Text touches its root property and its new Text object.
    expect(indexed.targetsByHash.get(decoded.at(-1)!.hash)).toHaveLength(2)
    Automerge.free(doc)
  })
  it("attributes root Text updates and entity edits to exact paths", () => {
    let doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("path-test", "Board", "owner", "job-search"))
    const column = Object.values(doc.entities).find(entity => entity.kind === "column")!
    const profileId = "member-profile:path-test-person"
    doc = Automerge.change(doc, draft => {
      draft.title = "Renamed board"
      draft.entities[column.id]!.title = "Renamed column"
      draft.entities[profileId] = {
        id: profileId, kind: "member_profile", personId: "path-test-person",
        data: JSON.stringify({ avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-01-01T00:00:00.000Z" }),
        title: "Member profile", placement: { parentId: null, rank: "0/1" }, archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }
    })
    const changes = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change))
    const latest = changes.at(-1)!
    const touched = touchedPathsForChange(latest.ops, indexOperationParents(changes))

    expect(touched?.rootKeys).toEqual(new Set(["title"]))
    expect(latest.startOp).toBeGreaterThan(1)
    expect(touched?.entityIds).toEqual(new Set([column.id, profileId]))
  })

  it("uses slow-path for ambiguous root entity-map replacement and unknown object ids", () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("path-fallback", "Board", "owner", "blank"))
    const changes = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change))
    const objectParents = indexOperationParents(changes)
    const rootReplacement = [{ action: "set", obj: "_root", key: "entities", pred: [] }]
    const unknownObject = [{ action: "set", obj: "missing@actor", key: "title", pred: [] }]

    expect(touchedPathsForChange(rootReplacement, objectParents)).toBeUndefined()
    expect(touchedPathsForChange(unknownObject, objectParents)).toBeUndefined()
  })
})


it("Given large authorized text history, When expanded operations exceed available memory, Then admission preserves heads and still rejects a visitor rename", async () => {
  const base = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("bounded-history", "Board", "owner", "blank"))
  const doc = Automerge.change(base, draft => { draft.title = "x".repeat(40_000) })
  const bytes = Automerge.save(doc)
  const changes = Automerge.getChangesMetaSince(doc, [])
  const owner = { personId: "owner", publicKey: "public-key", certificates: [] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  let visitorRename = false
  const policy = {
    authorizationRecordPages: () => [],
    prepareWriteEvidence: () => authority,
    evaluateCausalAdmission: () => ({ decisions: changes.map(change => ({ hash: change.hash,
      status: { type: "admitted", role: visitorRename && Automerge.getHeads(doc).includes(change.hash) ? "visitor" : "owner" } })),
      verifiedAuthorizations: [], authorizedDocument: bytes }),
  }
  const { decodeChange: decodeOriginal } = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  const largeChange = Automerge.getBackend(doc).getChangeByHash(Automerge.getHeads(doc)[0]!)!
  const decode = vi.spyOn(Automerge, "decodeChange").mockImplementation(bytes => {
    if (bytes.length === largeChange.length && bytes.every((byte, index) => byte === largeChange[index])) {
      throw new Error("Expanded operations exceed memory budget")
    }
    return decodeOriginal(bytes)
  })
  try {
    const input = { workspaceId: doc.id, remote: bytes, authorization: { version: 1 as const, records: [], authority }, knownAuthority: null, now: 1 }
    const admitted = computeWorkspaceDocumentAdmission(input, policy as never, doc)
    expect(admitted.authorizedHeads).toEqual(Automerge.getHeads(doc))
    expect(admitted.admittedHashes).toHaveLength(changes.length)
    visitorRename = true
    expect(() => computeWorkspaceAdmission(input, policy as never)).toThrow(/Only owners and editors can rename/)
  } finally { decode.mockRestore(); Automerge.free(doc) }
})
