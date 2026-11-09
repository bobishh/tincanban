import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity } from "./domain/identity"
import { createWorkspaceDoc } from "./test/boardFixture"
import { executeCommand } from "./domain/commands"
import * as authorityFingerprint from "./sync/authorityFingerprint"
import { durableAdmittedFrontierCredential, evaluateIncomingWorkspaceAdmission, exportDocumentAuthorizationBundle,
  localWorkspaceAdmissionAuthority, prepareLocalChangeAuthorizations, recordGenesisAuthority,
} from "./sync/changeAuthorization"
import { reusableDeltaAdmission } from "./stateDeltaAdmission"
import { recognizeAdmittedIncrementalFrontier } from "./stateIncomingWorkspace"
import { WorkspaceStorage } from "./storage"
import { readWorkspaceBasisSnapshot } from "./storageJournal"
import type { WorkspaceAuthorityRecord } from "./sync/peerStore"
import * as admissionClient from "./sync/workspaceAdmissionClient"
import type { StoredCausalEvidence } from "./storageJournalRecords"
import type { WorkspaceDocumentV2 } from "./domain/model"

const stored = vi.hoisted(() => ({ authority: null as WorkspaceAuthorityRecord | null }))
vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, merge: vi.fn(actual.merge), getChangesMetaSince: vi.fn(actual.getChangesMetaSince), save: vi.fn(actual.save) }
})
vi.mock("./sync/peerStore", () => ({ peerStore: {
  getWorkspaceAuthority: async () => stored.authority,
  getWorkspaceCredential: async () => null,
} }))

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
beforeEach(() => { stored.authority = null })

it("Given a locally admitted incremental frontier, when a peer repeats its heads, authority, and stored proofs, then return that evidence without replaying history", async () => {
  const policy = vi.spyOn(admissionClient, "runWorkspaceAdmission")
  const admitted = await admittedDelta()
  const changes = vi.mocked(Automerge.getChangesMetaSince)
  const save = vi.mocked(Automerge.save)
  const merge = vi.mocked(Automerge.merge)
  try {
    expect(await durableAdmittedFrontierCredential(admitted.local, admitted.remote, admitted.authorization, admitted.evidence)).toBeUndefined()
    policy.mockClear()
    changes.mockClear()
    save.mockClear()
    merge.mockClear()
    const result = await recognize(admitted)
    const authority = await localWorkspaceAdmissionAuthority(admitted.local, admitted.profile)
    expect(result).toEqual({ evidence: admitted.evidence, credentialFingerprint: authority.credentialFingerprint })
    expect(result?.evidence.decisions.every(decision => decision.status.type === "admitted")).toBe(true)
    expect(policy).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(merge).not.toHaveBeenCalled()
    expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(admitted.basis)
    expect(admitted.basis?.causalEvidence?.admissionCheckpoint?.incremental).not.toBe(true)
  } finally { release(admitted); policy.mockRestore() }
})

it("Given an admitted incremental frontier, when authority, proofs, heads, or evidence differ, then strict admission remains required", async () => {
  const admitted = await admittedDelta()
  const policy = vi.spyOn(admissionClient, "runWorkspaceAdmission")
  const changed = structuredClone(admitted.authorization)
  changed.authority.currentEpoch += 1
  const extra = structuredClone(admitted.authorization)
  const source = extra.records[0]!
  extra.records.push({ ...source, signed: { ...source.signed, signature: `${source.signed.signature}extra` } })
  const decisions = admitted.evidence.decisions.map(decision => ({ ...decision }))
  const last = decisions.length - 1
  decisions[last] = { ...decisions[last]!, status: { type: "quarantined", reason: "held" } }
  const quarantined: StoredCausalEvidence = { ...admitted.evidence, decisions }
  const remote = Automerge.change(Automerge.clone(admitted.local), draft => { draft.title = "Different frontier" })
  const revoked = await admittedDelta()
  stored.authority = revocation(revoked)
  try {
    policy.mockClear()
    await expect(recognize(admitted, changed)).resolves.toBeUndefined()
    await expect(recognize(admitted, extra)).resolves.toBeUndefined()
    await expect(recognize(admitted, admitted.authorization, quarantined)).resolves.toBeUndefined()
    expect(quarantined.bytes).toEqual(admitted.evidence.bytes)
    expect(quarantined.decisions[last]?.status).toEqual({ type: "quarantined", reason: "held" })
    await expect(recognize(admitted, admitted.authorization, admitted.evidence, remote)).resolves.toBeUndefined()
    await expect(recognize(admitted, admitted.authorization, admitted.basis?.causalEvidence)).resolves.toBeUndefined()
    await expect(recognize(revoked)).resolves.toBeUndefined()
    expect(policy).not.toHaveBeenCalled()
    expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(admitted.basis)
    expect(await readWorkspaceBasisSnapshot(revoked.id)).toEqual(revoked.basis)
  } finally { Automerge.free(remote); release(admitted); release(revoked); policy.mockRestore() }
})

it("Given a matching incremental packet, when authority changes after that check, then validation asks for a retry", async () => {
  const admitted = await admittedDelta()
  const revoked = revocation(admitted)
  const match = authorityFingerprint.packetMatchingVerifiedAuthority
  const authority = vi.spyOn(authorityFingerprint, "packetMatchingVerifiedAuthority").mockImplementation((packet, verified) => {
    const records = match(packet, verified)
    stored.authority = revoked
    return records
  })
  try {
    await expect(recognize(admitted)).rejects.toThrow(/authority changed during validation/)
    expect(await readWorkspaceBasisSnapshot(admitted.id)).toEqual(admitted.basis)
    expect((await admitted.storage.readDeltaFrontier(admitted.id))?.revision).toBeGreaterThan(0)
  } finally { authority.mockRestore(); release(admitted) }
})

async function recognize(admitted: AdmittedDelta, authorization: unknown = admitted.authorization,
  evidence: StoredCausalEvidence | null | undefined = admitted.evidence, remote: Automerge.Doc<WorkspaceDocumentV2> = admitted.remote) {
  return admitted.storage.withWorkspaceTransaction(admitted.id, transaction => recognizeAdmittedIncrementalFrontier(
    admitted.local, remote, authorization, evidence, transaction, admitted.profile))
}

function revocation(admitted: AdmittedDelta): WorkspaceAuthorityRecord {
  return { version: 1, workspaceId: admitted.id, ownerPersonId: admitted.profile.identity.personId,
    ownerPublicKey: admitted.profile.identity.publicKey, ownerCertificates: [admitted.profile.certificate], epoch: 2,
    updatedAt: new Date().toISOString(), catalog: { revocations: [{ id: "revoked-device" }] } }
}

type AdmittedDelta = Awaited<ReturnType<typeof admittedDelta>>

async function admittedDelta() {
  stored.authority = null
  const profile = await bootstrapIdentity("Incremental frontier")
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Board", profile.identity.personId, "blank"))
  await recordGenesisAuthority(base, profile)
  const bundle = await exportDocumentAuthorizationBundle(base, profile)
  const admitted = await evaluateIncomingWorkspaceAdmission(base, base, bundle)
  const evidence = { bytes: admitted.rawBytes, decisions: admitted.decisions,
    authorizationEvidence: admitted.authorizationEvidence, admissionCheckpoint: admitted.admissionCheckpoint }
  const storage = new WorkspaceStorage()
  await storage.withWorkspaceTransaction(base.id, transaction => transaction.commitWorkspace(
    base, Automerge.save(base), admitted.verifiedAuthorizations, undefined, evidence))
  const installed = await storage.withWorkspaceTransaction(base.id, transaction => reusableDeltaAdmission(base, transaction, profile))
  if (!installed) throw new Error("admitted basis was not installed")
  const result = await executeCommand(base, { kind: "renameWorkspace", title: "Local edit" }, profile)
  if (!result.ok) throw new Error(result.error.message)
  const { newDoc, receipt } = result.value
  const changeBytes = Automerge.getLastLocalChange(newDoc)!
  const authorizations = await prepareLocalChangeAuthorizations(newDoc, profile, [receipt.changeHash])
  const { persistDeltaCommand } = await import("./stateDeltaAdmission")
  const saved = await storage.withWorkspaceTransaction(base.id, transaction => persistDeltaCommand(
    base, result.value, changeBytes, authorizations, profile, transaction, "owner"))
  if (!saved) throw new Error("local delta was not admitted")
  const loaded = await storage.loadWorkspaceDoc(base.id)
  const causal = await storage.loadCausalEvidence(base.id)
  if (!loaded || !causal?.admissionCheckpoint?.incremental) throw new Error("incremental evidence was not stored")
  return { storage, profile, id: base.id, base, local: loaded.doc, remote: Automerge.clone(loaded.doc),
    evidence: causal, authorization: await exportDocumentAuthorizationBundle(loaded.doc, profile),
    basis: await readWorkspaceBasisSnapshot(base.id) }
}

function release(admitted: AdmittedDelta) {
  Automerge.free(admitted.local)
  Automerge.free(admitted.remote)
  Automerge.free(admitted.base)
}
