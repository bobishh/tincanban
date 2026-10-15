import { IDBFactory } from "fake-indexeddb"
import { expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import { DurableMesh } from "./durableMesh"
import { PeerStore, type WorkspaceMeshCredential } from "./peerStore"
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
