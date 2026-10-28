import { expect, it } from "vitest"
import { BrowserIdentityStore, createDelegatedCertificate, createDeviceRevocation,
  createIdentityAuthorityView, emptyIdentityProfileState, verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import { certHashDefault } from "../domain/proofs"
import { createPeerAdvertisement } from "./meshRecords"
import { createDurablePeerHistoryGuard } from "./durablePeerHistoryGuard"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import type { PeerStore, WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"

it.each(["before-check", "during-authority-read"] as const)("Given a signed workspace peer and global revocation %s, when board authority remains unchanged, then deny further history disclosure on that existing session", async stage => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("History owner")
  const values = new Map<string, string>()
  const app = await new BrowserIdentityStore({ storageKey: "history-global-app", storage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } }).bootstrap("History app")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, app.device.deviceId, app.device.publicKey, await certHashDefault(owner.certificate))
  const certificates = [owner.certificate, certificate], state = emptyIdentityProfileState(owner.identity.personId)
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revoke = await createDeviceRevocation(owner, authority, app.device.deviceId, state)
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, state))
  const remote: LocalProfile = { ...app, identity: owner.identity, certificate }
  const bundle = await createPeerAdvertisement(remote, { workspaceId: "board", endpoint: "remote-endpoint",
    certificates: [certificate, owner.certificate], ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 1,
    updatedAt: new Date().toISOString() }
  const peer: WorkspacePeerRecord = { workspaceId: "board", personId: owner.identity.personId, deviceId: app.device.deviceId,
    endpoint: "remote-endpoint", role: "owner", advertisement: bundle, transportSecret: "secret", lastSeen: new Date().toISOString() }
  let armed = false, authorityReads = 0
  const store = { getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => {
    if (armed && ++authorityReads === 2) await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revoke] }, state))
    return credential
  },
    getPeer: async () => peer } as unknown as PeerStore
  const guard = createDurablePeerHistoryGuard({ workspaceId: "board", deviceId: peer.deviceId,
    remotePersonId: peer.personId, transportSecret: "secret", profile: owner, store,
    profileProvider: async () => owner, assertSession: () => {} })
  await expect(guard()).resolves.toBeUndefined()
  if (stage === "before-check") await mergeIdentityAuthorityView(await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revoke] }, state))
  else armed = true
  await expect(guard()).rejects.toThrow(/Identity.*(changed|revoked|unavailable)/i)
})
