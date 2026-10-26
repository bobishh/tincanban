import { confirmIdentityAuthorityFixture } from "./identityAuthority.testSupport"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest, signEnvelope, toBase64Url,
  verifyEnvelope } from "../domain/identity"
import { createPersonalRoot, registerDeviceInRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { InvitationService, resetInvitationStorageForTest } from "./invitations"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { createEnrollmentRequest, enrollmentPayload, installEnrollment, preflightEnrollment, preflightSamePersonWorkspaceBootstrap,
  readEnrollmentRequest } from "./enrollment"
import { createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { defaultStorage } from "../storage"
import { keyId, verifyDeviceChain } from "./meshRecords"
import { resolveSigningContext } from "../domain/signingContext"
import * as local from "../localDb"
import { reactive } from "vue"
import { assertActiveIdentityEnrollmentDevice } from "./enrollment"
import { createSamePersonWorkspaceBootstrap } from "./enrollment"
import { createIdentityAuthorityView, createDeviceRevocation, publicKeyId, verifyIdentityDeviceAuthority } from "@meta-uber/mesh-identity"
import { emptyIdentityProfileState } from "../domain/identityProfileState"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { parsePrivateReplicaConfig, parseReplicaConfig } from "./blindReplicaConfig"
import * as rustyCatalog from "./identityRustyServiceCatalog"
import { persistThenReceiveSamePersonWorkspace } from "./deviceSyncSamePersonWorkspace"
import { getReplicaConfigurations } from "./privateReplicaRepository"

async function fixture(photo?: { avatarData: string | null; changedAt: string },
  workspaceView: (value: { id: string; title: string }[]) => { id: string; title: string }[] = value => value) {
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
  await confirmIdentityAuthorityFixture(root, [owner.certificate, result.certificate])
  const context = await resolveSigningContext({ profile: owner, certificates: [owner.certificate], purpose: "device-enrollment-approval",
    binding: { invitationId: invite.invitationId, recipientDeviceId: result.certificate.payload.deviceId }, authorityRevision: "fixture",
    current: async () => ({ personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "fixture" }) })
  const bytes = await enrollmentPayload(invite, owner, result.certificate, root, workspaceView([{ id: "ws", title: "Board" }]),
    "ws", [{ version: 1, workspaceId: "ws", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate], transportSecret: "A".repeat(43), epoch: 1, peers: [], optionalMeshField: undefined }], [], new TextEncoder().encode("[]"), context)
  return { owner, guest, service, invite, bytes, certificate: result.certificate, root, context }
}

beforeEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest(); resetInvitationStorageForTest() })

describe("device enrollment boundary", () => {
  it("Given optional mesh fields, when signing a workspace bootstrap, then the actual JSON wire payload verifies", async () => {
    const owner = await bootstrapIdentity("Owner")
    const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
    const targetKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const targetPublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", targetKeys.publicKey)))
    const targetDeviceId = await keyId(targetPublicKey)
    const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey!, owner.device.deviceId,
      owner.identity.personId, targetDeviceId, targetPublicKey, await certHashDefault(owner.certificate))
    const authorityView = await createIdentityAuthorityView(owner.identity,
      { certificates: [owner.certificate, certificate], revocations: [] }, await rootIdentityProfileState(root))
    await mergeIdentityAuthorityView(authorityView)
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
    const serviceKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const servicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", serviceKey.publicKey)))
    const origin = "https://rusty.example"
    const serviceId = await publicKeyId(servicePublicKey)
    vi.spyOn(rustyCatalog, "readIdentityRustyServicePin").mockResolvedValue({ origin, serviceId, servicePublicKey })
    const storage = parseReplicaConfig(JSON.stringify({ origin, scopeId: "s".repeat(43), workspaceId: "ws",
      servicePublicKey, contentKey: "c".repeat(43), readToken: "r".repeat(43), writeToken: "w".repeat(43),
      keyEpoch: 1, policyRevision: 1, minimumWriterVersion: 2, cursor: 9, lastUploaded: "l".repeat(43) }))
    const parsedIdentityStorage = parsePrivateReplicaConfig(JSON.stringify({ purpose: "identity", personId: owner.identity.personId,
      origin, scopeId: "i".repeat(43), servicePublicKey, contentKey: "c".repeat(43), readToken: "r".repeat(43),
      writeToken: "w".repeat(43), keyEpoch: 1, policyRevision: 1, cursor: 8, lastUploaded: "l".repeat(43) }), owner.identity.personId)
    if (parsedIdentityStorage.purpose !== "identity") throw new Error("Invalid identity replica test fixture")
    const identityStorage = parsedIdentityStorage
    const bytes = await createSamePersonWorkspaceBootstrap({ invite, profile: owner,
      recipientDeviceId: certificate.payload.deviceId, recipientPublicKey: certificate.payload.devicePublicKey,
      authorityView, workspace: { id: "ws", title: "Board", reference: {
        workspaceId: "ws", documentId: "ws", grantHash: "genesis", forgotten: false } },
      meshWorkspaces: [{ version: 1, workspaceId: "ws", ownerPersonId: owner.identity.personId,
        ownerPublicKey: owner.identity.publicKey, optionalMeshField: undefined }], grants: [], storage: [storage], identityStorage: [identityStorage],
      snapshot: new TextEncoder().encode("[]") })
    const wire = JSON.parse(new TextDecoder().decode(bytes)) as Parameters<typeof verifyEnvelope>[0]
    expect(await verifyEnvelope(wire, owner.device.publicKey)).toBe(true)
    expect(JSON.stringify(wire)).not.toContain("optionalMeshField")
  })

  it("Given a crash after local access CAS, when the same approved bootstrap retries after reload, then retain profile and local workspace and finish mesh delivery", async () => {
    const owner = await bootstrapIdentity("Retrying same-person bootstrap")
    const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
    registerWorkspaceInRoot(root, "ws", "ws", "approved-grant")
    registerWorkspaceInRoot(root, "local", "local-document", "local-grant")
    root.displayNamePreset = "Preserved profile"
    await defaultStorage.savePersonalRoot(root)
    const authorityView = await createIdentityAuthorityView(owner.identity,
      { certificates: [owner.certificate], revocations: [] }, await rootIdentityProfileState(root))
    await mergeIdentityAuthorityView(authorityView)
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
    const serviceKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const servicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", serviceKey.publicKey)))
    const origin = "https://rusty.example"
    const serviceId = await publicKeyId(servicePublicKey)
    vi.spyOn(rustyCatalog, "readIdentityRustyServicePin").mockResolvedValue({ origin, serviceId, servicePublicKey })
    const randomKey = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const storage = parseReplicaConfig(JSON.stringify({ origin, scopeId: "s".repeat(43), workspaceId: "ws",
      servicePublicKey, contentKey: "c".repeat(43), readToken: "r".repeat(43), writeToken: "w".repeat(43),
      keyEpoch: 1, policyRevision: 1, minimumWriterVersion: 2, cursor: 0, lastUploaded: "" }))
    const identityStorage = parsePrivateReplicaConfig(JSON.stringify({ purpose: "identity", personId: owner.identity.personId,
      origin, scopeId: "i".repeat(43), servicePublicKey, contentKey: randomKey(), readToken: randomKey(),
      writeToken: randomKey(), keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" }), owner.identity.personId)
    if (identityStorage.purpose !== "identity") throw new Error("Invalid test Identity replica config")
    const bytes = await createSamePersonWorkspaceBootstrap({ invite, profile: owner, recipientDeviceId: owner.device.deviceId,
      recipientPublicKey: owner.device.publicKey, authorityView, workspace: { id: "ws", title: "Board", reference: {
        workspaceId: "ws", documentId: "ws", grantHash: "approved-grant", forgotten: false } },
      meshWorkspaces: [{ workspaceId: "ws", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey }],
      grants: [], storage: [storage], identityStorage: [identityStorage], snapshot: new TextEncoder().encode("[]") })
    const prepared = await preflightSamePersonWorkspaceBootstrap(bytes, invite, owner, authorityView)
    const delivery = vi.fn().mockRejectedValueOnce(new Error("simulated crash before mesh credential receive"))
    const durableMesh = { receiveInvitation: delivery }

    await expect(persistThenReceiveSamePersonWorkspace(owner, prepared, () => {}, durableMesh)).rejects.toThrow("simulated crash")
    clearInMemoryProfileForReloadTest()
    const reloaded = await bootstrapIdentity()
    expect(reloaded.identity.personId).toBe(owner.identity.personId)
    await persistThenReceiveSamePersonWorkspace(reloaded, prepared, () => {}, durableMesh)

    expect(delivery).toHaveBeenCalledTimes(2)
    const persistedRoot = await defaultStorage.loadPersonalRoot(root.rootId)
    expect(persistedRoot?.displayNamePreset).toBe("Preserved profile")
    expect(persistedRoot?.workspaces.local).toEqual(root.workspaces.local)
    expect((await getReplicaConfigurations(owner.identity.personId)).map(config => config.workspaceId)).toEqual(["ws"])
  })

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

  it("Given Identity already authorized an app key without enrollment rights, when bootstrapping the same person's device, then require that exact active certificate and current view", async () => {
    const { owner, guest, root } = await fixture()
    const target = await signEnvelope(owner.privateKeys.identityPrivateKey!, {
      kind: "device-certificate" as const, version: 1 as const, personId: owner.identity.personId,
      deviceId: guest.device.deviceId, devicePublicKey: guest.device.publicKey, issuerCertificateHash: null,
      canEnrollDevices: false,
    }, owner.identity.personId)
    const certificates = [owner.certificate, target]
    const view = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] },
      await rootIdentityProfileState(root))
    const known = await createIdentityAuthorityView(owner.identity, { certificates: [owner.certificate], revocations: [] },
      await rootIdentityProfileState(root))

    await expect(assertActiveIdentityEnrollmentDevice(known, view, owner.identity.personId,
      guest.device.deviceId, guest.device.publicKey)).resolves.toMatchObject({ authorityView: { viewDigest: view.viewDigest }, certificates: [target] })
    await expect(assertActiveIdentityEnrollmentDevice(known, known, owner.identity.personId,
      guest.device.deviceId, guest.device.publicKey)).rejects.toThrow(/certificate/i)
    await expect(assertActiveIdentityEnrollmentDevice(known, view, owner.identity.personId,
      guest.device.deviceId, "different-public-key")).rejects.toThrow(/device key/i)

    const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
    const revocation = await createDeviceRevocation(owner, authority, guest.device.deviceId,
      emptyIdentityProfileState(owner.identity.personId))
    const revoked = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [revocation] },
      await rootIdentityProfileState(root))
    await expect(assertActiveIdentityEnrollmentDevice(known, revoked, owner.identity.personId,
      guest.device.deviceId, guest.device.publicKey)).rejects.toThrow(/revoked/i)
  })

  it("Given a reactive enrollment invitation from the device dialog, when requesting enrollment, then sign its exact original binding", async () => {
    const { guest, invite } = await fixture()
    const bytes = await createEnrollmentRequest(reactive(invite), guest)
    expect(await readEnrollmentRequest(bytes, invite)).toMatchObject({
      invitationId: invite.invitationId, deviceId: guest.device.deviceId, publicKey: guest.device.publicKey,
    })
  })

  it("Given reactive workspace summaries from the device dialog, when approving enrollment, then retain the exact signed portable workspace manifest", async () => {
    const { invite, guest, bytes } = await fixture(undefined, reactive)
    const prepared = await preflightEnrollment(bytes, invite, guest)
    expect(prepared.payload.workspaces).toEqual([{ id: "ws", title: "Board" }])
    expect(prepared.payload.activeWorkspaceId).toBe("ws")
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

  it("reuses a verified ancestor certificate when re-enrolling that exact device key", async () => {
    const { owner, guest, invite, bytes, service } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    const rejoin = createDeviceEnrollmentInvite("rejoin-endpoint", "rejoin-secret", enrolled.profile)
    await service.saveIssuedInvitation(rejoin)
    await service.claimInvitation(rejoin.invitationId, owner.device.deviceId)

    const approval = await service.approveEnrollment(rejoin.invitationId, owner.device, enrolled.profile)
    if (!approval.ok) throw new Error(approval.error)

    await expect(createIdentityDeviceTransfer(enrolled.personalRoot,
      [approval.certificate, enrolled.profile.certificate, owner.certificate])).resolves.toBeDefined()
    expect(approval.certificate).toEqual(owner.certificate)
  })

  it("rejects a device-id match with a different key without consuming its invitation", async () => {
    const { owner, guest, invite, bytes, service } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    const rejoin = createDeviceEnrollmentInvite("rejoin-endpoint", "rejoin-secret", enrolled.profile)
    await service.saveIssuedInvitation(rejoin)
    await service.claimInvitation(rejoin.invitationId, owner.device.deviceId)

    const mismatch = await service.approveEnrollment(rejoin.invitationId,
      { ...owner.device, publicKey: "mismatched-key" }, enrolled.profile)
    expect(mismatch).toMatchObject({ ok: false })
    expect((await service.getInvitation(rejoin.invitationId))?.status).toBe("redeeming")

    const valid = await service.approveEnrollment(rejoin.invitationId, owner.device, enrolled.profile)
    expect(valid).toMatchObject({ ok: true, certificate: owner.certificate })
  })

  it("exports a reapproval with an older signed duplicate retained in proof storage", async () => {
    const { owner, guest, invite, bytes, service } = await fixture()
    const enrolled = await installEnrollment(bytes, invite, guest, guest.identity.personId)
    const rejoin = createDeviceEnrollmentInvite("rejoin-endpoint", "rejoin-secret", enrolled.profile)
    await service.saveIssuedInvitation(rejoin)
    await service.claimInvitation(rejoin.invitationId, owner.device.deviceId)
    const approval = await service.approveEnrollment(rejoin.invitationId, owner.device, enrolled.profile)
    if (!approval.ok) throw new Error(approval.error)

    const olderDuplicate = await createDelegatedCertificate(enrolled.profile.privateKeys.devicePrivateKey!,
      enrolled.profile.device.deviceId, owner.identity.personId, owner.device.deviceId, owner.device.publicKey,
      await certHashDefault(enrolled.profile.certificate))
    const olderDuplicateHash = await certHashDefault(olderDuplicate)
    await defaultProofStore.putCertificate(olderDuplicateHash, olderDuplicate)
    const before = await defaultProofStore.getCertificate(olderDuplicateHash)

    const root = structuredClone(enrolled.personalRoot)
    const ownerCertificateHash = await certHashDefault(owner.certificate)
    registerDeviceInRoot(root, { ...owner.device, certificateHash: ownerCertificateHash, addedAt: new Date().toISOString() })
    const rootBeforeExport = structuredClone(root)
    const approvalContext = await resolveSigningContext({ profile: enrolled.profile,
      certificates: [enrolled.profile.certificate, owner.certificate], purpose: "device-enrollment-approval",
      binding: { invitationId: rejoin.invitationId, recipientDeviceId: owner.device.deviceId }, authorityRevision: "rejoin-fixture",
      current: async () => ({ personId: owner.identity.personId, deviceId: enrolled.profile.device.deviceId,
        authorityRevision: "rejoin-fixture" }) })
    const payload = await enrollmentPayload(rejoin, enrolled.profile, approval.certificate, root,
      [{ id: "ws", title: "Board" }], "ws", [{ version: 1, workspaceId: "ws", ownerPersonId: owner.identity.personId,
        ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], transportSecret: "A".repeat(43),
        epoch: 1, peers: [] }], [], new TextEncoder().encode("[]"), approvalContext)
    const wire = JSON.parse(new TextDecoder().decode(payload))
    const transfer = await readIdentityDeviceTransfer(wire.payload.deviceState, owner.identity.personId)

    expect(transfer.certificates.map(certificate => certificate.signature)).not.toContain(olderDuplicate.signature)
    expect(transfer.personalRoot.devices[owner.device.deviceId]?.certificateHash).toBe(ownerCertificateHash)
    expect(await defaultProofStore.getCertificate(olderDuplicateHash)).toEqual(before)
    expect(root).toEqual(rootBeforeExport)
  })
})
