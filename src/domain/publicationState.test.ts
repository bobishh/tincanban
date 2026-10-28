import { describe, expect, it } from "vitest"
import { reconcilePublicationRecord, type PublicationRecord } from "./publicationState"

const record = (ownerIntent: PublicationRecord["ownerIntent"]): PublicationRecord => ({
  version: 1, origin: "https://rusty.test", workspaceId: "workspace-a", boardId: "board-a", ownerPersonId: "person-a",
  ownerIntent, confirmedRevision: 8, confirmedHash: "saved-hash", remoteAvailability: "published",
})
const pendingUpdate = (): PublicationRecord => ({ ...record("published"),
  intent: { operationId: "pending-update", action: "update", expectedRevision: 8,
    projection: null, projectionHash: "next-hash", sourceHeads: ["head-a"] } })

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

  it("Given a pending update, when authenticated status still has its exact base revision and hash, then release that attempt for a fresh current-source retry", () => {
    const result = reconcilePublicationRecord(pendingUpdate(), { revision: 8, published: true, hash: "saved-hash" })
    expect(result.record?.intent).toBeUndefined()
    expect(result).toMatchObject({ published: true, withdrawn: false, recoveryNeeded: false, revision: 8, hash: "saved-hash" })
  })

  it.each([9, 11])("Given a pending update, when authenticated public status advanced to revision %i with different content, then retire its superseded CAS attempt", revision => {
    const result = reconcilePublicationRecord(pendingUpdate(), { revision, published: true, hash: "another-writer-hash" })
    expect(result.record?.intent).toBeUndefined()
    expect(result.record).toMatchObject({ confirmedRevision: revision, confirmedHash: "another-writer-hash" })
  })

  it("Given a pending update, when its exact next revision and projection are observed, then retain the confirmed operation identity", () => {
    const result = reconcilePublicationRecord(pendingUpdate(), { revision: 9, published: true, hash: "next-hash" })
    expect(result.record?.intent).toMatchObject({ operationId: "pending-update", confirmed: true, confirmedBy: "status" })
  })

  it.each([
    { revision: 7, hash: "saved-hash" },
    { revision: 8, hash: "unexpected-same-revision-hash" },
    { revision: 8 },
  ])("Given an inconsistent public status $revision/$hash, when reconciling repeatedly, then preserve the pending update and its original confirmed base", status => {
    const first = reconcilePublicationRecord(pendingUpdate(), { ...status, published: true })
    const repeated = reconcilePublicationRecord(first.record, { ...status, published: true })
    expect(repeated.record?.intent).toEqual(pendingUpdate().intent)
    expect(repeated.record).toMatchObject({ confirmedRevision: 8, confirmedHash: "saved-hash" })
  })

  it.each([
    { revision: 0, published: false, availability: "missing" as const },
    { revision: 9, published: false, availability: "withdrawn" as const },
    { revision: 8, published: false, availability: "published" as const },
  ])("Given pending update and remote $availability status, when reconciling, then preserve its intent without automatic publication", status => {
    const result = reconcilePublicationRecord(pendingUpdate(), status)
    expect(result.record?.intent).toEqual(pendingUpdate().intent)
    expect(result.published && !result.withdrawn && !result.recoveryNeeded).toBe(false)
  })

  it.each([8, 11])("Given a pending first-publication intent, when another public revision %i is observed, then do not treat it as a retryable update", revision => {
    const pending = pendingUpdate()
    pending.intent!.action = "publish"
    const result = reconcilePublicationRecord(pending, { revision, published: true, hash: "saved-hash" })
    expect(result.record?.intent).toEqual(pending.intent)
  })

  it("Given explicit pending withdrawal, when the old public base is observed, then preserve withdrawal and never resume content delivery", () => {
    const pending = { ...record("withdrawn"), intent: { ...pendingUpdate().intent!, action: "unpublish" as const } }
    const result = reconcilePublicationRecord(pending, { revision: 8, published: true, hash: "saved-hash" })
    expect(result).toMatchObject({ published: false, withdrawn: true, recoveryNeeded: false })
    expect(result.record?.intent).toEqual(pending.intent)
  })
})
