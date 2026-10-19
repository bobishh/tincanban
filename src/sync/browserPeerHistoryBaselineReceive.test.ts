import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { WorkspaceUnavailableError } from "../workspaceAvailability"

const mocks = vi.hoisted(() => ({
  getWorkspaceAuthority: vi.fn(), getWorkspaceCredential: vi.fn(), getVerifiedReceivedHistoryBaseline: vi.fn(),
  ensureHistoryProgress: vi.fn(), readWorkspaceRevision: vi.fn(), readWorkspaceSnapshot: vi.fn(),
  readActive: vi.fn(), verify: vi.fn(), revision: "snapshot-revision",
}))

vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceAuthority: mocks.getWorkspaceAuthority,
  getWorkspaceCredential: mocks.getWorkspaceCredential } }))
vi.mock("../storage", () => ({ defaultStorage: {
  getVerifiedReceivedHistoryBaseline: mocks.getVerifiedReceivedHistoryBaseline,
  ensureHistoryProgress: mocks.ensureHistoryProgress,
  readWorkspaceRevision: mocks.readWorkspaceRevision,
} }))
vi.mock("../storageJournal", () => ({ readWorkspaceBasisSnapshot: vi.fn(), readWorkspaceSnapshot: mocks.readWorkspaceSnapshot }))
vi.mock("./receivedHistoryBaselineRepository", () => ({ createReceivedHistoryBaselineRepository: () => ({ readActive: mocks.readActive }) }))
vi.mock("./peerHistoryBaselineReceiver", () => ({ verifyPeerReceivedHistoryBaseline: mocks.verify }))
vi.mock("./blindSnapshotRevision", () => ({ createBlindSnapshotRevision: () => async () => mocks.revision }))

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await Automerge.initializeWasm(wasm)
})

import { receivePeerBrowserHistoryBaseline } from "./browserPeerHistoryBaselineReceive"
import type { PeerHistoryObjectReader } from "./workspaceSet"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

function opaque(id: string, sourceHeads: string[], free = vi.fn()) {
  const value = Object.create(WasmVerifiedReceivedHistoryBaseline.prototype) as WasmVerifiedReceivedHistoryBaseline
  Object.defineProperties(value, {
    envelope: { value: () => ({ payload: { workspaceId: "board", baselineId: id, sourceHeads,
      storage: { keyEpoch: 1, authority: { scopeId: "scope" } }, archive: { context: { workspaceId: "board" } } } }) },
    originalJson: { value: () => new TextEncoder().encode(id) }, document: { value: () => new Uint8Array([1]) },
    controlJson: { value: () => new Uint8Array([2]) }, encryptedObjects: { value: () => new Map() },
    storageVerification: { value: () => "public-receipts-only" },
    plaintextObjects: { value: () => new Map([["P".repeat(43), new Uint8Array([3])]]) }, free: { value: free },
  })
  return value
}

async function setup(input: { activeId: string; incomingId: string; sourceHeads: string[] }) {
  vi.clearAllMocks()
  const doc = Automerge.from({ title: "Local tail" })
  const workspaceBytes = Automerge.save(doc)
  const localHeads = Automerge.getHeads(doc).sort()
  Automerge.free(doc)
  const previous = opaque(input.activeId, ["original-owner-head"])
  const candidate = opaque(input.incomingId, input.sourceHeads)
  const progress = { workspaceId: "board", id: "board", baselineId: input.activeId, admittedChanges: 0, encodedBytes: 0 }
  mocks.getWorkspaceAuthority.mockResolvedValue({ scopeAuthoritySnapshot: { signed: true } })
  mocks.getWorkspaceCredential.mockResolvedValue(null)
  mocks.getVerifiedReceivedHistoryBaseline.mockResolvedValue(previous)
  mocks.ensureHistoryProgress.mockResolvedValue(progress)
  mocks.readWorkspaceRevision.mockResolvedValue("revision")
  mocks.readWorkspaceSnapshot.mockResolvedValue(undefined)
  mocks.readActive.mockResolvedValue({ baselineId: input.activeId })
  mocks.verify.mockResolvedValue(candidate)
  const tincanban = { readWorkspaceBytes: vi.fn(async () => workspaceBytes), getCurrentProfile: vi.fn() }
  const reader = { ensureCurrent: vi.fn(), read: vi.fn() } as unknown as PeerHistoryObjectReader
  const descriptor = { version: 1 as const, sourceKind: "authenticated-peer-plaintext" as const, signedJson: "e30",
    baselineId: input.incomingId, documentDigest: "D".repeat(43), documentLength: 4 }
  return { previous, candidate, localHeads, workspaceBytes, tincanban, reader, descriptor,
    receive: () => receivePeerBrowserHistoryBaseline({ workspaceId: "board", workspaceBytes, authorization: {}, descriptor,
      baselineDocument: new Uint8Array(4), reader, tincanban: tincanban as never, ensureCurrent: () => {} }) }
}

afterEach(() => vi.clearAllMocks())
beforeEach(() => { mocks.revision = "snapshot-revision" })

it("Given the active peer baseline with a newer admitted local tail, When retried, Then verify standalone and preserve same-basis idempotency", async () => {
  const f = await setup({ activeId: "A".repeat(43), incomingId: "A".repeat(43), sourceHeads: [] })
  await expect(f.receive()).resolves.toBe(f.candidate)
  expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ previous: null }))
})

it("Given a new peer baseline that omits a current local head, When received, Then reject and release only the candidate", async () => {
  const f = await setup({ activeId: "A".repeat(43), incomingId: "B".repeat(43), sourceHeads: [] })
  await expect(f.receive()).rejects.toThrow(/does not cover a local workspace head/i)
  expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ previous: f.previous }))
  expect(f.candidate.free).toHaveBeenCalledOnce()
})

it("Given authority revision metadata without a local workspace snapshot, When receiving a peer baseline, Then treat the unavailable document as an empty local basis", async () => {
  const f = await setup({ activeId: "A".repeat(43), incomingId: "B".repeat(43), sourceHeads: [] })
  f.tincanban.readWorkspaceBytes.mockRejectedValue(new WorkspaceUnavailableError())
  await expect(f.receive()).resolves.toBe(f.candidate)
  expect(mocks.readWorkspaceSnapshot).toHaveBeenCalledWith("board")
})
