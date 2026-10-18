import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { validateIncomingChangeAuthorizations } from "./changeAuthorization"
import type { WorkspaceAdmissionResult } from "./workspaceAdmissionCore"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"
import { evaluateIncomingWorkspaceAdmission } from "./changeAuthorization"

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

it("Given unchanged workspace rights, When a timestamp refresh overlaps admission, Then synchronization accepts the result", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Timestamp race", profile.identity.personId, "blank"))
  const owner = { personId: profile.identity.personId, publicKey: profile.identity.publicKey, certificates: [profile.certificate] }
  const authority = { genesisOwner: owner, currentOwner: owner, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  state.authority = { version: 1, workspaceId: doc.id, ownerPersonId: owner.personId,
    ownerPublicKey: owner.publicKey, ownerCertificates: owner.certificates, epoch: 1,
    updatedAt: "2026-10-09T11:00:00.000Z", catalog: {} }
  state.admit.mockImplementation(async () => {
    state.authority = { ...state.authority, updatedAt: "2026-10-09T11:00:01.000Z" }
    return { verifiedAuthorizations: [] }
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
