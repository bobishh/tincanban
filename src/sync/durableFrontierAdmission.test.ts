import "fake-indexeddb/auto"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createLeadFixture } from "../test/leadFixture"
import { useTincanban, hydrate, resetStateForTest } from "../test/stateFixture"
import { defaultStorage, setStorageFailureHookForTest } from "../storage"
import { readWorkspaceBasisSnapshot } from "../storageJournal"
import { authorizeLocalChanges, durableAdmittedFrontierCredential, exportAuthorizationBundle } from "./changeAuthorization"
import { executeCommand } from "../domain/commands"
import { persistBackgroundScopeDocument } from "./workspaceSetLive"
import type { WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"
import { recentIncomingPackets } from "../stateIncomingPacketCache"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return {
    ...actual,
    merge: vi.fn(actual.merge),
    getChangesMetaSince: vi.fn(actual.getChangesMetaSince),
    save: vi.fn(actual.save),
  }
})

beforeAll(async () => {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? options as () => Promise<unknown>)() } })
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("durable admitted frontier", () => {
  beforeEach(async () => {
    setStorageFailureHookForTest(false)
    for (const workspace of [...await defaultStorage.listWorkspaces(), ...await defaultStorage.listArchivedWorkspaces()])
      await defaultStorage.purgeWorkspaceForTest(workspace.id)
    recentIncomingPackets.clear()
    resetIdentityStorageForTest()
    resetStateForTest()
    await bootstrapIdentity("Frontier Test User")
    await hydrate()
    await useTincanban().createWorkspaceAsync("Job search", "job-search")
    clearMeshTrace()
    vi.mocked(Automerge.merge).mockClear()
    vi.mocked(Automerge.getChangesMetaSince).mockClear()
    vi.mocked(Automerge.save).mockClear()
  })

  it("Given one source already admitted this signed history, when the same history arrives with the packet cache empty and storage writes fail, then the common path keeps the board without rebuilding the raw history", async () => {
    const admitted = await admitCurrentBoard()
    const saved = await readWorkspaceBasisSnapshot(admitted.id)
    recentIncomingPackets.delete(admitted.id)
    clearMeshTrace()
    vi.mocked(Automerge.merge).mockClear()
    vi.mocked(Automerge.getChangesMetaSince).mockClear()
    vi.mocked(Automerge.save).mockClear()
    setStorageFailureHookForTest(true)
    try {
      await expect(admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), structuredClone(admitted.authorization))).resolves.toBeUndefined()
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(vi.mocked(Automerge.getChangesMetaSince)).not.toHaveBeenCalled()
      expect(vi.mocked(Automerge.save)).not.toHaveBeenCalled()
      expect(meshTraceSnapshot().some(event => event.event === "workspace.admission.profile")).toBe(false)
      expect(meshTraceSnapshot().some(event => event.event === "workspace.admission.frontier-reused")).toBe(true)
      expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)
    } finally { setStorageFailureHookForTest(false) }
  })

  it("Given the admitted frontier, when a repeated packet carries only a subset of the stored verified proofs, then the board is kept without full admission or a write", async () => {
    const admitted = await admitCurrentBoard()
    const saved = await readWorkspaceBasisSnapshot(admitted.id)
    const missingProof = structuredClone(admitted.authorization)
    missingProof.records.pop()
    recentIncomingPackets.delete(admitted.id)
    vi.mocked(Automerge.merge).mockClear()
    setStorageFailureHookForTest(true)
    try {
      await expect(admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), missingProof)).resolves.toBeUndefined()
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)
    } finally { setStorageFailureHookForTest(false) }
  })

  it("Given the admitted frontier, when authority in the repeated packet changes, then the raw history is checked again", async () => {
    const admitted = await admitCurrentBoard()
    const changed = structuredClone(admitted.authorization)
    changed.authority = { ...changed.authority, currentEpoch: changed.authority.currentEpoch + 1 }
    recentIncomingPackets.delete(admitted.id)
    clearMeshTrace()
    vi.mocked(Automerge.merge).mockClear()
    await admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), changed).catch(() => undefined)
    expect(vi.mocked(Automerge.merge)).toHaveBeenCalled()
    expect(meshTraceSnapshot().some(event => event.event === "workspace.admission.frontier-reused")).toBe(false)
  })

  it("Given a local change already admitted into the delta journal, when a peer repeats the same board and authority, then reuse the durable frontier without rewriting it", async () => {
    const { app, id } = await admitCurrentBoard()
    await app.executeCommandAsync({ kind: "renameWorkspace", title: "Saved locally" })
    const evidence = await defaultStorage.loadCausalEvidence(id)
    expect(evidence?.admissionCheckpoint?.incremental).toBe(true)
    const bytes = Automerge.save(app.getActiveDoc()!)
    const authorization = await exportAuthorizationBundle(bytes, app.getCurrentProfile()!)
    const revision = await defaultStorage.readWorkspaceRevision(id)
    recentIncomingPackets.delete(id)
    clearMeshTrace()
    vi.mocked(Automerge.merge).mockClear()
    setStorageFailureHookForTest(true)
    try {
      await expect(app.mergeAuthorizedWorkspace(id, bytes, authorization)).resolves.toBeUndefined()
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(await defaultStorage.readWorkspaceRevision(id)).toBe(revision)
      expect((await defaultStorage.loadCausalEvidence(id))?.admissionCheckpoint?.incremental).toBe(true)
      expect(meshTraceSnapshot().some(event => event.event === "workspace.admission.frontier-reused" && event.incremental === true)).toBe(true)
    } finally { setStorageFailureHookForTest(false) }
  })

  it("Given the durable checkpoint, when the frontier, proofs, or authority do not match, then coverage is refused without a raw union", async () => {
    const admitted = await admitCurrentBoard()
    const evidence = await defaultStorage.loadCausalEvidence(admitted.id)
    const local = (await defaultStorage.loadWorkspaceDoc(admitted.id))!.doc
    const remote = Automerge.load<WorkspaceDocumentV2>(admitted.bytes)
    vi.mocked(Automerge.merge).mockClear()
    vi.mocked(Automerge.getChangesMetaSince).mockClear()
    let edited: Automerge.Doc<WorkspaceDocumentV2> | undefined
    try {
      expect(await durableAdmittedFrontierCredential(local, remote, admitted.authorization, evidence)).toBeDefined()
      const missing = structuredClone(admitted.authorization)
      missing.records.pop()
      expect(await durableAdmittedFrontierCredential(local, remote, missing, evidence)).toBeDefined()
      const source = admitted.authorization.records[0] as WorkspaceChangeAuthorization
      const extra = { ...admitted.authorization, records: [...admitted.authorization.records, {
        ...source, signed: { ...source.signed, signature: `${source.signed.signature}extra` },
      }] }
      expect(await durableAdmittedFrontierCredential(local, remote, extra, evidence)).toBeUndefined()
      const changed = structuredClone(admitted.authorization)
      changed.authority = { ...changed.authority, currentEpoch: changed.authority.currentEpoch + 1 }
      expect(await durableAdmittedFrontierCredential(local, remote, changed, evidence)).toBeUndefined()
      expect(await durableAdmittedFrontierCredential(local, remote, admitted.authorization, undefined)).toBeUndefined()
      expect(await durableAdmittedFrontierCredential(local, remote, admitted.authorization, {
        ...evidence!, admissionCheckpoint: { ...evidence!.admissionCheckpoint!, incremental: true },
      })).toBeUndefined()
      edited = Automerge.change(Automerge.clone(local), draft => { draft.title = "Different frontier" })
      expect(await durableAdmittedFrontierCredential(local, edited, admitted.authorization, evidence)).toBeUndefined()
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(vi.mocked(Automerge.getChangesMetaSince)).not.toHaveBeenCalled()
    } finally {
      Automerge.free(local)
      Automerge.free(remote)
      if (edited) Automerge.free(edited)
    }
  })

  it("Given a later local edit, when the older admitted history arrives with the packet cache empty, then the local edit remains", async () => {
    const admitted = await admitCurrentBoard()
    await admitted.app.executeCommandAsync({ kind: "renameWorkspace", title: "Kept local edit" })
    recentIncomingPackets.delete(admitted.id)
    await admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), structuredClone(admitted.authorization))
    expect(admitted.app.getActiveDoc()!.title).toBe("Kept local edit")
  })

  it("Given a board has unadmitted evidence, when another source repeats the accepted frontier, then keep the unadmitted branch for later review", async () => {
    const admitted = await admitCurrentBoard()
    const original = Automerge.load<WorkspaceDocumentV2>(admitted.bytes)
    const unsigned = Automerge.change(original, draft => { draft.title = "Unsigned edit" })
    const [unsignedHead] = Automerge.getHeads(unsigned)
    const bytes = Automerge.save(unsigned)
    Automerge.free(unsigned)
    await admitted.app.mergeAuthorizedWorkspace(admitted.id, bytes, structuredClone(admitted.authorization))
    const stored = (await defaultStorage.loadCausalEvidence(admitted.id))!
    const decision = stored.decisions.find(entry => entry.hash === unsignedHead)
    expect(decision).toBeDefined()
    expect(decision?.status.type).not.toBe("admitted")

    recentIncomingPackets.delete(admitted.id)
    await admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), structuredClone(admitted.authorization))

    const after = (await defaultStorage.loadCausalEvidence(admitted.id))!
    expect(after.decisions).toContainEqual(decision)
    const raw = Automerge.load<WorkspaceDocumentV2>(after.bytes)
    try { expect(Automerge.hasHeads(raw, [unsignedHead!])).toBe(true) }
    finally { Automerge.free(raw) }
  })

  it("Given a duplicate frontier, when its explicit received basis no longer matches the transaction, then reject, free both documents, and do not save", async () => {
    const admitted = await admitCurrentBoard()
    const saved = await readWorkspaceBasisSnapshot(admitted.id)
    recentIncomingPackets.delete(admitted.id)
    const basis = receivedBasis(null)
    const current = vi.spyOn(defaultStorage, "getVerifiedReceivedHistoryBaseline").mockResolvedValue(receivedBasis("replaced-basis"))
    const freed: unknown[] = []
    const originalFree = Automerge.free
    const free = vi.spyOn(Automerge, "free").mockImplementation(doc => { freed.push(doc); return originalFree(doc) })
    vi.mocked(Automerge.merge).mockClear()
    vi.mocked(Automerge.save).mockClear()
    try {
      await expect(admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), structuredClone(admitted.authorization), undefined, basis)).rejects.toThrow(/basis/i)
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(vi.mocked(Automerge.save)).not.toHaveBeenCalled()
      expect(new Set(freed).size).toBeGreaterThanOrEqual(2)
      expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)
    } finally { free.mockRestore(); current.mockRestore() }
  })

  it("Given an ordinary admitted live packet, when the app store applies it, then one transaction commits without a separate validate and a failed write does not read archives", async () => {
    const admitted = await admitCurrentBoard()
    const saved = await readWorkspaceBasisSnapshot(admitted.id)
    const store = appLiveStore(admitted.app)
    const readBaseline = vi.fn()
    const transactions = vi.spyOn(defaultStorage, "withWorkspaceTransaction")
    transactions.mockClear()
    vi.mocked(Automerge.merge).mockClear()
    try {
      await persistBackgroundScopeDocument(liveContext(admitted.id, store, { readBaseline }), admitted.bytes.slice(), structuredClone(admitted.authorization))
      expect(store.validate).not.toHaveBeenCalled()
      expect(store.merge).not.toHaveBeenCalled()
      expect(transactions).toHaveBeenCalledTimes(1)
      expect(readBaseline).not.toHaveBeenCalled()
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)

      const peer = await divergentPeerPacket(admitted.app)
      transactions.mockClear()
      setStorageFailureHookForTest(true)
      await expect(persistBackgroundScopeDocument(liveContext(admitted.id, store, { readBaseline }), peer.bytes, peer.authorization)).rejects.toThrow(/Storage failure/i)
      expect(store.validate).not.toHaveBeenCalled()
      expect(readBaseline).not.toHaveBeenCalled()
      expect(store.receiveHistoryBaseline).not.toHaveBeenCalled()
      expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)
    } finally { setStorageFailureHookForTest(false); transactions.mockRestore() }
  })

  it("Given admission rejects the live packet, when the peer has no archived baseline, then the app store still asks for signed compact history and does not write", async () => {
    const admitted = await admitCurrentBoard()
    const saved = await readWorkspaceBasisSnapshot(admitted.id)
    const forged = structuredClone(admitted.authorization)
    const record = forged.records[0] as { signed: { signature: string } }
    record.signed.signature += "forged"
    const store = appLiveStore(admitted.app)
    const readBaseline = vi.fn(async () => undefined)
    await expect(persistBackgroundScopeDocument(liveContext(admitted.id, store, { readBaseline }), admitted.bytes.slice(), forged)).rejects.toThrow(/signature|authorization/i)
    expect(readBaseline).toHaveBeenCalledWith(admitted.id)
    expect(store.merge).not.toHaveBeenCalled()
    expect(store.receiveHistoryBaseline).not.toHaveBeenCalled()
    expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)
  })

  it("Given a valid live packet, when the peer session changes during policy evaluation, then keep the durable board and leave archives unread", async () => {
    const admitted = await admitCurrentBoard()
    const peer = await divergentPeerPacket(admitted.app)
    const saved = await readWorkspaceBasisSnapshot(admitted.id)
    const readBaseline = vi.fn()
    const context = liveContext(admitted.id, appLiveStore(admitted.app), { readBaseline })
    vi.mocked(Automerge.merge).mockClear()
    context.peerHistoryGuard = async () => {
      if (vi.mocked(Automerge.merge).mock.calls.length) throw new Error("Peer session changed")
    }

    await expect(persistBackgroundScopeDocument(context, peer.bytes, peer.authorization)).rejects.toThrow("Peer session changed")
    expect(readBaseline).not.toHaveBeenCalled()
    expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(saved)
  })

  it("Given a duplicate frontier, when its explicit received basis still matches the transaction, then skip rebuilding the raw history", async () => {
    const admitted = await admitCurrentBoard()
    recentIncomingPackets.delete(admitted.id)
    const basis = receivedBasis(null)
    const current = vi.spyOn(defaultStorage, "getVerifiedReceivedHistoryBaseline").mockResolvedValue(basis)
    vi.mocked(Automerge.merge).mockClear()
    vi.mocked(Automerge.save).mockClear()
    try {
      await expect(admitted.app.mergeAuthorizedWorkspace(admitted.id, admitted.bytes.slice(), structuredClone(admitted.authorization), undefined, basis)).resolves.toBeUndefined()
      expect(vi.mocked(Automerge.merge)).not.toHaveBeenCalled()
      expect(vi.mocked(Automerge.save)).not.toHaveBeenCalled()
    } finally { current.mockRestore() }
  })
})

function appLiveStore(app: ReturnType<typeof useTincanban>) {
  return {
    validate: vi.fn((id: string, bytes: Uint8Array, authorization?: unknown,
      receivedBasis?: Parameters<ReturnType<typeof useTincanban>["validateAuthorizedWorkspace"]>[4]) =>
      app.validateAuthorizedWorkspace(id, bytes, authorization, undefined, receivedBasis)),
    merge: vi.fn((id: string, bytes: Uint8Array, authorization?: unknown,
      receivedBasis?: Parameters<ReturnType<typeof useTincanban>["mergeAuthorizedWorkspace"]>[4], ensureCurrent?: () => Promise<void>) =>
      app.mergeAuthorizedWorkspace(id, bytes, authorization, undefined, receivedBasis, ensureCurrent)),
    commitReceivedWorkspace: (id: string, bytes: Uint8Array, authorization?: unknown,
      receivedBasis?: Parameters<ReturnType<typeof useTincanban>["mergeAuthorizedWorkspace"]>[4], ensureCurrent?: () => Promise<void>) =>
      app.commitReceivedWorkspace(id, bytes, authorization, undefined, receivedBasis, ensureCurrent),
    receiveHistoryBaseline: vi.fn(),
    activateHistoryBaseline: vi.fn(),
  }
}

function liveContext(workspaceId: string, store: object, peerHistory: object) {
  return {
    workspaceId, remoteDeviceId: "peer", store, peerHistory, peerHistoryGuard: async () => {},
  } as Parameters<typeof persistBackgroundScopeDocument>[0]
}

async function divergentPeerPacket(app: ReturnType<typeof useTincanban>) {
  const doc = app.getActiveDoc()!
  const profile = app.getCurrentProfile()!
  const result = await executeCommand(doc, { kind: "renameWorkspace", title: "Peer title" }, profile)
  if (!result.ok) throw new Error(result.error.message)
  try {
    await authorizeLocalChanges(result.value.newDoc, profile, [result.value.receipt.changeHash])
    const bytes = Automerge.save(result.value.newDoc)
    return { bytes, authorization: await exportAuthorizationBundle(bytes, profile) }
  } finally { Automerge.free(result.value.newDoc) }
}

function receivedBasis(baselineId: string | null) {
  return { envelope: () => ({ payload: { baselineId, genesisHash: "frontier-genesis" } }) } as Parameters<ReturnType<typeof useTincanban>["mergeAuthorizedWorkspace"]>[4]
}

async function admitCurrentBoard() {
  const app = useTincanban()
  await createLeadFixture(app, { company: "Second source", role: "Engineer", status: "lead" })
  const doc = app.getActiveDoc()!
  const profile = app.getCurrentProfile()!
  const bytes = Automerge.save(doc)
  const authorization = await exportAuthorizationBundle(bytes, profile)
  await app.mergeAuthorizedWorkspace(doc.id, bytes, authorization)
  const evidence = await defaultStorage.loadCausalEvidence(doc.id)
  expect(evidence?.admissionCheckpoint?.incremental).not.toBe(true)
  expect(evidence?.admissionCheckpoint?.projectionHeads.length).toBeGreaterThan(0)
  return { app, id: doc.id, bytes, authorization }
}
