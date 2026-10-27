import { beforeEach, expect, it } from "vitest"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, verifyEnvelope } from "../domain/identity"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant, defaultProofStore } from "../domain/proofs"
import { createPeerAdvertisement, createWorkspaceGrant as createMeshWorkspaceGrant, createWorkspaceDeparture, createWorkspaceDeviceRevocation, createWorkspaceSuccessionPolicy, createWorkspaceSuccessionVote } from "./meshRecords"
import { meshRecordSigning, workspaceRecordSigning } from "./meshRecordSigning"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"

beforeEach(() => resetIdentityStorageForTest())

it("Given unchanged owner authority, when the editor device list refreshes after signer preparation, then issuing a grant still succeeds", async () => {
  const owner = await bootstrapIdentity("Owner")
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "workspace", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1,
    transportSecret: "secret", updatedAt: new Date().toISOString() }
  let peers: Awaited<ReturnType<PeerStore["listPeers"]>> = []
  const signing = await meshRecordSigning(owner, credential, { kind: "owner" }, {
    getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => null, listPeers: async () => peers,
  })
  peers = [{ workspaceId: "workspace", personId: "editor", deviceId: "editor-device", endpoint: "endpoint",
    transportSecret: "secret", role: "editor", lastSeen: new Date().toISOString() }]
  const grant = await createMeshWorkspaceGrant(owner, "workspace", "visitor", "visitor", 1, signing)
  expect(await verifyEnvelope(grant, owner.device.publicKey)).toBe(true)
})

it("Given a prepared owner signer, when editor membership changes, then a succession policy with the old editor set is still rejected", async () => {
  const owner = await bootstrapIdentity("Owner")
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "workspace", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1,
    transportSecret: "secret", updatedAt: new Date().toISOString() }
  let peers: Awaited<ReturnType<PeerStore["listPeers"]>> = []
  const signing = await meshRecordSigning(owner, credential, { kind: "owner" }, {
    getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => null, listPeers: async () => peers,
  })
  peers = [{ workspaceId: "workspace", personId: "editor", deviceId: "editor-device", endpoint: "endpoint",
    transportSecret: "secret", role: "editor", lastSeen: new Date().toISOString() }]
  await expect(createWorkspaceSuccessionPolicy(owner, "workspace", null, [], 1, new Date().toISOString(), signing))
    .rejects.toThrow(/editor membership changed/i)
})

it("Given a visitor's valid membership, when leaving, then permit the participant signer without owner rights", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const visitor = await bootstrapIdentity("Visitor")
  const grant = await createWorkspaceGrant(owner, "workspace", visitor.identity.personId, "visitor")
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "workspace", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1,
    transportSecret: "secret", updatedAt: new Date().toISOString(), localGrant: grant }
  const signing = await meshRecordSigning(visitor, credential, { kind: "departure" }, {
    getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => null, listPeers: async () => [] })
  const record = await createWorkspaceDeparture(visitor, "workspace", 1, ["head"], [], signing)
  expect(record.authority.certificates).toEqual([visitor.certificate])
  expect(await verifyEnvelope(record.record, visitor.device.publicKey)).toBe(true)
})

it("Given a prepared participant signer, when its stored grant changes, then refuse the original action", async () => {
  const owner = await bootstrapIdentity("Owner")
  let revision = "approved"
  const signing = await workspaceRecordSigning(owner, "workspace", async () => revision, ["workspace-departure"])
  revision = "removed"
  await expect(signing.sign({ kind: "workspace-departure", workspaceId: "workspace" })).rejects.toThrow(/changed|stale/i)
})

it("Given authority advances while preparing an advertisement signer, when preparation retries, then sign against the fresh authority", async () => {
  const profile = await bootstrapIdentity("Owner")
  let reads = 0
  const signing = await workspaceRecordSigning(profile, "workspace", async () =>
    ++reads === 1 ? "before-refresh" : "after-refresh", ["peer-advertisement"])
  const record = await signing.sign({ kind: "peer-advertisement", workspaceId: "workspace" })
  expect(await verifyEnvelope(record, profile.device.publicKey)).toBe(true)
})

it("Given authority never stabilizes during signer preparation, when preparation runs, then fail within a bounded read budget", async () => {
  const profile = await bootstrapIdentity("Owner")
  let reads = 0
  await expect(workspaceRecordSigning(profile, "workspace", async () => {
    if (++reads > 10) throw new Error("Authority read budget exceeded")
    return String(reads)
  }, ["peer-advertisement"]))
    .rejects.toThrow("Workspace record authority changed while signing")
  expect(reads).toBeLessThanOrEqual(10)
})

it("Given authority is revoked during signer preparation, when the store rejects access, then preserve that rejection without retry", async () => {
  const profile = await bootstrapIdentity("Owner")
  let reads = 0
  await expect(workspaceRecordSigning(profile, "workspace", async () => {
    if (++reads > 1) throw new Error("Device access revoked")
    return "approved"
  }, ["peer-advertisement"])).rejects.toThrow("Device access revoked")
  expect(reads).toBe(2)
})

it("Given an identity-only advertisement signer, when asked to sign an owner action or another scope, then refuse", async () => {
  const profile = await bootstrapIdentity("Joining device")
  const signing = await workspaceRecordSigning(profile, "workspace", async () => "unjoined-route", ["peer-advertisement"])
  await expect(signing.sign({ kind: "workspace-revocation", workspaceId: "workspace" })).rejects.toThrow(/purpose/i)
  await expect(signing.sign({ kind: "peer-advertisement", workspaceId: "another" })).rejects.toThrow(/scope/i)
})

it("Given an enrolled device, when issuing a route, then require its ancestor and bundle the complete unchanged chain", async () => {
  const issuer = await bootstrapIdentity("Issuer")
  resetIdentityStorageForTest()
  const temporary = await bootstrapIdentity("New device")
  const certificate = await createDelegatedCertificate(issuer.privateKeys.devicePrivateKey, issuer.device.deviceId,
    issuer.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(issuer.certificate))
  const device = await adoptEnrolledIdentity(issuer.identity, certificate)
  await expect(workspaceRecordSigning(device, "workspace", async () => "joining", ["peer-advertisement"]))
    .rejects.toThrow(/ancestor|chain|certificate/i)
  await defaultProofStore.putCertificate(await certHashDefault(issuer.certificate), issuer.certificate)
  const signing = await workspaceRecordSigning(device, "workspace", async () => "joining", ["peer-advertisement"])
  const route = await createPeerAdvertisement(device, "workspace", "endpoint", { signing })
  expect(route.certificates).toEqual([certificate, issuer.certificate])
  expect(device.certificate).toEqual(certificate)
  expect(await verifyEnvelope(route.advertisement, temporary.device.publicKey)).toBe(true)
})

it("Given an editor in the current voting policy, when voting, then retain editor authority and full signer evidence", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const editor = await bootstrapIdentity("Editor")
  const grant = await createWorkspaceGrant(owner, "workspace", editor.identity.personId, "editor")
  const policy = await createWorkspaceSuccessionPolicy(owner, "workspace", null, [editor.identity.personId, "candidate"].sort(), 1)
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "workspace", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1, transportSecret: "secret",
    updatedAt: new Date().toISOString(), localGrant: grant, catalog: { successionPolicy: policy, successionVotes: [] } }
  const signing = await meshRecordSigning(editor, credential, { kind: "vote", candidatePersonId: "candidate" }, {
    getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => null, listPeers: async () => [] })
  const vote = await createWorkspaceSuccessionVote(editor, policy, "candidate", grant, new Date().toISOString(), [], signing)
  expect(vote.voterCertificates).toEqual([editor.certificate])
  expect(await verifyEnvelope(vote.signed, editor.device.publicKey)).toBe(true)
})

it("Given an editor removing another device of the same person, when signing, then preserve that right and refuse a different target", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const editor = await bootstrapIdentity("Editor")
  const grant = await createWorkspaceGrant(owner, "workspace", editor.identity.personId, "editor")
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "workspace", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1, transportSecret: "secret",
    updatedAt: new Date().toISOString(), localGrant: grant }
  const signing = await meshRecordSigning(editor, credential, { kind: "device-revocation", personId: editor.identity.personId,
    deviceId: "other-device" }, { getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => null,
    listPeers: async () => [{ workspaceId: "workspace", deviceId: "other-device", personId: editor.identity.personId,
      endpoint: "endpoint", transportSecret: "secret", role: "editor", lastSeen: new Date().toISOString() }] })
  const removed = await createWorkspaceDeviceRevocation(editor, "workspace", editor.identity.personId, "other-device", ["head"], [], signing)
  expect(await verifyEnvelope(removed.record, editor.device.publicKey)).toBe(true)
  await expect(createWorkspaceDeviceRevocation(editor, "workspace", "another-person", "other-device", ["head"], [], signing))
    .rejects.toThrow(/authorized target/i)
})
