import { IDBFactory } from "fake-indexeddb"
import { expect, it } from "vitest"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "../domain/identity"
import { DurableMesh } from "./durableMesh"
import { PeerStore, type WorkspaceMeshCredential } from "./peerStore"
import { certHashDefault, createDelegatedCertificate, createWorkspaceGrant } from "../domain/proofs"
import { verifyWorkspaceGrant } from "./meshRecords"
import { meshRecordSigning } from "./meshRecordSigning"

it("Given owner certificate refresh is merged by durable storage, when preparing its route signer, then use the persisted authority projection", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner refresh")
  const store = new PeerStore(`owner-refresh-${crypto.randomUUID()}`, new IDBFactory())
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "board", ownerPersonId: profile.identity.personId,
    ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate], transportSecret: "secret", epoch: 1,
    updatedAt: new Date(0).toISOString(), localGrant: null }
  await store.putWorkspaceCredential(credential)
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    getProfile: async () => profile, store })
  const refresh = mesh as unknown as { refreshOwnerCertificates: (credential: WorkspaceMeshCredential,
    profile: LocalProfile, certificates: LocalProfile["certificate"][]) => Promise<WorkspaceMeshCredential> }
  const refreshed = await refresh.refreshOwnerCertificates(credential, profile, [profile.certificate])
  expect(refreshed).toEqual(await store.getWorkspaceCredential("board"))
  await expect(meshRecordSigning(profile, refreshed, { kind: "advertisement" }, store)).resolves.toBeDefined()
  await mesh.dispose()
})

async function delegatedAuthorityFixture() {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Original owner")
  resetIdentityStorageForTest()
  const fresh = await bootstrapIdentity("Delegated owner")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, fresh.device.deviceId, fresh.device.publicKey, await certHashDefault(owner.certificate))
  const delegated = await adoptEnrolledIdentity(owner.identity, certificate)
  const store = new PeerStore(`delegated-grant-${crypto.randomUUID()}`, new IDBFactory())
  const workspaceId = "delegated-board"
  const creator = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  const genesis = await signEnvelope(owner.privateKeys.devicePrivateKey, { kind: "scope-genesis", version: 1,
    scopeId: workspaceId, creator, controlEpoch: 1 }, owner.device.deviceId)
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 1,
    updatedAt: new Date(0).toISOString() }
  await store.putWorkspaceCredential(credential)
  const authority = (await store.getWorkspaceAuthority(workspaceId))!
  const scopeAuthoritySnapshot = { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] }
  await store.putWorkspaceAuthority({ ...authority, scopeAuthoritySnapshot })
  await store.putWorkspaceCredential({ ...credential, ownerCertificates: [owner.certificate, delegated.certificate],
    updatedAt: new Date().toISOString() })
  return { owner, delegated, store, workspaceId, scopeAuthoritySnapshot }
}

it("Given immutable scope genesis and a later enrolled owner device, when durable authority projects its new editor grant, then retain the signed owner device chain", async () => {
  const { owner, delegated, store, workspaceId, scopeAuthoritySnapshot } = await delegatedAuthorityFixture()
  const grant = await createWorkspaceGrant(delegated, workspaceId, "editor-person", "editor")
  const projected = (await store.getWorkspaceAuthority(workspaceId))!
  expect(projected.ownerCertificates).toContainEqual(delegated.certificate)
  await expect(verifyWorkspaceGrant(grant, { workspaceId, personId: "editor-person", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: projected.ownerCertificates as LocalProfile["certificate"][] })).resolves.toBe("editor")
  expect(projected.scopeAuthoritySnapshot).toEqual(scopeAuthoritySnapshot)
})

it("Given unrelated or forged device certificate evidence, when the pinned scope authority is projected, then it cannot authorize another issuer", async () => {
  const { owner, store, workspaceId, scopeAuthoritySnapshot } = await delegatedAuthorityFixture()
  resetIdentityStorageForTest()
  const stranger = await bootstrapIdentity("Unrelated issuer")
  const before = (await store.getWorkspaceAuthority(workspaceId))!
  const forgedCertificate = { ...stranger.certificate, payload: { ...stranger.certificate.payload, personId: owner.identity.personId } }
  await store.putWorkspaceAuthority({ ...before, ownerCertificates: [...before.ownerCertificates, stranger.certificate, forgedCertificate],
    updatedAt: new Date(Date.now() + 1).toISOString() })
  const projected = (await store.getWorkspaceAuthority(workspaceId))!
  expect(projected.ownerPersonId).toBe(owner.identity.personId)
  expect(projected.ownerPublicKey).toBe(owner.identity.publicKey)
  expect(projected.ownerCertificates).not.toContainEqual(stranger.certificate)
  expect(projected.scopeAuthoritySnapshot).toEqual(scopeAuthoritySnapshot)
  const grant = await createWorkspaceGrant(stranger, workspaceId, "editor-person", "editor")
  await expect(verifyWorkspaceGrant(grant, { workspaceId, personId: "editor-person", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: projected.ownerCertificates as LocalProfile["certificate"][] })).rejects.toThrow()
})
