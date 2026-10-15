import { beforeEach, expect, it, vi } from "vitest"
import { sha256Base64Url, toBase64Url } from "../domain/identity"
import type { WorkspaceSetStore } from "./workspaceSet"
import { createEnrollmentHistoryReader } from "./enrollmentHistoryReader"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

const workspaceId = "board-1"
const remoteDeviceId = "host-device"
const baselineId = "B".repeat(43)
const documentBytes = new Uint8Array([1, 2, 3, 4, 5, 6])

function descriptor(documentDigest = "D".repeat(43)) {
  return { version: 1 as const, sourceKind: "authenticated-peer-plaintext" as const,
    signedJson: toBase64Url(new Uint8Array([7, 8, 9])), baselineId, documentDigest, documentLength: documentBytes.length }
}

function storeFixture() {
  const store = {
    readHistoryBaseline: vi.fn(async () => descriptor()),
    readHistoryBaselineDocument: vi.fn(async () => documentBytes.slice()),
    readHistoryArchiveObject: vi.fn(async () => new Uint8Array([10, 11])),
  } as unknown as WorkspaceSetStore
  return store
}

beforeEach(() => vi.clearAllMocks())

it("Given an exact local Owner-attested descriptor, when the enrollment reader reads it, then return that descriptor and locally bounded document slices", async () => {
  const store = storeFixture()
  const reader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, () => {})
  const current = descriptor(await sha256Base64Url(documentBytes))
  vi.mocked(store.readHistoryBaseline!).mockResolvedValue(current)
  vi.mocked(store.readHistoryBaselineDocument!).mockImplementation(async request =>
    documentBytes.slice(request.offset, request.offset + request.length))

  await expect(reader.readBaseline(workspaceId)).resolves.toEqual(current)
  await expect(reader.readDocument(current, workspaceId)).resolves.toEqual(documentBytes)
  expect(store.readHistoryBaselineDocument).toHaveBeenCalledWith({ workspaceId, baselineId,
    documentDigest: current.documentDigest, offset: 0, length: documentBytes.length }, remoteDeviceId)
})

it("Given a document larger than one transfer part, when read during enrollment, then assemble exact sequential local slices", async () => {
  const bytes = new Uint8Array(256 * 1024 + 19)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  const current = { ...descriptor(), documentDigest: await sha256Base64Url(bytes), documentLength: bytes.length }
  const store = storeFixture()
  vi.mocked(store.readHistoryBaseline!).mockResolvedValue(current)
  vi.mocked(store.readHistoryBaselineDocument!).mockImplementation(async request =>
    bytes.slice(request.offset, request.offset + request.length))
  const reader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, () => {})

  await expect(reader.readDocument(current, workspaceId)).resolves.toEqual(bytes)
  expect(store.readHistoryBaselineDocument).toHaveBeenNthCalledWith(1, { workspaceId, baselineId,
    documentDigest: current.documentDigest, offset: 0, length: 256 * 1024 }, remoteDeviceId)
  expect(store.readHistoryBaselineDocument).toHaveBeenNthCalledWith(2, { workspaceId, baselineId,
    documentDigest: current.documentDigest, offset: 256 * 1024, length: 19 }, remoteDeviceId)
})

it("Given a stale descriptor, another workspace, or missing local bytes, when reading an enrollment baseline, then reject without network fallback", async () => {
  const store = storeFixture()
  const reader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, () => {})
  const current = descriptor()
  vi.mocked(store.readHistoryBaseline!).mockResolvedValue(current)

  await expect(reader.readDocument({ ...current, baselineId: "C".repeat(43) }, workspaceId)).rejects.toThrow(/changed/i)
  await expect(reader.readDocument(current, "unselected-board")).rejects.toThrow(/not selected/i)
  expect(store.readHistoryBaselineDocument).not.toHaveBeenCalled()

  const valid = { ...current, documentDigest: await sha256Base64Url(documentBytes) }
  vi.mocked(store.readHistoryBaseline!).mockResolvedValue(valid)
  const validReader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, () => {})
  vi.mocked(store.readHistoryBaselineDocument!).mockResolvedValue(undefined)
  await expect(validReader.readDocument(valid, workspaceId)).rejects.toThrow(/unavailable/i)
  vi.mocked(store.readHistoryBaselineDocument!).mockResolvedValue(new Uint8Array([6, 5, 4, 3, 2, 1]))
  await expect(validReader.readDocument(valid, workspaceId)).rejects.toThrow(/does not match/i)
})

it("Given enrollment authority expires while a local read is pending, when bytes return, then discard them", async () => {
  let current = true
  const ensureCurrent = () => { if (!current) throw new Error("Enrollment authority changed") }
  const store = storeFixture()
  const valid = { ...descriptor(), documentDigest: await sha256Base64Url(documentBytes) }
  vi.mocked(store.readHistoryBaseline!).mockResolvedValue(valid)
  vi.mocked(store.readHistoryBaselineDocument!).mockImplementation(async () => {
    current = false
    return documentBytes.slice()
  })
  const reader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, ensureCurrent)

  await expect(reader.readDocument(valid, workspaceId)).rejects.toThrow("Enrollment authority changed")
})

it("Given a valid descriptor and archive binding, when enrollment reads an object, then serve only the selected workspace's local object", async () => {
  const store = storeFixture()
  const reader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, () => {})
  await expect(reader.read("A".repeat(43), { workspaceId, historyEpoch: 1, indexId: "catalogue",
    objectKind: "part", partIndex: 0, partCount: 1 }, baselineId)).resolves.toEqual(new Uint8Array([10, 11]))
  expect(store.readHistoryArchiveObject).toHaveBeenCalledWith(workspaceId, baselineId, "A".repeat(43),
    { workspaceId, historyEpoch: 1, indexId: "catalogue", objectKind: "part", partIndex: 0, partCount: 1 }, remoteDeviceId)
  await expect(reader.read("A".repeat(43), { workspaceId: "other", historyEpoch: 1, indexId: "catalogue",
    objectKind: "part", partIndex: 0, partCount: 1 }, baselineId)).rejects.toThrow(/not selected/i)
  expect(store.readHistoryArchiveObject).toHaveBeenCalledTimes(1)
})

it("Given a Native-verified child, When reading its exact parent during enrollment, Then permit only that signed predecessor and keep the current source pinned", async () => {
  const store = storeFixture(), parentId = "C".repeat(43), current = descriptor()
  const parent = { ...current, baselineId: parentId, signedJson: toBase64Url(new Uint8Array([4, 5, 6])),
    documentDigest: await sha256Base64Url(documentBytes) }
  vi.mocked(store.readHistoryBaseline!).mockImplementation(async (_workspace, id) => id === parentId ? parent : current)
  const reader = createEnrollmentHistoryReader(store, [workspaceId], remoteDeviceId, () => {})
  await expect(reader.readBaseline(workspaceId, parentId)).rejects.toThrow(/verified|ancestor|changed/i)
  const child = Object.create(WasmVerifiedReceivedHistoryBaseline.prototype) as WasmVerifiedReceivedHistoryBaseline
  Object.defineProperties(child, {
    originalJson: { value: () => new Uint8Array([7, 8, 9]) },
    envelope: { value: () => ({ payload: { workspaceId, baselineId, previousBaselineId: parentId } }) },
  })
  await reader.authorizeHistoryAncestor!(child)
  await expect(reader.readBaseline(workspaceId, parentId)).resolves.toEqual(parent)
  await expect(reader.readDocument(parent, workspaceId)).resolves.toEqual(documentBytes)
  await expect(reader.readBaseline(workspaceId, "E".repeat(43))).rejects.toThrow(/ancestor|verified/i)
  vi.mocked(store.readHistoryBaseline!).mockResolvedValue({ ...current, baselineId: "F".repeat(43) })
  await expect(reader.readBaseline(workspaceId, parentId)).rejects.toThrow(/changed/i)
})
