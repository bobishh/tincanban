import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { createWorkspaceOwnershipTransfer } from "@meta-uber/mesh-workspace"
import { admitWorkspaceHistoryRecovery, recoveryProjectionAccess } from "./workspaceHistoryRecoveryAdmission"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
async function fixture() {
  const owner = await bootstrapIdentity("History recovery Owner")
  const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Signed board", owner.identity.personId, "blank"))
  const identity = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  const authority = { genesisOwner: identity, currentOwner: identity, genesisEpoch: 1, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, { kind: "workspace-changes", version: 1,
    workspaceId: doc.id, hashes: Automerge.getChangesMetaSince(doc, []).map(change => change.hash), personId: identity.personId,
    deviceId: owner.device.deviceId }, owner.device.deviceId)
  const authorization = { version: 1, authority, records: [{ signed, publicKey: identity.publicKey, certificates: identity.certificates,
    ownerPublicKey: identity.publicKey, ownerCertificates: identity.certificates }] }
  const snapshot = { id: doc.id, workspaceId: doc.id, title: "Untrusted cached title", heads: ["invented"], bytes: Automerge.save(doc),
    causalEvidence: { bytes: Automerge.save(doc), decisions: [{ hash: "invented", status: { type: "admitted", role: "owner" } }],
      admissionCheckpoint: { forged: true } }, savedAt: "2026-10-15T00:00:00.000Z" }
  const changeBytes = Automerge.getAllChanges(doc)[0]!, changeHash = Automerge.decodeChange(changeBytes).hash
  const proof = await signEnvelope(owner.privateKeys.devicePrivateKey, { kind: "change-proof", version: 1,
    documentId: doc.id, changeHash, actorBindingHash: "A".repeat(43) }, owner.device.deviceId)
  const receipt = { transactionId: "original-recovery-transaction", beforeHeads: [], afterHeads: Automerge.getHeads(doc),
    changeHash, changedEntityIds: [], saved: true }
  const journal: WorkspaceRecoveryJournal = { snapshots: [{ id: doc.id, value: snapshot }], authorizations: [], changes: [],
    archivedChanges: [], archivedAuthorizations: [], proofs: [], receipts: [],
    frontiers: [{ id: doc.id, value: { id: doc.id, workspaceId: doc.id, stale: true } }],
    deltas: [{ id: "stale", value: { id: "stale", workspaceId: doc.id, savedAt: snapshot.savedAt,
      command: { receipt, changeBytes, proof } } }], receivedBaselines: [], revisions: [] }
  const auxiliary = new Map<string, unknown>([["workspace-source/raw", Automerge.save(doc)], ["workspace-control/access", { authorization, authority: null, credential: null }]])
  return { owner, doc, authority, authorization, journal, auxiliary, input: { workspaceId: doc.id,
    decoded: { journal, auxiliary }, records: [], currentAuthority: null, ensureCurrent: () => {} } }
}
it("Given valid signed source and forged cached decisions, when preflighting recovery, then rebuild admitted projection and clear active deltas without changing originals", async () => {
  const f = await fixture(), original = structuredClone(f.journal)
  const result = await admitWorkspaceHistoryRecovery(f.input)
  expect(result.snapshot.title).toBe("Signed board")
  expect(result.snapshot.heads).toEqual(Automerge.getHeads(f.doc))
  expect(result.snapshot.causalEvidence?.bytes).toEqual(f.auxiliary.get("workspace-source/raw"))
  expect(result.snapshot.causalEvidence?.decisions.some(decision => decision.hash === "invented")).toBe(false)
  expect(result.snapshot.causalEvidence?.admissionCheckpoint).toBeUndefined()
  expect(result.journal.deltas).toEqual([])
  expect(result.journal.frontiers).toEqual([])
  expect(result.journal.receipts).toHaveLength(1)
  expect(result.journal.receipts[0]!.id).toBe(`${f.doc.id}:original-recovery-transaction`)
  expect(result.journal.changes).toHaveLength(1)
  expect(f.journal).toEqual(original)
  Automerge.free(f.doc)
})
it("Given AEAD-readable bytes without causal signatures, when preflighting recovery, then reject the unauthenticated genesis", async () => {
  const f = await fixture()
  f.authorization.records[0]!.signed.signature = "A".repeat(86)
  await expect(admitWorkspaceHistoryRecovery(f.input)).rejects.toThrow(/admitted|genesis|workspace|signature/i)
  Automerge.free(f.doc)
})
it("Given a later admitted ownership transfer, when restoring an older backup, then preserve current control instead of reinstalling its old Owner", async () => {
  const f = await fixture(); resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Recovery successor")
  const target = { personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate] }
  const heads = Automerge.getHeads(f.doc)
  const transferHeads = heads.length ? heads : [Automerge.decodeChange(Automerge.getAllChanges(f.doc)[0]!).hash]
  const transfer = await createWorkspaceOwnershipTransfer(f.owner, f.doc.id, target, transferHeads, 2)
  const result = await admitWorkspaceHistoryRecovery({ ...f.input, currentAuthority: { ...f.authority, currentOwner: target,
    currentEpoch: 2, ownershipTransfers: [transfer] } })
  expect(result.authority.currentOwner.personId).toBe(target.personId)
  expect(result.authority.currentEpoch).toBe(2)
  expect(result.authority.ownershipTransfers).toContainEqual(transfer)
  Automerge.free(f.doc)
})
it("Given a compact snapshot with no matching encrypted archive source, when preflighting, then refuse its saved host verification flags", async () => {
  const f = await fixture()
  const row = f.journal.snapshots[0]!.value as Record<string, unknown>
  row.receivedHistory = { baselineId: "A".repeat(43), excludedLocalChangeHashes: [] }
  f.journal.receivedBaselines.push({ id: "staged", value: { id: "staged", workspaceId: f.doc.id,
    state: "active", baselineId: "A".repeat(43), verified: true } })
  await expect(admitWorkspaceHistoryRecovery(f.input)).rejects.toThrow(/basis|baseline|authority|archive|signed/i)
  Automerge.free(f.doc)
})
it("Given a peer-only compact backup with signed scope but forged proof packet, when preflighting without Rusty keys, then reject Native peer evidence instead of falling back to a private storage config", async () => {
  const f = await fixture()
  const genesis = await signEnvelope(f.owner.privateKeys.devicePrivateKey, { kind: "scope-genesis", version: 1,
    scopeId: f.doc.id, creator: f.authority.genesisOwner, controlEpoch: 1 }, f.owner.device.deviceId)
  f.auxiliary.set("workspace-control/access", { authorization: f.authorization, credential: null,
    authority: { scopeAuthoritySnapshot: { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] } } })
  const snapshot = f.journal.snapshots[0]!.value as Record<string, unknown>
  snapshot.receivedHistory = { baselineId: "A".repeat(43), excludedLocalChangeHashes: [] }
  f.journal.receivedBaselines.push({ id: "peer-basis", value: { id: "peer-basis", workspaceId: f.doc.id, state: "active",
    baselineId: "A".repeat(43), signedJson: new TextEncoder().encode("{}"), document: Automerge.save(f.doc),
    pinnedStorage: {}, peerProofs: { version: 1, objects: [] }, encryptedObjects: [] } })
  await expect(admitWorkspaceHistoryRecovery(f.input)).rejects.toThrow(/peer.*bootstrap|peer.*proof|peer.*routing|peer.*envelope.*malformed/i)
  Automerge.free(f.doc)
})
it("Given a changed session or another workspace source, when preflighting recovery, then fail before returning activatable rows", async () => {
  const f = await fixture()
  await expect(admitWorkspaceHistoryRecovery({ ...f.input, ensureCurrent: () => { throw new Error("Identity changed") } })).rejects.toThrow("Identity changed")
  const other = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("different", "Other", f.owner.identity.personId, "blank"))
  f.auxiliary.set("workspace-source/raw", Automerge.save(other))
  await expect(admitWorkspaceHistoryRecovery(f.input)).rejects.toThrow(/workspace/i)
  Automerge.free(other); Automerge.free(f.doc)
})

it("Given backup genesis substituted by another signed identity, when current authority is known, then reject the root rather than overwrite current rights", async () => {
  const f = await fixture(); resetIdentityStorageForTest(); const other = await bootstrapIdentity("Substituted recovery root")
  const identity = { personId: other.identity.personId, publicKey: other.identity.publicKey, certificates: [other.certificate] }
  const bad = structuredClone(f.authorization)
  bad.authority.genesisOwner = identity
  bad.authority.currentOwner = identity
  f.auxiliary.set("workspace-control/access", { authorization: bad, authority: null, credential: null })
  await expect(admitWorkspaceHistoryRecovery({ ...f.input, currentAuthority: f.authority })).rejects.toThrow(/owner|genesis|authority|conflict|root/i)
  Automerge.free(f.doc)
})
it("Given a scope snapshot inside the decrypted backup has a forged signature, when recovering offline without current authority, then reject rather than trusting file encryption", async () => {
  const f = await fixture()
  const genesis = await signEnvelope(f.owner.privateKeys.devicePrivateKey, { kind: "scope-genesis", version: 1,
    scopeId: f.doc.id, creator: f.authority.genesisOwner, controlEpoch: 1 }, f.owner.device.deviceId)
  genesis.signature = "A".repeat(86)
  f.auxiliary.set("workspace-control/access", { authorization: f.authorization, credential: null,
    authority: { scopeAuthoritySnapshot: { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] } } })
  await expect(admitWorkspaceHistoryRecovery(f.input)).rejects.toThrow()
  Automerge.free(f.doc)
})

it("Given a stale backup credential and current signed Owner transfer, when preparing projections, then retain current transport and all admitted control", async () => {
  const f = await fixture(); resetIdentityStorageForTest(); const successor = await bootstrapIdentity("Projection successor")
  const target = { personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate] }
  const heads = Automerge.getHeads(f.doc)
  const transferHeads = heads.length ? heads : [Automerge.decodeChange(Automerge.getAllChanges(f.doc)[0]!).hash]
  const transfer = await createWorkspaceOwnershipTransfer(f.owner, f.doc.id, target, transferHeads, 2)
  const current = { ...f.authority, currentOwner: target, currentEpoch: 2, ownershipTransfers: [transfer] }
  const admitted = await admitWorkspaceHistoryRecovery({ ...f.input, currentAuthority: current })
  const old = { version: 1 as const, workspaceId: f.doc.id, ownerPersonId: f.owner.identity.personId,
    ownerPublicKey: f.owner.identity.publicKey, ownerCertificates: [f.owner.certificate], epoch: 1,
    updatedAt: "2026-10-14T00:00:00.000Z", transportSecret: "old-transport-secret" }
  const access = recoveryProjectionAccess(admitted, current, { authority: old, credential: old }, { ...old, transportSecret: "current-transport-secret" })
  expect(access.authority.ownerPersonId).toBe(target.personId)
  expect(access.authority.epoch).toBe(2)
  expect(access.authority.genesisOwnerPersonId).toBe(f.owner.identity.personId)
  expect(access.authority.catalog).toMatchObject({ ownershipTransfers: [transfer] })
  expect(access.credential).toMatchObject({ ownerPersonId: target.personId, epoch: 2, transportSecret: "current-transport-secret" })
  expect(access.authority.ownerHistory).toContainEqual(f.authority.genesisOwner)
  expect(recoveryProjectionAccess(admitted, current, { authority: old, credential: old }, { ...old, transportSecret: "current-transport-secret" })).toEqual(access)
  Automerge.free(f.doc)
})
