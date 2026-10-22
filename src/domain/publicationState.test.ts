import { describe, expect, it } from "vitest"
import { reconcilePublicationRecord, type PublicationRecord } from "./publicationState"

const record = (ownerIntent: PublicationRecord["ownerIntent"]): PublicationRecord => ({
  version: 1, origin: "https://rusty.test", workspaceId: "workspace-a", boardId: "board-a", ownerPersonId: "person-a",
  ownerIntent, confirmedRevision: 8, confirmedHash: "saved-hash", remoteAvailability: "published",
})

describe("publication ownership state", () => {
  it("keeps published owner intent when the remote copy disappears and requires recovery", () => {
    const result = reconcilePublicationRecord(record("published"), { revision: 0, published: false, availability: "missing" })
    expect(result).toMatchObject({ published: true, withdrawn: false, recoveryNeeded: true, revision: 0, hash: "saved-hash" })
    expect(result.record?.ownerIntent).toBe("published")
  })

  it("keeps a failed first publish private when status proves the remote copy was never created", () => {
    const pending = { ...record("published"), confirmedRevision: 0, confirmedHash: "", remoteAvailability: "missing" as const,
      intent: { operationId: "op-first", action: "publish" as const, expectedRevision: 0, projection: null,
        projectionHash: "pending-hash", sourceHeads: ["head-a"] } }

    const result = reconcilePublicationRecord(pending, { revision: 0, published: false, availability: "missing" })

    expect(result).toMatchObject({ published: false, withdrawn: false, recoveryNeeded: false, revision: 0, hash: "" })
    expect(result.record?.ownerIntent).toBe("published")
    expect(result.record?.intent).toBeUndefined()
  })

  it("does not resurrect a never-confirmed first publish on a later missing status", () => {
    const pending = { ...record("published"), confirmedRevision: 0, confirmedHash: "", remoteAvailability: "missing" as const,
      intent: { operationId: "op-first", action: "publish" as const, expectedRevision: 0, projection: null,
        projectionHash: "pending-hash", sourceHeads: ["head-a"] } }

    const first = reconcilePublicationRecord(pending, { revision: 0, published: false, availability: "missing" })
    const second = reconcilePublicationRecord(first.record, { revision: 0, published: false, availability: "missing" })

    expect(second).toMatchObject({ published: false, withdrawn: false, recoveryNeeded: false, revision: 0, hash: "" })
    expect(second.record?.ownerIntent).toBe("published")
    expect(second.record?.intent).toBeUndefined()
  })

  it("records a remote tombstone without rewriting owner intent or reviving a later missing copy", () => {
    const observed = reconcilePublicationRecord(record("published"), { revision: 9, published: false, availability: "withdrawn" })
    expect(observed).toMatchObject({ published: false, withdrawn: true, recoveryNeeded: false })
    expect(observed.record?.ownerIntent).toBe("published")

    const missing = reconcilePublicationRecord(observed.record, { revision: 0, published: false, availability: "missing" })
    expect(missing).toMatchObject({ published: false, withdrawn: true, recoveryNeeded: false })
    expect(missing.record?.ownerIntent).toBe("published")
  })

  it("keeps explicit owner withdrawal across missing remote status", () => {
    const result = reconcilePublicationRecord(record("withdrawn"), { revision: 0, published: false, availability: "missing" })
    expect(result).toMatchObject({ published: false, withdrawn: true, recoveryNeeded: false })
    expect(result.record?.ownerIntent).toBe("withdrawn")
  })

  it("resolves a lost publish response from the matching authenticated revision and hash", () => {
    const pending = { ...record("published"), intent: { operationId: "op-1", action: "publish" as const, expectedRevision: 8,
      projection: null, projectionHash: "published-hash", sourceHeads: [], preparedAssetManifest: [{ sha256: "file-hash", byteLength: 3 }] } }
    const result = reconcilePublicationRecord(pending, { revision: 9, published: true, availability: "published", hash: "published-hash" })
    expect(result.record?.intent).toMatchObject({ operationId: "op-1", confirmed: true, confirmedBy: "status" })
    expect(result.record?.receipt).toBeUndefined()
  })
})
