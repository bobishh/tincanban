import { readLocal, writeLocal } from "../localDb"
import { withWorkspaceMutation } from "../workspaceMutation"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, renewDeviceIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceGrant } from "../domain/proofs"
import { createWorkspaceDeparture, verifyWorkspaceDeparture, createPeerAdvertisement, createWorkspaceDeviceRevocation, verifyWorkspaceDeviceRevocation } from "./meshRecords"
import { DurableMesh } from "./durableMesh"
import { hasLeftWorkspace, isDeviceRevoked } from "./durableMeshBase"
import { mergePeerRecords } from "@meta-uber/mesh-peer-store"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
beforeEach(() => resetIdentityStorageForTest())
async function identity(name: string) { resetIdentityStorageForTest(); return bootstrapIdentity(name) }
async function fixture() {
  const owner = await identity("Owner")
  const ownerRaw = (await readLocal("tincanban.local_profile.v1"))!
  const visitor = await identity("Visitor")
  const visitorRaw = (await readLocal("tincanban.local_profile.v1"))!
  const doc = Automerge.change(Automerge.init(), draft => { (draft as any).value = "workspace" })
  const bytes = Automerge.save(doc)
  const grant = await createWorkspaceGrant(owner, "board", visitor.identity.personId, "visitor")
  const bundle = await createPeerAdvertisement(visitor, { workspaceId: "board", endpoint: "endpoint", grant,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] })
  let credential: any = { version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "secret", epoch: 1,
    updatedAt: new Date().toISOString() }
  let peer: any = { workspaceId: "board", personId: visitor.identity.personId, deviceId: visitor.device.deviceId,
    role: "visitor", endpoint: "endpoint", transportSecret: "secret", lastSeen: bundle.advertisement.payload.issuedAt, advertisement: bundle }
  const store: any = { getPeer: async () => peer, listPeers: async () => [peer],
    getWorkspaceCredential: async () => credential, listWorkspaceCredentials: async () => [credential], getWorkspaceAuthority: async () => null,
    putWorkspaceCredential: async (value: any) => { credential = value },
    upsertPeer: async (value: any) => { peer = mergePeerRecords(peer, value); return peer } }
  const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {
    read: async () => bytes, readAuthorityHeads: async () => Automerge.getHeads(doc),
  } as never,
    store, getProfile: async () => owner })
  vi.spyOn(mesh as any, "notify").mockResolvedValue(undefined)
  vi.spyOn(mesh as any, "publishAll").mockResolvedValue(undefined)
  await writeLocal("tincanban.local_profile.v1", ownerRaw)
  clearInMemoryProfileForReloadTest()
  return { mesh, owner, visitor, bundle, store, credential: () => credential, peer: () => peer,
    activateVisitor: async () => { await writeLocal("tincanban.local_profile.v1", visitorRaw); clearInMemoryProfileForReloadTest() } }
}

describe("member access", () => {
  it("promotes a visitor with a signed owner grant and preserves promotion on a stale announcement", async () => {
    const f = await fixture()
    await f.mesh.promotePerson("board", f.visitor.identity.personId)
    expect(f.peer().role).toBe("editor")
    expect(f.peer().advertisement.grant.payload.role).toBe("editor")
    await (f.mesh as any).putVerifiedBundle(f.credential(), f.bundle)
    expect(f.peer().role).toBe("editor")
    await f.mesh.dispose()
  })
  it("Given a promotion, when publication needs the workspace lock, then durable rights commit before publication", async () => {
    const f = await fixture()
    const published = vi.mocked((f.mesh as unknown as { publishAll: () => Promise<void> }).publishAll).mockImplementation(() =>
      withWorkspaceMutation("board", async () => {
        expect(f.peer().advertisement.grant.payload.role).toBe("editor")
      }))
    await f.mesh.promotePerson("board", f.visitor.identity.personId)
    expect(published).toHaveBeenCalledOnce()
    await f.mesh.dispose()
  })
  it("removes only the chosen device and refuses its old signed advertisement on reconnect", async () => {
    const f = await fixture()
    await f.mesh.removeDevice(f.visitor.identity.personId, f.visitor.device.deviceId, ["board"])
    expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, f.visitor.device.deviceId)).toBe(true)
    expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, "another-device")).toBe(false)
    await expect((f.mesh as any).putVerifiedBundle(f.credential(), f.bundle)).rejects.toThrow("Device access revoked")
    await f.mesh.dispose()
  })
  it("Given a removed device, when a join is checked before owner approval, then its signed key is rejected without writes", async () => {
    const f = await fixture()
    await f.mesh.removeDevice(f.visitor.identity.personId, f.visitor.device.deviceId, ["board"])
    const write = vi.spyOn(f.store, "putWorkspaceCredential")
    await expect(f.mesh.checkGuestDevices(["board"], f.visitor.identity.personId, [f.bundle])).rejects.toThrow("Device access revoked")
    expect(write).not.toHaveBeenCalled()
    await f.activateVisitor()
    const other = await renewDeviceIdentity()
    expect(other.identity.personId).toBe(f.visitor.identity.personId)
    expect(other.device.deviceId).not.toBe(f.visitor.device.deviceId)
    const bundle = await createPeerAdvertisement(other, { workspaceId: "board", endpoint: "new-endpoint" })
    await expect(f.mesh.checkGuestDevices(["board"], other.identity.personId, [bundle])).resolves.toBe(other.device.deviceId)
    await expect(f.mesh.checkGuestDevices(["board"], f.owner.identity.personId, [bundle])).rejects.toThrow("does not match")
    const forged = structuredClone(bundle)
    forged.advertisement.payload.deviceId = "forged-device"
    await expect(f.mesh.checkGuestDevices(["board"], other.identity.personId, [forged])).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    await f.mesh.dispose()
  })
  it("rechecks an approved signed workspace grant and stops a live reader after person access is revoked", async () => {
    const f = await fixture()
    const grant = structuredClone(f.peer().advertisement.grant)
    await f.mesh.revokePerson("board", f.visitor.identity.personId)

    await expect(f.mesh.checkGuestDevices(["board"], f.visitor.identity.personId, [f.bundle], [grant]))
      .rejects.toThrow(/workspace access revoked/i)
    await f.mesh.dispose()
  })
  it("refuses expanding confirmed removal to an unauthorized workspace before writing", async () => {
    const f = await fixture()
    await expect(f.mesh.removeDevice(f.visitor.identity.personId, f.visitor.device.deviceId, ["board", "someone-elses-board"]))
      .rejects.toThrow("scope is no longer authorized")
    expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, f.visitor.device.deviceId)).toBe(false)
    await f.mesh.dispose()
  })
  it("accepts a self-issued device removal but rejects a stranger, a changed scope, or a forged signature", async () => {
    const owner = await identity("Owner"), member = await identity("Member"), stranger = await identity("Stranger")
    const removal = await createWorkspaceDeviceRevocation(member, "board", member.identity.personId, "old-device", ["head"], [member.certificate])
    expect(verifyWorkspaceDeviceRevocation(removal, "board", owner.identity.personId)).toEqual(removal)
    expect(() => verifyWorkspaceDeviceRevocation(removal, "other-board", owner.identity.personId)).toThrow()
    const unauthorized = await createWorkspaceDeviceRevocation(stranger, "board", member.identity.personId, "old-device", ["head"], [stranger.certificate])
    expect(() => verifyWorkspaceDeviceRevocation(unauthorized, "board", owner.identity.personId)).toThrow()
    const forged = structuredClone(removal)
    forged.record.payload.deviceId = "another-device"
    expect(() => verifyWorkspaceDeviceRevocation(forged, "board", owner.identity.personId)).toThrow()
  })
})

describe("leaving membership", () => {
  it("requires the owner to transfer ownership before leaving", async () => {
    const f = await fixture()
    await expect(f.mesh.leaveWorkspace("board")).rejects.toThrow("Transfer ownership")
    expect(f.credential().ownerPersonId).toBe(f.owner.identity.personId)
    await f.mesh.dispose()
  })
})

  it("a signed departure removes person membership until a newer owner-approved grant", async () => {
    const f = await fixture()
    const departure = await createWorkspaceDeparture(f.visitor, "board", 1, ["head"], [f.visitor.certificate])
    expect(verifyWorkspaceDeparture(departure, "board")).toEqual(departure)
    await (f.mesh as any).mergeDepartures(f.credential(), [departure])
    expect(hasLeftWorkspace(f.credential(), f.visitor.identity.personId, f.bundle.grant)).toBe(true)
    await expect((f.mesh as any).putVerifiedBundle(f.credential(), f.bundle)).rejects.toThrow("Workspace member is revoked")
    const renewed = await createWorkspaceGrant(f.owner, "board", f.visitor.identity.personId, "editor", 2)
    await (f.mesh as any).putVerifiedBundle(f.credential(), { ...f.bundle, grant: renewed })
    expect(hasLeftWorkspace(f.credential(), f.visitor.identity.personId, renewed)).toBe(false)
    const forged = structuredClone(departure)
    forged.record.payload.personId = f.owner.identity.personId
    expect(() => verifyWorkspaceDeparture(forged, "board")).toThrow()
    await f.mesh.dispose()
  })

  it("requires removal-aware peers before accepting a session, even before the first removal", async () => {
    const f = await fixture()
    await expect((f.mesh as any).mergeIncomingAuthority(f.credential(), { capabilities: ["iroh-gossip-v1", "automerge-sync-v1"] }))
      .rejects.toThrow("Peer does not support device revocations; update the app")
    expect(f.credential().catalog).toBeUndefined()
    await f.mesh.dispose()
  })

it("limits removal of another person's device to owned boards, while own devices include editor boards", async () => {
  const f = await fixture()
  const otherOwner = await identity("Another owner")
  const editorGrant = await createWorkspaceGrant(otherOwner, "third", f.owner.identity.personId, "editor")
  const credentials = [f.credential(), { ...f.credential(), workspaceId: "second" }, {
    ...f.credential(), workspaceId: "third", ownerPersonId: otherOwner.identity.personId,
    ownerPublicKey: otherOwner.identity.publicKey, ownerCertificates: [otherOwner.certificate], localGrant: editorGrant,
  }]
  f.store.listWorkspaceCredentials = async () => credentials
  f.store.getPeer = async (workspaceId: string) => ({ ...f.peer(), workspaceId })
  expect(await f.mesh.removableDeviceWorkspaces(f.visitor.identity.personId, f.visitor.device.deviceId)).toEqual(["board", "second"])
  f.store.getPeer = async (workspaceId: string) => ({ ...f.peer(), workspaceId, personId: f.owner.identity.personId })
  expect(await f.mesh.removableDeviceWorkspaces(f.owner.identity.personId, f.visitor.device.deviceId)).toEqual(["board", "second", "third"])
  await f.mesh.dispose()
})

it("retains removals for both identities when the same device key was enrolled into another person", async () => {
  const f = await fixture()
  const first = await createWorkspaceDeviceRevocation(f.owner, "board", f.visitor.identity.personId, f.visitor.device.deviceId, ["head"], [f.owner.certificate])
  const second = await createWorkspaceDeviceRevocation(f.owner, "board", "another-person", f.visitor.device.deviceId, ["head"], [f.owner.certificate])
  await (f.mesh as any).mergeDeviceRevocations(f.credential(), [first, second])
  expect(isDeviceRevoked(f.credential(), f.visitor.identity.personId, f.visitor.device.deviceId)).toBe(true)
  expect(isDeviceRevoked(f.credential(), "another-person", f.visitor.device.deviceId)).toBe(true)
  await f.mesh.dispose()
})
