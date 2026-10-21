import { beforeEach, expect, it } from "vitest"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPeerAdvertisement, createWorkspaceGrant } from "./meshRecords"
import { createDurablePeerHistoryGuard } from "./durablePeerHistoryGuard"
import type { PeerStore, WorkspaceAuthorityRecord, WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"

beforeEach(() => resetIdentityStorageForTest())

async function fixture(forged: boolean) {
  const owner = await bootstrapIdentity()
  const values = new Map<string, string>()
  const editor = await new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) },
  } }).bootstrap("Editor")
  const grant = await createWorkspaceGrant(owner, "board", editor.identity.personId, "editor")
  const previous = await createPeerAdvertisement(owner, { workspaceId: "board", endpoint: "old-route", instanceId: "owner-tab-a" })
  const refreshed = await createPeerAdvertisement(owner, { workspaceId: "board", endpoint: "new-route", instanceId: "owner-tab-b" })
  if (forged) refreshed.advertisement.signature = Buffer.alloc(64, 1).toString("base64url")
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 1,
    localGrant: grant, updatedAt: new Date().toISOString() }
  const authority: WorkspaceAuthorityRecord = { ...credential }
  let peerReads = 0
  const store = { getWorkspaceCredential: async () => structuredClone(credential), getWorkspaceAuthority: async () => structuredClone(authority),
    getPeer: async () => {
      const selected = ++peerReads === 1 ? previous : refreshed
      return { workspaceId: "board", deviceId: owner.device.deviceId, personId: owner.identity.personId, role: "owner",
        transportSecret: "secret", endpoint: selected.advertisement.payload.endpoint, instanceId: selected.advertisement.payload.instanceId,
        lastSeen: selected.advertisement.payload.issuedAt, advertisement: selected } as WorkspacePeerRecord
    } } as unknown as PeerStore
  return createDurablePeerHistoryGuard({ workspaceId: "board", deviceId: owner.device.deviceId, remotePersonId: owner.identity.personId,
    transportSecret: "secret", profile: editor, store, profileProvider: async () => editor, assertSession: () => {} })
}

it("Given a real owner-signed route refresh on an authenticated editor channel, when history authorization spans that refresh, then validate the new signature and keep access", async () => {
  const guard = await fixture(false)
  await expect(guard()).resolves.toBeUndefined()
})

it("Given a tampered route replacing a real signed advertisement, when history authorization spans that refresh, then reject its invalid signature", async () => {
  const guard = await fixture(true)
  await expect(guard()).rejects.toThrow()
})
