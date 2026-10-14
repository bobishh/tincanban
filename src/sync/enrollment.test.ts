import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { InvitationService, resetInvitationStorageForTest } from "./invitations"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { createEnrollmentRequest, enrollmentPayload, installEnrollment, preflightEnrollment, readEnrollmentRequest } from "./enrollment"
import { defaultStorage } from "../storage"
import { verifyDeviceChain } from "./meshRecords"

vi.mock("../storage", () => ({ defaultStorage: { loadPersonalRoot: vi.fn(async () => null), savePersonalRoot: vi.fn(async () => {}) } }))

async function fixture(photo?: { avatarData: string | null; changedAt: string }) {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const guest = await bootstrapIdentity("New device")
  const service = new InvitationService()
  const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
  await service.saveIssuedInvitation(invite)
  await service.claimInvitation(invite.invitationId, guest.device.deviceId)
  const result = await service.approveEnrollment(invite.invitationId, guest.device, owner)
  if (!result.ok) throw new Error(result.error)
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  root.displayNamePreset = "Owner preset"
  if (photo) root.photo = photo
  const bytes = await enrollmentPayload(invite, owner, result.certificate, root, [{ id: "ws", title: "Board" }],
    "ws", [{ workspaceId: "ws", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey, optionalMeshField: undefined }], [], new TextEncoder().encode("[]"))
  return { owner, guest, service, invite, bytes, certificate: result.certificate }
}

beforeEach(() => { resetIdentityStorageForTest(); resetInvitationStorageForTest() })

describe("device enrollment boundary", () => {
  it("Given an owner photo, when a phone enrolls, then its personal catalog retains that photo", async () => {
    const photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-10-14T07:00:00.000Z" }
    const { guest, invite, bytes } = await fixture(photo)
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    expect(enrolled.personalRoot.photo).toEqual(photo)
  })
  it("rejects replacement of another identity without explicit consent before writing anything", async () => {
    const { guest, invite, bytes } = await fixture()
    vi.mocked(defaultStorage.savePersonalRoot).mockClear()
    await expect(installEnrollment(bytes, invite, guest)).rejects.toThrow("Identity conflict")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
    expect(defaultStorage.savePersonalRoot).not.toHaveBeenCalled()
  })

  it("preserves an existing target identity's local root entries during enrollment", async () => {
    const { owner, guest, invite, bytes } = await fixture()
    const localRoot = createPersonalRoot(owner, await certHashDefault(owner.certificate))
    localRoot.workspaces.local = { workspaceId: "local", documentId: "local", grantHash: "local-proof", forgotten: false }
    vi.mocked(defaultStorage.loadPersonalRoot).mockResolvedValueOnce(localRoot)
    const result = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    expect(result.personalRoot.rootId).toBe(localRoot.rootId)
    expect(result.personalRoot.workspaces.local).toEqual(localRoot.workspaces.local)
    expect(defaultStorage.savePersonalRoot).toHaveBeenLastCalledWith(result.personalRoot)
  })

  it("requires possession of the requested device key and binds requests to an invitation", async () => {
    const { guest, invite } = await fixture()
    const bytes = await createEnrollmentRequest(invite, guest)
    expect((await readEnrollmentRequest(bytes, invite)).deviceId).toBe(guest.device.deviceId)
    await expect(readEnrollmentRequest(bytes, { ...invite, invitationId: "different" })).rejects.toThrow("Invalid")
    const forged = JSON.parse(new TextDecoder().decode(bytes))
    forged.payload.displayName = "Forged"
    await expect(readEnrollmentRequest(new TextEncoder().encode(JSON.stringify(forged)), invite)).rejects.toThrow("Invalid")
  })

  it("persists the approved identity and device certificate without copying a root private key", async () => {
    const { owner, guest, invite, bytes } = await fixture()
    await installEnrollment(bytes, invite, guest, guest.identity.personId)
    clearInMemoryProfileForReloadTest()
    const restored = await bootstrapIdentity()
    expect(restored.identity.personId).toBe(owner.identity.personId)
    expect(restored.device.deviceId).toBe(guest.device.deviceId)
    expect(restored.privateKeys.identityPrivateKey).toBeUndefined()
    expect(await verifyDeviceChain({ personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      deviceId: guest.device.deviceId, certificates: [restored.certificate, ...await defaultProofStore.listCertificates()] })).toBe(guest.device.publicKey)
  })

  it("carries the sender's active workspace for the enrolled device", async () => {
    const { guest, invite, bytes } = await fixture()
    expect((await installEnrollment(bytes, invite, guest, guest.identity.personId)).activeWorkspaceId).toBe("ws")
  })

  it("preflights approval without replacing the local identity or saving its root", async () => {
    const { owner, guest, invite, bytes } = await fixture()
    vi.mocked(defaultStorage.savePersonalRoot).mockClear()
    const prepared = await preflightEnrollment(bytes, invite, guest)

    expect(prepared.profile.identity.personId).toBe(owner.identity.personId)
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
    expect(defaultStorage.savePersonalRoot).not.toHaveBeenCalled()
  })

  it("carries the personal display-name preset to the enrolled device", async () => {
    const { guest, invite, bytes } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    expect(enrolled.personalRoot.displayNamePreset).toBe("Owner preset")
    expect(defaultStorage.savePersonalRoot).toHaveBeenCalledWith(expect.objectContaining({ displayNamePreset: "Owner preset" }))
  })

  it("rejects forged or replayed approvals before changing local identity", async () => {
    const { guest, invite, bytes } = await fixture()
    await expect(installEnrollment(bytes, { ...invite, invitationId: "different" }, guest)).rejects.toThrow("Invalid")
    const raw = JSON.parse(new TextDecoder().decode(bytes))
    raw.payload.personalRoot.identity.displayName = "Forged owner"
    await expect(installEnrollment(new TextEncoder().encode(JSON.stringify(raw)), invite, guest)).rejects.toThrow("Invalid")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
  })

  it("keeps the current identity when approval cannot be saved", async () => {
    const { guest, invite, bytes } = await fixture()
    vi.mocked(defaultStorage.savePersonalRoot).mockRejectedValueOnce(new Error("Storage full"))
    await expect(installEnrollment(bytes, invite, guest, guest.identity.personId)).rejects.toThrow("Storage full")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
  })

  it("lets an enrolled device issue a verifiable delegated certificate for another device", async () => {
    const { owner, guest, invite, bytes, service } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    resetIdentityStorageForTest()
    const third = await bootstrapIdentity("Third device")
    const thirdInvite = createDeviceEnrollmentInvite("second-endpoint", "another-secret", enrolled.profile)
    await service.saveIssuedInvitation(thirdInvite)
    await service.claimInvitation(thirdInvite.invitationId, third.device.deviceId)
    const result = await service.approveEnrollment(thirdInvite.invitationId, third.device, enrolled.profile)
    if (!result.ok) throw new Error(result.error)
    expect(result.certificate.payload.issuerCertificateHash).toBe(await certHashDefault(enrolled.certificate))
    expect(await verifyDeviceChain({ personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      deviceId: third.device.deviceId, certificates: [result.certificate, enrolled.certificate, ...await defaultProofStore.listCertificates()] })).toBe(third.device.publicKey)
    expect((await service.approveEnrollment(thirdInvite.invitationId, third.device, enrolled.profile)).ok).toBe(false)
  })
})
