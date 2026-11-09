import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { createWorkspaceDoc } from "../test/boardFixture"
import type { PeerHistoryBaselineDescriptor } from "./workspaceSetHistory"
import { persistBackgroundScopeDocument } from "./workspaceSetLive"

vi.mock("./proofPageCache", () => ({ clearProofPages: vi.fn(async () => {}) }))

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

it("Given a candidate already passed validation, when the durable write fails, then the failure is not treated as a request for archived history", async () => {
  const document = documentBytes()
  const readBaseline = vi.fn()
  const store = {
    validate: vi.fn(async () => {}),
    merge: vi.fn(async () => { throw new Error("disk full") }),
    receiveHistoryBaseline: vi.fn(),
    activateHistoryBaseline: vi.fn(),
  }
  await expect(persist(document, store, { readBaseline })).rejects.toThrow("disk full")
  expect(readBaseline).not.toHaveBeenCalled()
  expect(store.receiveHistoryBaseline).not.toHaveBeenCalled()
  expect(store.activateHistoryBaseline).not.toHaveBeenCalled()
  Automerge.free(document.doc)
})

it("Given validation cannot admit the candidate and the peer published a baseline, when the live path recovers, then it admits against that basis before writing", async () => {
  const document = documentBytes()
  const descriptor = { baselineId: "A".repeat(43) } as PeerHistoryBaselineDescriptor
  const basis = { free: vi.fn() }
  const readBaseline = vi.fn(async () => descriptor)
  const readDocument = vi.fn(async () => new Uint8Array([1]))
  const store = {
    validate: vi.fn()
      .mockRejectedValueOnce(new Error("missing received basis"))
      .mockResolvedValueOnce(undefined),
    merge: vi.fn(async () => {}),
    receiveHistoryBaseline: vi.fn(async () => basis),
    activateHistoryBaseline: vi.fn(async () => {}),
  }
  await persist(document, store, { readBaseline, readDocument })
  expect(readBaseline).toHaveBeenCalledWith(document.id)
  expect(store.receiveHistoryBaseline).toHaveBeenCalledOnce()
  expect(store.validate).toHaveBeenCalledTimes(2)
  expect(store.validate.mock.calls[1]?.[3]).toBe(basis)
  expect(store.activateHistoryBaseline).toHaveBeenCalledWith(document.id, basis)
  expect(store.merge).toHaveBeenCalledWith(document.id, document.bytes, "proof", basis, expect.any(Function))
  expect(basis.free).not.toHaveBeenCalled()
  Automerge.free(document.doc)
})

it("Given an ordinary admitted live packet, when the app store can commit it, then skip a separate validate and do not read archives after a failed write", async () => {
  const document = documentBytes()
  const readBaseline = vi.fn()
  const store = liveStore()
  store.commitReceivedWorkspace.mockResolvedValueOnce({ phase: "committed" }).mockRejectedValueOnce(new Error("disk full"))
  await persist(document, store, { readBaseline })
  expect(store.validate).not.toHaveBeenCalled()
  expect(store.merge).not.toHaveBeenCalled()
  expect(store.commitReceivedWorkspace).toHaveBeenCalledTimes(1)
  expect(store.commitReceivedWorkspace).toHaveBeenCalledWith(document.id, document.bytes, "proof", undefined, expect.any(Function))
  expect(readBaseline).not.toHaveBeenCalled()

  await expect(persist(document, store, { readBaseline })).rejects.toThrow("disk full")
  expect(readBaseline).not.toHaveBeenCalled()
  expect(store.receiveHistoryBaseline).not.toHaveBeenCalled()
  expect(store.validate).not.toHaveBeenCalled()
  Automerge.free(document.doc)
})

it("Given the peer guard rejects before commit, when an ordinary live packet arrives, then archives stay unread", async () => {
  const document = documentBytes()
  const readBaseline = vi.fn()
  const store = liveStore()
  await expect(persist(document, store, { readBaseline }, async () => { throw new Error("access ended") })).rejects.toThrow("access ended")
  expect(store.commitReceivedWorkspace).not.toHaveBeenCalled()
  expect(store.validate).not.toHaveBeenCalled()
  expect(readBaseline).not.toHaveBeenCalled()
  Automerge.free(document.doc)
})

it("Given admission has no local basis, when the peer published signed compact history, then validate that basis before activation and commit through the existing merge", async () => {
  const document = documentBytes()
  const descriptor = { baselineId: "A".repeat(43) } as PeerHistoryBaselineDescriptor
  const basis = { free: vi.fn() }
  const cause = new Error("missing local basis")
  const store = liveStore()
  store.commitReceivedWorkspace.mockResolvedValue({ phase: "unadmitted", cause })
  store.receiveHistoryBaseline.mockResolvedValue(basis)
  await persist(document, store, { readBaseline: vi.fn(async () => descriptor), readDocument: vi.fn(async () => new Uint8Array([1])) })
  expect(store.commitReceivedWorkspace).toHaveBeenCalledTimes(1)
  expect(store.commitReceivedWorkspace).toHaveBeenCalledWith(document.id, document.bytes, "proof", undefined, expect.any(Function))
  expect(store.validate).toHaveBeenCalledTimes(1)
  expect(store.validate.mock.invocationCallOrder[0]).toBeGreaterThan(store.commitReceivedWorkspace.mock.invocationCallOrder[0]!)
  expect(store.validate.mock.calls[0]?.[3]).toBe(basis)
  expect(store.activateHistoryBaseline.mock.invocationCallOrder[0]).toBeGreaterThan(store.validate.mock.invocationCallOrder[0]!)
  expect(store.merge).toHaveBeenCalledWith(document.id, document.bytes, "proof", basis, expect.any(Function))
  expect(store.merge.mock.invocationCallOrder[0]).toBeGreaterThan(store.activateHistoryBaseline.mock.invocationCallOrder[0]!)
  expect(basis.free).not.toHaveBeenCalled()
  Automerge.free(document.doc)
})

it("Given validation fails and the peer has no archived baseline, when the live path stops, then the original validation error remains", async () => {
  const document = documentBytes()
  const store = {
    validate: vi.fn(async () => { throw new Error("signature rejected") }),
    merge: vi.fn(),
    receiveHistoryBaseline: vi.fn(),
    activateHistoryBaseline: vi.fn(),
  }
  await expect(persist(document, store, { readBaseline: vi.fn(async () => undefined) })).rejects.toThrow("signature rejected")
  expect(store.receiveHistoryBaseline).not.toHaveBeenCalled()
  expect(store.merge).not.toHaveBeenCalled()
  Automerge.free(document.doc)
})

function documentBytes() {
  const id = crypto.randomUUID()
  const doc = Automerge.from(createWorkspaceDoc(id, "Live persist", "owner", "blank"))
  return { id, doc, bytes: Automerge.save(doc) }
}

function liveStore() {
  return {
    validate: vi.fn<(id: string, bytes: Uint8Array, authorization?: unknown, basis?: unknown) => Promise<void>>(async () => {}),
    merge: vi.fn<(id: string, bytes: Uint8Array, authorization?: unknown, basis?: unknown) => Promise<void>>(async () => {}),
    commitReceivedWorkspace: vi.fn<(id: string, bytes: Uint8Array, authorization?: unknown, basis?: unknown) => Promise<
      { phase: "committed" } | { phase: "unadmitted"; cause: unknown }>>(async () => ({ phase: "committed" })),
    receiveHistoryBaseline: vi.fn<(id: string, bytes: Uint8Array, authorization: unknown, descriptor: unknown,
      reader: unknown, document: Uint8Array) => Promise<{ free(): void } | undefined>>(async () => undefined),
    activateHistoryBaseline: vi.fn<(id: string, basis: { free(): void }) => Promise<void>>(async () => {}),
  }
}

function persist(document: ReturnType<typeof documentBytes>, store: object, peerHistory: object, peerHistoryGuard: () => Promise<void> = async () => {}) {
  return persistBackgroundScopeDocument({
    workspaceId: document.id, remoteDeviceId: "peer", store, peerHistory, peerHistoryGuard,
  } as Parameters<typeof persistBackgroundScopeDocument>[0], document.bytes, "proof")
}
