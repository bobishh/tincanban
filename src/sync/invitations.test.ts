import "fake-indexeddb/auto"
import { describe, expect, it, beforeEach, vi } from "vitest"
import {
  InvitationService,
  resetInvitationStorageForTest,
  deriveTranscriptAuthCode,
} from "./invitations"
import { bootstrapIdentity, resetIdentityStorageForTest, verifyEnvelope } from "../domain/identity"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import { createDeviceEnrollmentInvite, createWorkspaceJoinInvite } from "@meta-uber/mesh-pairing"
import { certHashDefault } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { peerStore } from "./peerStore"

describe("InvitationService (Requirements 3.2 - 3.4)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
    resetInvitationStorageForTest()
  })

  it("handles atomic single-target claim and same-target resume", async () => {
    const profile = await bootstrapIdentity("Issuer Alice")
    const service = new InvitationService()

    const invite = createDeviceEnrollmentInvite("ep1", "sec1", profile)
    await service.saveIssuedInvitation(invite)

    // First claim by device B
    const claim1 = await service.claimInvitation(invite.invitationId, "device_b")
    expect(claim1.ok).toBe(true)

    // Same-target resume succeeds
    const resume = await service.claimInvitation(invite.invitationId, "device_b")
    expect(resume.ok).toBe(true)

    // Competing recipient device C fails
    const claim2 = await service.claimInvitation(invite.invitationId, "device_c")
    expect(claim2.ok).toBe(false)
    if (!claim2.ok) {
      expect(claim2.error).toMatch(/competing/i)
    }
  })

  it("handles cancellation and expiration", async () => {
    const profile = await bootstrapIdentity("Issuer Alice")
    const service = new InvitationService()

    const invite = createDeviceEnrollmentInvite("ep1", "sec1", profile)
    await service.saveIssuedInvitation(invite)

    await service.cancelInvitation(invite.invitationId)
    const claim = await service.claimInvitation(invite.invitationId, "device_b")
    expect(claim.ok).toBe(false)
    if (!claim.ok) {
      expect(claim.error).toMatch(/cancelled/i)
    }
  })

  it("derives deterministic short transcript authentication codes", async () => {
    const code1 = await deriveTranscriptAuthCode("sec_abc", "pubkey_host", "pubkey_guest")
    const code2 = await deriveTranscriptAuthCode("sec_abc", "pubkey_host", "pubkey_guest")
    expect(code1).toEqual(code2)
    expect(code1.length).toBeGreaterThanOrEqual(4)

    const codeDifferent = await deriveTranscriptAuthCode("sec_other", "pubkey_host", "pubkey_guest")
    expect(code1).not.toEqual(codeDifferent)
  })

  it("approves own-device enrollment and issues signed certificate", async () => {
    const profileHost = await bootstrapIdentity("Alice Host")
    resetIdentityStorageForTest()
    const profileGuest = await bootstrapIdentity("Alice Guest Device")
    const service = new InvitationService()

    const invite = createDeviceEnrollmentInvite("ep1", "sec1", profileHost)
    await service.saveIssuedInvitation(invite)

    await service.claimInvitation(invite.invitationId, profileGuest.device.deviceId)
    const context = await resolveSigningContext({ profile: profileHost, certificates: [profileHost.certificate],
      purpose: "device-certificate", binding: { personId: profileHost.identity.personId,
        deviceId: profileGuest.device.deviceId, devicePublicKey: profileGuest.device.publicKey,
        issuerCertificateHash: await certHashDefault(profileHost.certificate) }, authorityRevision: "test",
      current: async () => ({ personId: profileHost.identity.personId, deviceId: profileHost.device.deviceId,
        authorityRevision: "test" }) })

    const approval = await service.approveEnrollment(
      invite.invitationId,
      profileGuest.device,
      profileHost,
      context,
    )
    expect(approval.ok).toBe(true)
    if (!approval.ok) return

    expect(approval.certificate.payload.deviceId).toBe(profileGuest.device.deviceId)
    expect(approval.certificate.payload.personId).toBe(profileHost.identity.personId)
  })

  it("Given another device key, when approving enrollment, then reject and leave the claim redeeming", async () => {
    const owner = await bootstrapIdentity("Issuer")
    const recipient = await bootstrapIdentity("Recipient")
    const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const service = new InvitationService()
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, recipient.device.deviceId)

    const wrongProfile = { ...owner, privateKeys: { ...owner.privateKeys, devicePrivateKey: other.privateKey } }
    expect(await service.approveEnrollment(invite.invitationId, recipient.device, wrongProfile)).toMatchObject({ ok: false })
    expect((await service.getInvitation(invite.invitationId))?.status).toBe("redeeming")
  })

  it("Given an active issuer and an isolated recipient profile, when approving enrollment, then issue a verifiable certificate", async () => {
    const issuer = await bootstrapIdentity("Issuer")
    const recipientValues = new Map<string, string>()
    const recipientStore = new BrowserIdentityStore({ storageKey: "isolated-recipient", requirePersistence: true,
      storage: { getItem: key => recipientValues.get(key) ?? null,
        setItem: (key, value) => { recipientValues.set(key, value) }, removeItem: key => { recipientValues.delete(key) } } })
    const recipient = await recipientStore.bootstrap("Recipient")
    const service = new InvitationService()
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", issuer)
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, recipient.device.deviceId)

    const approval = await service.approveEnrollment(invite.invitationId, recipient.device, issuer)
    expect(approval.ok).toBe(true)
    if (!approval.ok) return
    expect(approval.certificate.payload).toMatchObject({ personId: issuer.identity.personId,
      deviceId: recipient.device.deviceId, devicePublicKey: recipient.device.publicKey,
      issuerCertificateHash: await certHashDefault(issuer.certificate) })
    await expect(verifyEnvelope(approval.certificate, issuer.device.publicKey)).resolves.toBe(true)
  })

  it("Given a redeeming claim, when cancellation occurs during certificate signing, then do not consume or return a certificate", async () => {
    const owner = await bootstrapIdentity("Issuer")
    const recipient = await bootstrapIdentity("Recipient")
    const service = new InvitationService()
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, recipient.device.deviceId)

    let notifySigningStarted!: () => void
    const signingStarted = new Promise<void>(resolve => { notifySigningStarted = resolve })
    let releaseSigning!: () => void
    const signingGate = new Promise<void>(resolve => { releaseSigning = resolve })
    const originalSign = crypto.subtle.sign.bind(crypto.subtle)
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const result = await originalSign(...args)
      notifySigningStarted()
      await signingGate
      return result
    })
    try {
      const pending = service.approveEnrollment(invite.invitationId, recipient.device, owner)
      await signingStarted
      await service.cancelInvitation(invite.invitationId)
      releaseSigning()

      expect(await pending).toMatchObject({ ok: false })
      expect((await service.getInvitation(invite.invitationId))?.status).toBe("cancelled")
    } finally {
      releaseSigning()
      sign.mockRestore()
    }
  })

  it("Given cancellation after final awaited validation, when consuming approval, then preserve the cancelled state", async () => {
    const owner = await bootstrapIdentity("Issuer")
    const recipient = await bootstrapIdentity("Recipient")
    const service = new InvitationService()
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, recipient.device.deviceId)
    const originalToISOString = Date.prototype.toISOString
    const toISOString = vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
      void service.cancelInvitation(invite.invitationId)
      return originalToISOString.call(this)
    })
    try {
      expect(await service.approveEnrollment(invite.invitationId, recipient.device, owner)).toMatchObject({ ok: false })
      expect((await service.getInvitation(invite.invitationId))?.status).toBe("cancelled")
    } finally { toISOString.mockRestore() }
  })

  it("Given the invitation record is replaced after final validation, when consuming approval, then preserve the replacement", async () => {
    const owner = await bootstrapIdentity("Issuer")
    const recipient = await bootstrapIdentity("Recipient")
    const service = new InvitationService()
    const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, recipient.device.deviceId)
    const originalToISOString = Date.prototype.toISOString
    const toISOString = vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
      void service.saveIssuedInvitation(invite)
      return originalToISOString.call(this)
    })
    try {
      expect(await service.approveEnrollment(invite.invitationId, recipient.device, owner)).toMatchObject({ ok: false })
      expect((await service.getInvitation(invite.invitationId))?.status).toBe("pending")
    } finally { toISOString.mockRestore() }
  })

  it("prevents non-owner editor from issuing workspace grants (Requirement 3.4)", async () => {
    const owner = await bootstrapIdentity("Owner Alice")
    resetIdentityStorageForTest()
    const editor = await bootstrapIdentity("Editor Bob")
    const service = new InvitationService()

    const invite = createWorkspaceJoinInvite("ep1", "sec1", editor, [{ id: "ws_1", title: "Secret Board" }])
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, "charlie_device")

    // Bob tries to approve grant for Charlie on ws_1 where Bob is only an editor, not owner
    const approval = await service.approveWorkspaceJoin(
      invite.invitationId,
      "person_charlie",
      "ws_1",
      editor,
      owner.identity.personId // real owner is Alice
    )
    expect(approval.ok).toBe(false)
    if (!approval.ok) {
      expect(approval.error).toMatch(/owner/i)
    }
  })

  it("issues signed workspace grants for every workspace in a selected fixed set", async () => {
    const owner = await bootstrapIdentity("Owner Alice")
    for (const workspaceId of ["ws_1", "ws_2"]) await peerStore.putWorkspaceAuthority({
      version: 1, workspaceId, genesisOwnerPersonId: owner.identity.personId,
      ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate], ownerHistory: [], epoch: 1,
      updatedAt: new Date().toISOString(), catalog: {},
    })
    const service = new InvitationService()

    const invite = createWorkspaceJoinInvite(
      "ep1",
      "sec1",
      owner,
      [
        { id: "ws_1", title: "Job search" },
        { id: "ws_2", title: "Reading list" },
      ]
    )
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, "charlie_device")

    const res = await service.approveWorkspaceJoinSet(
      invite.invitationId,
      "person_charlie",
      ["ws_1", "ws_2"],
      owner
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.grants).toHaveLength(2)
    expect(res.grants[0].payload.workspaceId).toBe("ws_1")
    expect(res.grants[0].payload.personId).toBe("person_charlie")
    expect(res.grants[1].payload.workspaceId).toBe("ws_2")
    expect(res.grants[1].payload.personId).toBe("person_charlie")
    expect(res.grants[0].signerKeyId).toBe(owner.device.deviceId)
    await expect(verifyEnvelope(res.grants[0], owner.device.publicKey)).resolves.toBe(true)
    await expect(verifyEnvelope(res.grants[1], owner.device.publicKey)).resolves.toBe(true)
  })

  it("Given a cancelled workspace invitation, when approving a join, then issue no grant and preserve cancellation", async () => {
    const owner = await bootstrapIdentity("Owner")
    const service = new InvitationService()
    const invite = createWorkspaceJoinInvite("endpoint", "secret", owner, [{ id: "workspace", title: "Board" }])
    await service.saveIssuedInvitation(invite)
    await service.cancelInvitation(invite.invitationId)
    expect(await service.approveWorkspaceJoin(invite.invitationId, "member", "workspace", owner)).toMatchObject({ ok: false })
    expect((await service.getInvitation(invite.invitationId))?.status).toBe("cancelled")
  })

  it("Given a fixed workspace invitation, when requesting another workspace, then reject without consuming the invitation", async () => {
    const owner = await bootstrapIdentity("Owner")
    const service = new InvitationService()
    const invite = createWorkspaceJoinInvite("endpoint", "secret", owner, [{ id: "workspace", title: "Board" }])
    await service.saveIssuedInvitation(invite)
    expect(await service.approveWorkspaceJoinSet(invite.invitationId, "member", ["another"], owner)).toMatchObject({ ok: false })
    expect((await service.getInvitation(invite.invitationId))?.status).toBe("pending")
  })

  it("Given an owner grant in flight, when the invitation is cancelled during signing, then return no grant and retain cancellation", async () => {
    const owner = await bootstrapIdentity("Owner")
    const service = new InvitationService()
    const workspaceId = "cancel-grant-workspace"
    await peerStore.putWorkspaceAuthority({ version: 1, workspaceId, genesisOwnerPersonId: owner.identity.personId,
      ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate],
      ownerHistory: [], epoch: 1, updatedAt: new Date().toISOString(), catalog: {} })
    const invite = createWorkspaceJoinInvite("endpoint", "secret", owner, [{ id: workspaceId, title: "Board" }])
    await service.saveIssuedInvitation(invite)
    const sign = crypto.subtle.sign.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const signature = await sign(...args)
      if (new TextDecoder().decode(args[2] as Uint8Array).includes('"workspace-grant"')) await service.cancelInvitation(invite.invitationId)
      return signature
    })
    try {
      expect(await service.approveWorkspaceJoin(invite.invitationId, "member", workspaceId, owner)).toMatchObject({ ok: false })
      expect((await service.getInvitation(invite.invitationId))?.status).toBe("cancelled")
    } finally { spy.mockRestore() }
  })

  it("fails grant-set approval explicitly if issuer lacks ownership authority for any workspace", async () => {
    const owner = await bootstrapIdentity("Owner Alice")
    resetIdentityStorageForTest()
    const editor = await bootstrapIdentity("Editor Bob")
    const service = new InvitationService()

    const invite = createWorkspaceJoinInvite(
      "ep1",
      "sec1",
      editor,
      [
        { id: "ws_1", title: "Job search" },
        { id: "ws_2", title: "Reading list" },
      ]
    )
    await service.saveIssuedInvitation(invite)
    await service.claimInvitation(invite.invitationId, "charlie_device")

    const res = await service.approveWorkspaceJoinSet(
      invite.invitationId,
      "person_charlie",
      ["ws_1", "ws_2"],
      editor,
      new Map([["ws_1", owner.identity.personId]]) // Bob is not the owner of ws_1
    )

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/owner/i)
    }
  })
})
