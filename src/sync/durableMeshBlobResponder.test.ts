import { createDelegatedCertificate, createDeviceRevocation, createIdentityAuthorityView, emptyIdentityProfileState, verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { afterEach, expect, it, vi } from "vitest"
import { BLOB_REQUEST_FRAME, BLOB_RESPONSE_FRAME, createBlobDescriptor, createBlobRequest } from "@meta-uber/mesh-blob"
import { encodePairingFrame, inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { certHashDefault, createWorkspaceGrant } from "../domain/proofs"
import { createPeerAdvertisement, createWorkspaceDeviceRevocation, createWorkspaceRevocation } from "./meshRecords"
import { respondToCurrentBlobRequest } from "./durableMeshBlobFetch"
import { createDurablePeerHistoryGuard } from "./durablePeerHistoryGuard"
import type { PeerStore, WorkspaceMeshCredential } from "./peerStore"

afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function fixture(samePersonApp = false) {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Blob owner")
  resetIdentityStorageForTest()
  let remote = await bootstrapIdentity("Blob requester")
  if (samePersonApp) {
    const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, remote.device.deviceId, remote.device.publicKey, await certHashDefault(owner.certificate))
    remote = { ...remote, identity: owner.identity, certificate }
  }
  const certificates = samePersonApp ? [owner.certificate, remote.certificate] : [remote.certificate]
  const workspaceId = crypto.randomUUID(), secret = "retained-private-transport-secret"
  const grant = samePersonApp ? undefined : await createWorkspaceGrant(owner, workspaceId, remote.identity.personId, "editor", 1)
  const bundle = await createPeerAdvertisement(remote, workspaceId, "remote-endpoint", { grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], certificates, instanceId: "remote-instance" })
  let credential: WorkspaceMeshCredential = { version: 1, workspaceId, ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: secret,
    epoch: 1, updatedAt: new Date().toISOString(), catalog: { deviceRevocations: [], revocations: [] } }
  const peer = { workspaceId, deviceId: remote.device.deviceId, personId: remote.identity.personId, endpoint: "remote-endpoint",
    transportSecret: secret, role: samePersonApp ? "owner" : "editor", revokedAt: null, lastSeen: new Date().toISOString(), advertisement: bundle }
  const store = { getPeer: async () => peer, getWorkspaceCredential: async () => credential, getWorkspaceAuthority: async () => null,
    listWorkspaceCredentials: async () => [credential], listWorkspaceAuthorities: async () => [], listPeers: async () => [peer] }
  let current = true
  const guard = createDurablePeerHistoryGuard({ workspaceId, deviceId: remote.device.deviceId, remotePersonId: remote.identity.personId,
    transportSecret: secret, profile: owner, profileProvider: async () => owner, store: store as unknown as PeerStore,
    assertSession: () => { if (!current) throw new Error("Direct peer session is no longer current") } })
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]), descriptor = await createBlobDescriptor(bytes, "private.bin", "application/octet-stream")
  const blob = { resolve: vi.fn(async () => descriptor), read: vi.fn(async (): Promise<Uint8Array> => bytes) }
  const request = await createBlobRequest(remote, workspaceId, descriptor.blobId, 0)
  const frame = encodePairingFrame(BLOB_REQUEST_FRAME, secret, new TextEncoder().encode(JSON.stringify(request)))
  const frames: Uint8Array[] = []
  const stream = { send: vi.fn(async (frame: Uint8Array) => { frames.push(frame) }), closeSend: vi.fn(async () => {}) }
  const respond = () => respondToCurrentBlobRequest({ workspaceId, deviceId: remote.device.deviceId, secret,
    blob, store: store as never, ensureCurrent: guard }, stream, frame)
  return { owner, remote, workspaceId, blob, bytes, frames, respond, guard,
    revokeDevice: async (local = false) => {
      const profile = local ? owner : remote
      const record = await createWorkspaceDeviceRevocation(owner, workspaceId, profile.identity.personId,
        profile.device.deviceId, ["retained-history-head"], [owner.certificate])
      credential = { ...credential, catalog: { deviceRevocations: [record] } }
    },
    revokeGrant: async () => { credential = { ...credential, catalog: { revocations: [await createWorkspaceRevocation(owner,
      workspaceId, remote.identity.personId, 2, ["retained-history-head"])] } } },
    replaceSession: () => { current = false },
  }
}

it("Given an authorized signed blob request, when its live scope remains current, then send verified private bytes", async () => {
  const f = await fixture()
  await f.respond()
  expect(f.frames.map(frame => inspectPairingFrame(frame).type)).toContain(BLOB_RESPONSE_FRAME)
})

for (const change of ["remote-device", "local-device", "grant", "session"] as const) {
  it(`Given a signed blob request pauses during its private read, when ${change} authority changes, then send no private response`, async () => {
    const f = await fixture()
    let release!: (bytes: Uint8Array) => void, started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    const bytes = new Promise<Uint8Array>(resolve => { release = resolve })
    f.blob.read.mockImplementationOnce(() => { started(); return bytes })
    try {
      await f.guard()
      const pending = f.respond().catch(error => error)
      await reading
      if (change === "session") f.replaceSession()
      else if (change === "grant") await f.revokeGrant()
      else await f.revokeDevice(change === "local-device")
      await expect(f.guard()).rejects.toThrow()
      release(f.bytes)
      await pending
      expect(f.frames.filter(frame => inspectPairingFrame(frame).type === BLOB_RESPONSE_FRAME)).toHaveLength(0)
    } finally { release(f.bytes) }
  })
}

it("Given a same-person app pauses its signed blob read, when a learned global Identity revocation arrives, then send no private bytes on its retained workspace session", async () => {
  const f = await fixture(true), certificates = [f.owner.certificate, f.remote.certificate]
  const state = emptyIdentityProfileState(f.owner.identity.personId)
  const authority = await verifyIdentityDeviceAuthority(f.owner.identity, { certificates, revocations: [] })
  await mergeIdentityAuthorityView(await createIdentityAuthorityView(f.owner.identity, { certificates, revocations: [] }, state))
  let release!: (bytes: Uint8Array) => void, started!: () => void
  const reading = new Promise<void>(resolve => { started = resolve }), bytes = new Promise<Uint8Array>(resolve => { release = resolve })
  f.blob.read.mockImplementationOnce(() => { started(); return bytes })
  try {
    await f.guard()
    const pending = f.respond().catch(error => error)
    await reading
    const revoke = await createDeviceRevocation(f.owner, authority, f.remote.device.deviceId, state)
    await mergeIdentityAuthorityView(await createIdentityAuthorityView(f.owner.identity, { certificates, revocations: [revoke] }, state))
    await expect(f.guard()).rejects.toThrow(/Identity.*(changed|revoked|unavailable)/i)
    release(f.bytes)
    await pending
    expect(f.frames.filter(frame => inspectPairingFrame(frame).type === BLOB_RESPONSE_FRAME)).toHaveLength(0)
  } finally { release(f.bytes) }
})
