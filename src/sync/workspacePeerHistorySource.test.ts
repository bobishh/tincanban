import { beforeEach, expect, it, vi } from "vitest"
import type * as IdentityDomain from "../domain/identity"

const mocks = vi.hoisted(() => ({
  ensureHistoryProgress: vi.fn(),
  readActive: vi.fn(),
  readArchiveRecords: vi.fn(),
  exportPrivateReplicaState: vi.fn(),
  peerSources: vi.fn(),
  archiveSources: vi.fn(),
  locatedRead: vi.fn(),
}))

vi.mock("../storage", () => ({ defaultStorage: { ensureHistoryProgress: mocks.ensureHistoryProgress } }))
vi.mock("./receivedHistoryBaselineRepository", () => ({ createReceivedHistoryBaselineRepository: () => ({
  readActive: mocks.readActive, readArchiveRecords: mocks.readArchiveRecords,
}) }))
vi.mock("./privateReplicaRepository", () => ({ exportPrivateReplicaState: mocks.exportPrivateReplicaState }))
vi.mock("./workspacePeerHistoryRecoverySources", () => ({ workspacePeerHistoryRecoverySources: mocks.peerSources }))
vi.mock("./workspaceHistoryRecoverySources", () => ({ workspaceHistoryRecoverySources: mocks.archiveSources }))
vi.mock("@meta-uber/mesh-replication/history-archive-locators", () => ({
  createLocatedArchiveStore: (...args: unknown[]) => ({ read: (...readArgs: unknown[]) => mocks.locatedRead(...args, ...readArgs) }),
}))
vi.mock("../domain/identity", async importOriginal => ({
  ...await importOriginal<typeof IdentityDomain>(),
  isCurrentIdentityProfile: () => true,
}))

import { canonicalizeJson, toBase64Url } from "../domain/identity"
import { createWorkspacePeerHistorySource } from "./workspacePeerHistorySource"

const workspaceId = "board-1"
const baselineId = "A".repeat(43)
const document = new Uint8Array([4, 8, 15, 16, 23, 42])
const objectId = "B".repeat(43)
const profile = { identity: { personId: "person-1" }, device: { deviceId: "device-1" } } as never

function signedJson(epoch = 3, id = baselineId) {
  return new TextEncoder().encode(canonicalizeJson({ payload: {
    workspaceId, baselineId: id, historyEpoch: epoch, documentDigest: "C".repeat(43), locatorRoot: { objectId },
  } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureHistoryProgress.mockResolvedValue({ baselineId })
  mocks.readActive.mockResolvedValue({ workspaceId, baselineId, document, signedJson: signedJson(), state: "active" })
  mocks.readArchiveRecords.mockResolvedValue([])
  mocks.exportPrivateReplicaState.mockResolvedValue({ opaque: "private-local-preference" })
  mocks.peerSources.mockResolvedValue([])
  mocks.archiveSources.mockResolvedValue({ sources: [], download: vi.fn() })
  mocks.locatedRead.mockResolvedValue(new Uint8Array([9, 8, 7]))
})

it("Given a current baseline whose signed parent is retained, When an authorized peer requests that exact older ID, Then serve only its original descriptor and document slices", async () => {
  const olderId = "D".repeat(43), olderDocument = new Uint8Array([1, 3, 3, 7])
  mocks.readArchiveRecords.mockResolvedValue([
    { workspaceId, baselineId, document, signedJson: signedJson(3), state: "active", peerProofs: { version: 1, objects: [] } },
    { workspaceId, baselineId: olderId, document: olderDocument, signedJson: signedJson(2, olderId), state: "archived",
      peerProofs: { version: 1, objects: [] } },
  ])
  const source = createWorkspacePeerHistorySource({ getProfile: () => profile })
  const descriptor = await source.readHistoryBaseline(workspaceId, olderId)
  expect(descriptor).toMatchObject({ baselineId: olderId, signedJson: toBase64Url(signedJson(2, olderId)), documentLength: olderDocument.length })
  await expect(source.readHistoryBaselineDocument({ workspaceId, baselineId: olderId, documentDigest: "C".repeat(43), offset: 1, length: 2 }, "peer-device"))
    .resolves.toEqual(olderDocument.slice(1, 3))
  await expect(source.readHistoryBaseline(workspaceId, "E".repeat(43))).resolves.toBeUndefined()
})

it("Given an exact baseline selector from another workspace, When serving retained descriptors, Then do not expose another workspace row", async () => {
  const olderId = "D".repeat(43)
  mocks.readArchiveRecords.mockResolvedValue([{ workspaceId: "other-board", baselineId: olderId, document,
    signedJson: new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId: "other-board", baselineId: olderId,
      historyEpoch: 2, documentDigest: "C".repeat(43) } })), peerProofs: { version: 1, objects: [] } }])
  const source = createWorkspacePeerHistorySource({ getProfile: () => profile })
  await expect(source.readHistoryBaseline(workspaceId, olderId)).resolves.toBeUndefined()
})

it("Given an active Owner-attested baseline without relay proofs, When an authenticated peer requests its descriptor and bounded document parts, Then serve the signed descriptor and exact slices without hashing or exposing keys", async () => {
  const source = createWorkspacePeerHistorySource({ getProfile: () => profile })

  const descriptor = await source.readHistoryBaseline(workspaceId)
  expect(descriptor).toMatchObject({ version: 1, sourceKind: "authenticated-peer-plaintext", baselineId,
    documentDigest: "C".repeat(43), documentLength: document.length, signedJson: toBase64Url(signedJson()) })
  expect(JSON.stringify(descriptor)).not.toContain("privateKey")
  expect(JSON.stringify(descriptor)).not.toContain("contentKey")
  expect(Object.keys(descriptor!)).not.toContain("document")

  await expect(source.readHistoryBaselineDocument({ workspaceId, baselineId, documentDigest: "C".repeat(43), offset: 2, length: 3 }, "peer-device"))
    .resolves.toEqual(document.slice(2, 5))
  await expect(source.readHistoryBaselineDocument({ workspaceId, baselineId, documentDigest: "C".repeat(43), offset: 5, length: 3 }, "peer-device"))
    .resolves.toBeUndefined()
  await expect(source.readHistoryBaselineDocument({ workspaceId, baselineId, documentDigest: "C".repeat(43), offset: 0, length: 256 * 1024 + 1 }, "peer-device"))
    .resolves.toBeUndefined()
  await expect(source.readHistoryBaselineDocument({ workspaceId, baselineId, documentDigest: "C".repeat(43), offset: 0, length: 1 }))
    .resolves.toBeUndefined()
})

it("Given the same baseline ID but a different workspace or digest, When requesting document bytes, Then return unavailable without serving the source", async () => {
  const source = createWorkspacePeerHistorySource({ getProfile: () => profile })
  await expect(source.readHistoryBaselineDocument({ workspaceId: "other-board", baselineId,
    documentDigest: "C".repeat(43), offset: 0, length: document.length }, "peer-device")).rejects.toThrow(/source changed/i)
  await expect(source.readHistoryBaselineDocument({ workspaceId, baselineId,
    documentDigest: "D".repeat(43), offset: 0, length: document.length }, "peer-device")).resolves.toBeUndefined()
})

it("Given private archive ciphertext, When an authenticated device requests the exact workspace and baseline object, Then return only bounded plaintext and keep archive keys sender-side", async () => {
  const key = new Uint8Array([1, 2, 3, 4])
  const archiveSource = { signedJson: signedJson(), scope: { key }, read: vi.fn() }
  mocks.archiveSources.mockResolvedValue({ sources: [archiveSource], download: vi.fn() })
  mocks.locatedRead.mockResolvedValue(new Uint8Array([9, 8, 7]))
  const source = createWorkspacePeerHistorySource({ getProfile: () => profile })
  const binding = { workspaceId, historyEpoch: 3, indexId: "catalogue", objectKind: "part" as const, partIndex: 0, partCount: 1 }

  await expect(source.readHistoryArchiveObject(workspaceId, baselineId, objectId, binding)).resolves.toBeUndefined()
  expect(mocks.exportPrivateReplicaState).not.toHaveBeenCalled()

  const result = await source.readHistoryArchiveObject(workspaceId, baselineId, objectId, binding, "authenticated-peer-device")
  expect(result).toEqual(new Uint8Array([9, 8, 7]))
  expect(key).toEqual(new Uint8Array([0, 0, 0, 0]))
  expect(mocks.locatedRead.mock.calls[0]!.slice(-3)).toEqual([objectId, 256 * 1024, binding])
})

it("Given a request for another workspace or archive epoch, When serving an object, Then reject it before reading archive content", async () => {
  const source = createWorkspacePeerHistorySource({ getProfile: () => profile })
  const binding = { workspaceId: "other-board", historyEpoch: 3, indexId: "catalogue", objectKind: "part" as const, partIndex: 0, partCount: 1 }
  await expect(source.readHistoryArchiveObject(workspaceId, baselineId, objectId, binding, "peer-device")).resolves.toBeUndefined()
  await expect(source.readHistoryArchiveObject(workspaceId, "D".repeat(43), objectId,
    { ...binding, workspaceId, historyEpoch: 3 }, "peer-device")).resolves.toBeUndefined()
  await expect(source.readHistoryArchiveObject(workspaceId, baselineId, objectId,
    { ...binding, workspaceId, historyEpoch: 4 }, "peer-device")).resolves.toBeUndefined()
  expect(mocks.locatedRead).not.toHaveBeenCalled()
})
