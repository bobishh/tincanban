import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest, signEnvelope, toBase64Url } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { InvitationService, resetInvitationStorageForTest } from "./invitations"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { createEnrollmentRequest, enrollmentPayload, installEnrollment, preflightEnrollment, readEnrollmentRequest } from "./enrollment"
import { defaultStorage } from "../storage"
import { keyId, verifyDeviceChain } from "./meshRecords"
import { resolveSigningContext } from "../domain/signingContext"
import * as local from "../localDb"

async function fixture(photo?: { avatarData: string | null; changedAt: string }) {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const guest = await bootstrapIdentity("New device")
  const service = new InvitationService()
  const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
  await service.saveIssuedInvitation(invite)
  await service.claimInvitation(invite.invitationId, guest.device.deviceId)
  const deviceCertificateContext = await resolveSigningContext({ profile: owner, certificates: [owner.certificate],
    purpose: "device-certificate", binding: { personId: owner.identity.personId, deviceId: guest.device.deviceId,
      devicePublicKey: guest.device.publicKey, issuerCertificateHash: await certHashDefault(owner.certificate) },
    authorityRevision: "fixture", current: async () => ({ personId: owner.identity.personId,
      deviceId: owner.device.deviceId, authorityRevision: "fixture" }) })
  const result = await service.approveEnrollment(invite.invitationId, guest.device, owner, deviceCertificateContext)
  if (!result.ok) throw new Error(result.error)
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  registerWorkspaceInRoot(root, "ws", "ws", "genesis")
  root.displayNamePreset = "Owner preset"
  if (photo) root.photo = photo
  const context = await resolveSigningContext({ profile: owner, certificates: [owner.certificate], purpose: "device-enrollment-approval",
    binding: { invitationId: invite.invitationId, recipientDeviceId: result.certificate.payload.deviceId }, authorityRevision: "fixture",
    current: async () => ({ personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "fixture" }) })
  const bytes = await enrollmentPayload(invite, owner, result.certificate, root, [{ id: "ws", title: "Board" }],
    "ws", [{ version: 1, workspaceId: "ws", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate], transportSecret: "A".repeat(43), epoch: 1, peers: [], optionalMeshField: undefined }], [], new TextEncoder().encode("[]"), context)
  return { owner, guest, service, invite, bytes, certificate: result.certificate, root, context }
}

beforeEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest(); resetInvitationStorageForTest() })

describe("device enrollment boundary", () => {
  it("Given complete portable state, when authoring enrollment, then use the same required manifest as ongoing device sync", async () => {
    const { owner, guest, invite, bytes } = await fixture()
    const raw = JSON.parse(new TextDecoder().decode(bytes))
    expect(raw.payload.version).toBe(3)
    expect(raw.payload.deviceState.components).toHaveProperty("ownerCapabilities")
    expect(raw.payload.deviceState.components).toHaveProperty("recoveryEvidence")
    expect(raw.payload).not.toHaveProperty("replicaPreferences")
    expect(raw.payload).not.toHaveProperty("personalRoot")
    const prepared = await preflightEnrollment(bytes, invite, guest)
    expect(prepared.payload.personalRoot.identity.personId).toBe(owner.identity.personId)
  })
  it("Given an accessible workspace owned by another person, when enrolling the same identity, then preserve its verified grant without promoting owner rights", async () => {
    const f = await fixture()
    const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)))
    const ownerPersonId = await keyId(publicKey)
    const otherDevice = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const devicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", otherDevice.publicKey)))
    const ownerCertificate = await signEnvelope(other.privateKey, { kind: "device-certificate" as const, version: 1 as const,
      personId: ownerPersonId, deviceId: await keyId(devicePublicKey), devicePublicKey,
      issuerCertificateHash: null, canEnrollDevices: true as const }, ownerPersonId)
    const grant = await signEnvelope(other.privateKey, { kind: "workspace-grant" as const, version: 1 as const, grantId: "grant",
      workspaceId: "shared", personId: f.owner.identity.personId, role: "editor" as const }, ownerPersonId)
    registerWorkspaceInRoot(f.root, "shared", "shared", "grant")
    const author = () => enrollmentPayload(f.invite, f.owner, f.certificate, f.root, [{ id: "shared", title: "Shared board" }],
      "shared", [{ version: 1, workspaceId: "shared", ownerPersonId, ownerPublicKey: publicKey, ownerCertificates: [ownerCertificate],
        transportSecret: "A".repeat(43), epoch: 1, peers: [] }], [grant],
      new TextEncoder().encode("[]"), f.context)
    const prepared = await preflightEnrollment(await author(), f.invite, f.guest)
    expect(prepared.payload.grants[0].payload.role).toBe("editor")
    expect(prepared.payload.meshWorkspaces[0].ownerPersonId).toBe(ownerPersonId)
    grant.payload.personId = "other-person"
    await expect(preflightEnrollment(await author(), f.invite, f.guest)).rejects.toThrow(/grant|access|approval/i)
  })
  it("Given an owner photo, when a phone enrolls, then its personal catalog retains that photo", async () => {
    const photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-10-14T07:00:00.000Z" }
    const { guest, invite, bytes } = await fixture(photo)
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    expect(enrolled.personalRoot.photo).toEqual(photo)
  })
  it("rejects replacement of another identity without explicit consent before writing anything", async () => {
    const { guest, invite, bytes } = await fixture()
    const before = await local.readLocal("tincanban.v1.personal_roots")
    await expect(installEnrollment(bytes, invite, guest)).rejects.toThrow("Identity conflict")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
    expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(before)
  })

  it("preserves an existing target identity's local root entries during enrollment", async () => {
    const { owner, guest, invite, bytes } = await fixture()
    const localRoot = createPersonalRoot(owner, await certHashDefault(owner.certificate))
    localRoot.workspaces.local = { workspaceId: "local", documentId: "local", grantHash: "local-proof", forgotten: false }
    await defaultStorage.savePersonalRoot(localRoot)
    const result = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    expect(result.personalRoot.rootId).toBe(localRoot.rootId)
    expect(result.personalRoot.workspaces.local).toEqual(localRoot.workspaces.local)
    expect(await defaultStorage.loadPersonalRoot(localRoot.rootId)).toEqual(result.personalRoot)
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

  it("Given a profile carrying another device's private key, when creating an enrollment request, then reject before emitting a request", async () => {
    const { guest, invite } = await fixture()
    const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const profile = { ...guest, privateKeys: { ...guest.privateKeys, devicePrivateKey: other.privateKey } }

    await expect(createEnrollmentRequest(invite, profile)).rejects.toThrow(/key|signer/i)
  })

  it("Given another tab replaced the durable device key, when creating an enrollment request, then fail closed", async () => {
    const { guest, invite } = await fixture()
    const raw = await local.readLocal("tincanban.local_profile.v1")
    if (!raw) throw new Error("Test identity was not persisted")
    const stored = JSON.parse(raw) as { privateKeys: Record<string, string> }
    const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    stored.privateKeys.devicePrivateKeyPkcs8 = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacement.privateKey)))
    const changed = JSON.stringify(stored)
    await local.writeLocal("tincanban.local_profile.v1", changed)

    await expect(createEnrollmentRequest(invite, guest)).rejects.toThrow(/stale identity|signing key/i)
    expect(await local.readLocal("tincanban.local_profile.v1")).toBe(changed)
  })

  it("Given a validly signed leaf whose certificate ancestor is unavailable, when creating a request, then reject without signing", async () => {
    const { guest, invite } = await fixture()
    const certificate = await signEnvelope(guest.privateKeys.devicePrivateKey, {
      ...guest.certificate.payload, issuerCertificateHash: "missing-ancestor",
    }, guest.device.deviceId)
    const profile = { ...guest, certificate }
    const raw = await local.readLocal("tincanban.local_profile.v1")
    if (!raw) throw new Error("Test identity was not persisted")
    const stored = { ...JSON.parse(raw), certificate }
    await local.writeLocal("tincanban.local_profile.v1", JSON.stringify(stored))

    await expect(createEnrollmentRequest(invite, profile)).rejects.toThrow(/ancestor|certificate|chain/i)
  })

  it("Given mutable invitation and profile objects, when signing awaits verification, then keep the original request binding", async () => {
    const { guest, invite } = await fixture()
    const requestInvite = structuredClone(invite)
    const requestProfile = structuredClone(guest)
    const originalInvitationId = requestInvite.invitationId
    const originalDeviceId = requestProfile.device.deviceId
    const originalPublicKey = requestProfile.device.publicKey
    const originalDisplayName = requestProfile.device.displayName
    const pending = createEnrollmentRequest(requestInvite, requestProfile)
    requestInvite.invitationId = "changed-during-signing"
    requestProfile.device.deviceId = "changed-device"
    requestProfile.device.publicKey = "changed-public-key"
    requestProfile.device.displayName = "Changed name"

    const bytes = await pending
    const parsed = await readEnrollmentRequest(bytes, { ...invite, invitationId: originalInvitationId })
    expect(parsed).toEqual({ kind: "device-enrollment-request", version: 2, invitationId: originalInvitationId,
      deviceId: originalDeviceId, publicKey: originalPublicKey, displayName: originalDisplayName })
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
    const before = await local.readLocal("tincanban.v1.personal_roots")
    const prepared = await preflightEnrollment(bytes, invite, guest)

    expect(prepared.profile.identity.personId).toBe(owner.identity.personId)
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
    expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(before)
  })

  it("carries the personal display-name preset to the enrolled device", async () => {
    const { guest, invite, bytes } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    expect(enrolled.personalRoot.displayNamePreset).toBe("Owner preset")
    expect((await defaultStorage.loadPersonalRoot(enrolled.personalRoot.rootId))?.displayNamePreset).toBe("Owner preset")
  })

  it("rejects forged or replayed approvals before changing local identity", async () => {
    const { guest, invite, bytes } = await fixture()
    await expect(installEnrollment(bytes, { ...invite, invitationId: "different" }, guest)).rejects.toThrow("Invalid")
    const raw = JSON.parse(new TextDecoder().decode(bytes))
    raw.payload.deviceState.components.identityCatalog.value.personalRoot.identity.displayName = "Forged owner"
    await expect(installEnrollment(new TextEncoder().encode(JSON.stringify(raw)), invite, guest)).rejects.toThrow("Invalid")
    expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
  })

  it("keeps the current identity when approval cannot be saved", async () => {
    const { guest, invite, bytes } = await fixture()
    vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("Storage full"))
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
    const issuerCertificates = [enrolled.certificate, ...await defaultProofStore.listCertificates()]
    const issuerCertificateHash = await certHashDefault(enrolled.certificate)
    const context = await resolveSigningContext({ profile: enrolled.profile, certificates: issuerCertificates,
      purpose: "device-certificate", binding: { personId: owner.identity.personId, deviceId: third.device.deviceId,
        devicePublicKey: third.device.publicKey, issuerCertificateHash }, authorityRevision: "fixture-delegated",
      current: async () => ({ personId: owner.identity.personId, deviceId: enrolled.profile.device.deviceId,
        authorityRevision: "fixture-delegated" }) })
    const result = await service.approveEnrollment(thirdInvite.invitationId, third.device, enrolled.profile, context)
    if (!result.ok) throw new Error(result.error)
    expect(result.certificate.payload.issuerCertificateHash).toBe(await certHashDefault(enrolled.certificate))
    expect(await verifyDeviceChain({ personId: owner.identity.personId, publicKey: owner.identity.publicKey,
      deviceId: third.device.deviceId, certificates: [result.certificate, enrolled.certificate, ...await defaultProofStore.listCertificates()] })).toBe(third.device.publicKey)
    expect((await service.approveEnrollment(thirdInvite.invitationId, third.device, enrolled.profile)).ok).toBe(false)
  })
})
