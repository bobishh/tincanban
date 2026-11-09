import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import type * as AutomergeModule from "@automerge/automerge/slim"

const automergeSpy = vi.hoisted(() => ({ merges: 0 }))
vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof AutomergeModule>("@automerge/automerge/slim")
  return { ...actual, merge: (...args: Parameters<typeof actual.merge>) => {
    automergeSpy.merges += 1
    return actual.merge(...args)
  } }
})

import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { validateIncomingChangeAuthorizations } from "./changeAuthorization"
import type { WorkspaceAdmissionResult } from "../product-replica/workspaceAdmission"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"
import { evaluateIncomingWorkspaceAdmission } from "./changeAuthorization"
import { rememberWorkspaceAdmission, reusedWorkspaceAdmission } from "./workspaceAdmissionReuse"

const state = vi.hoisted(() => ({ authority: null as unknown, admit: vi.fn() }))
vi.mock("./workspaceAdmissionClient", () => ({ runWorkspaceAdmission: (...args: unknown[]) => state.admit(...args) }))
vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceAuthority: async () => state.authority,
  getWorkspaceCredential: async () => null,
} }))

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

beforeEach(() => { state.admit.mockReset(); clearMeshTrace() })

it("Given a large admitted history, when exact-input reuse would retain more than the cache budget, then keep neither document in memory", () => {
  const id = crypto.randomUUID()
  const rawBytes = new Uint8Array(9 * 1024 * 1024)
  const result: WorkspaceAdmissionResult = { neededHashes: [], admittedHashes: [], verifiedAuthorizations: [],
    authorizationEvidence: [], quarantinedHashes: [], pendingHashes: [], decisions: [],
    authorizedDocument: new Uint8Array(8 * 1024 * 1024), authorizedHeads: [] }
  rememberWorkspaceAdmission(id, "same-input", result, rawBytes)
  expect(reusedWorkspaceAdmission(id, "same-input") === undefined).toBe(true)
})

it("Given identical raw history and rights, When repeated packets arrive, Then admission reuses its result but new evidence or history is checked again", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  let doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Repeated packets", profile.identity.personId, "blank"))
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  state.authority = null
  const result: WorkspaceAdmissionResult = { neededHashes: [], admittedHashes: [], verifiedAuthorizations: [],
    authorizationEvidence: [], quarantinedHashes: [], pendingHashes: [], decisions: [], authorizedDocument: Automerge.save(doc), authorizedHeads: Automerge.getHeads(doc) }
  state.admit.mockResolvedValue(result)
  const bundle = { version: 1, records: [], authority }
  const first = await evaluateIncomingWorkspaceAdmission(doc, doc, bundle)
  first.authorizedDocument.fill(0)
  const repeated = await evaluateIncomingWorkspaceAdmission(doc, doc, bundle)
  expect(repeated.authorizedDocument).toEqual(result.authorizedDocument)
  expect(state.admit).toHaveBeenCalledOnce()
  expect(meshTraceSnapshot().some(event => event.event === "workspace.admission.reused")).toBe(true)
  await evaluateIncomingWorkspaceAdmission(doc, doc, { ...bundle, authority: { ...authority, currentEpoch: 2 } })
  expect(state.admit).toHaveBeenCalledTimes(2)
  doc = Automerge.change(doc, draft => { draft.title = "New history" })
  await evaluateIncomingWorkspaceAdmission(doc, doc, bundle)
  expect(state.admit).toHaveBeenCalledTimes(3)
  state.authority = { version: 1, workspaceId: doc.id, ownerPersonId: owner.personId,
    ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates, epoch: 2, catalog: {} }
  await evaluateIncomingWorkspaceAdmission(doc, doc, bundle)
  expect(state.admit).toHaveBeenCalledTimes(4)
  Automerge.free(doc)
})

it("Given the same local base and remote history, when admission runs again, then the raw union is not repeated and a changed base is checked again", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const local = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Union once", profile.identity.personId, "blank"))
  const remote = Automerge.change(Automerge.clone(local), draft => { draft.title = "Remote edit" })
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  state.authority = null
  state.admit.mockResolvedValue({ neededHashes: [], admittedHashes: [], verifiedAuthorizations: [],
    authorizationEvidence: [], quarantinedHashes: [], pendingHashes: [], decisions: [],
    authorizedDocument: Automerge.save(remote), authorizedHeads: Automerge.getHeads(remote) })
  const bundle = { version: 1, records: [], authority }
  automergeSpy.merges = 0
  try {
    await evaluateIncomingWorkspaceAdmission(local, remote, bundle)
    expect(automergeSpy.merges).toBe(1)
    expect(state.admit).toHaveBeenCalledOnce()
    automergeSpy.merges = 0
    await evaluateIncomingWorkspaceAdmission(local, remote, bundle)
    expect(automergeSpy.merges).toBe(0)
    expect(state.admit).toHaveBeenCalledOnce()
    const later = Automerge.change(Automerge.clone(remote), draft => { draft.title = "Later remote edit" })
    try {
      await evaluateIncomingWorkspaceAdmission(local, later, bundle)
      expect(automergeSpy.merges).toBe(1)
      expect(state.admit).toHaveBeenCalledTimes(2)
    } finally { Automerge.free(later) }
  } finally { Automerge.free(local); Automerge.free(remote) }
})

it("Given unchanged workspace rights, When a timestamp refresh overlaps admission, Then synchronization accepts the result", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Timestamp race", profile.identity.personId, "blank"))
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  const storedAuthority = { version: 1, workspaceId: doc.id, ownerPersonId: owner.personId,
    ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates, epoch: 1,
    updatedAt: "2026-10-09T11:00:00.000Z", catalog: {} }
  state.authority = storedAuthority
  state.admit.mockImplementation(async () => {
    state.authority = { ...storedAuthority, updatedAt: "2026-10-09T11:00:01.000Z" }
    return { neededHashes: [], admittedHashes: [], verifiedAuthorizations: [], authorizationEvidence: [],
      quarantinedHashes: [], pendingHashes: [], decisions: [], authorizedDocument: Automerge.save(doc),
      authorizedHeads: Automerge.getHeads(doc) } satisfies WorkspaceAdmissionResult
  })
  await expect(validateIncomingChangeAuthorizations(doc, doc, { version: 1, records: [], authority })).resolves.toEqual([])
  expect(meshTraceSnapshot().some(event => event.event === "workspace.admission.authority-refreshed")).toBe(true)
  Automerge.free(doc)
})

it("rejects a worker result when durable authority changed while admission was pending", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Authority race", profile.identity.personId, "blank"))
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  state.authority = null
  let finish!: (result: WorkspaceAdmissionResult) => void
  state.admit.mockReturnValue(new Promise<WorkspaceAdmissionResult>(resolve => { finish = resolve }))
  const validation = validateIncomingChangeAuthorizations(undefined, doc, { version: 1, records: [], authority })
  const rejected = expect(validation).rejects.toThrow("Workspace authority changed during validation")
  await vi.waitFor(() => expect(state.admit).toHaveBeenCalledOnce())
  state.authority = { version: 1, workspaceId: doc.id, ownerPersonId: owner.personId,
    ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates, epoch: 2, catalog: {} }
  finish({ neededHashes: [], admittedHashes: [], verifiedAuthorizations: [], authorizationEvidence: [], quarantinedHashes: [],
    pendingHashes: [], decisions: [], authorizedDocument: new Uint8Array(), authorizedHeads: [] })
  await rejected
  expect(meshTraceSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({
    event: "workspace.admission.authority-changed",
    workspaceId: doc.id,
  })]))
  Automerge.free(doc)
})
