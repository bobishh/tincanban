import { confirmIdentityAuthorityFixture } from "./identityAuthority.testSupport"
import { beforeEach, expect, it, vi } from "vitest"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, canonicalizeJson, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import * as local from "../localDb"
import { defaultStorage } from "../storage"
import { enrollmentPayload, installEnrollment } from "./enrollment"
import { RustyManagementRepository, type ManagementBinding } from "./rustyManagementRepository"
import type { RustyManagementCapability } from "./rustyManagementCapability"

beforeEach(() => resetIdentityStorageForTest())

async function fixture(prepareManagement?: (owner: LocalProfile, guest: LocalProfile) => Promise<() => Promise<void>>) {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const guest = await bootstrapIdentity("Guest")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, guest.device.deviceId, guest.device.publicKey, await certHashDefault(owner.certificate))
  const root = createPersonalRoot(owner, await certHashDefault(owner.certificate))
  registerWorkspaceInRoot(root, "board", "board", "genesis")
  const invite = createDeviceEnrollmentInvite("endpoint", "secret", owner)
  const context = await resolveSigningContext({ profile: owner, certificates: [owner.certificate],
    purpose: "device-enrollment-approval", binding: { invitationId: invite.invitationId, recipientDeviceId: guest.device.deviceId },
    authorityRevision: "fixture", current: async () => ({ personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "fixture" }) })
  const restoreGuestState = await prepareManagement?.(owner, guest)
  await confirmIdentityAuthorityFixture(root, [owner.certificate, certificate])
  const bytes = await enrollmentPayload(invite, owner, certificate, root, [{ id: "board", title: "Board" }], "board",
    [{ version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate], transportSecret: "A".repeat(43), epoch: 1, peers: [] }], [], new TextEncoder().encode("[]"), context)
  await restoreGuestState?.()
  return { owner, guest, root, bytes, invite }
}

it("Given the enrollment transaction fails, when replacing identity, then retain previous identity, catalog, private state and backup", async () => {
  const { owner, guest, root, bytes, invite } = await fixture()
  const profileBefore = await local.readLocal("tincanban.local_profile.v1")
  const rootsBefore = await local.readLocal("tincanban.v1.personal_roots")
  const preferencesBefore = await local.readLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)
  const backupKey = `tincanban.local_profile.v1.backup.${guest.identity.personId}`
  const backupBefore = await local.readLocal(backupKey)
  const compare = local.compareAndSwapLocal
  const failure = vi.spyOn(local, "compareAndSwapLocal").mockImplementation(async (plan, guard) => {
    if (plan.writes.some(write => write.key === "tincanban.local_profile.v1")) throw new Error("adoption transaction aborted")
    return compare(plan, guard)
  })
  try { await expect(installEnrollment(bytes, invite, guest, guest.identity.personId)).rejects.toThrow("adoption transaction aborted") }
  finally { failure.mockRestore() }
  expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
  expect(await local.readLocal("tincanban.local_profile.v1")).toBe(profileBefore)
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(rootsBefore)
  expect(await local.readLocal(`tincanban.private-replica-state.v2.${owner.identity.personId}`)).toBe(preferencesBefore)
  expect(await local.readLocal(backupKey)).toBe(backupBefore)
  expect(await defaultStorage.loadPersonalRoot(root.rootId)).toBeNull()
})

it.each(["available", "offline"])("Given approved enrollment and a conflicting Rusty policy, when Rusty is %s, then adopt only after verifying current server status", async server => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  let current: unknown
  let binding: ManagementBinding
  try {
    const { owner, guest, bytes, invite } = await fixture(async (owner, guest) => {
      const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
      const serviceRaw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
      const serviceId = await sha256Base64Url(serviceRaw)
      binding = { origin: "https://rusty.example", servicePublicKey: toBase64Url(serviceRaw), resourceKind: "person", resourceId: owner.identity.personId }
      const payload: RustyManagementCapability = { kind: "rusty-person-management-capability", version: 1, serviceId,
        origin: binding.origin, personId: owner.identity.personId, resourceKind: "person", resourceId: owner.identity.personId,
        revision: 2, operations: ["management.update", "resource.create"], revokedDeviceIds: [], requestId: "current",
        authorizationHash: "A".repeat(43), issuedAt: Date.now() }
      const capability = await signEnvelope(service.privateKey, payload, serviceId, "RUSTY/2")
      current = capability
      await new RustyManagementRepository(owner.identity.personId).observe(binding, capability)
      const old = await signEnvelope(service.privateKey, { ...payload, requestId: "before-reset", revokedDeviceIds: [guest.device.deviceId] }, serviceId, "RUSTY/2")
      fetch.mockImplementation(async (_url: string, init: RequestInit) => {
        expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
        const request = JSON.parse(String(init.body))
        expect(request.identity.personId).toBe(owner.identity.personId)
        expect(await verifyEnvelope(request.authorization, guest.device.publicKey)).toBe(true)
        expect(request.certificates.some((value: { payload: { deviceId: string } }) => value.payload.deviceId === guest.device.deviceId)).toBe(true)
        const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
        return Response.json({ capability, migrationPending: false, receipt: await signEnvelope(service.privateKey, {
          kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin: binding.origin,
          personId: owner.identity.personId, deviceId: guest.device.deviceId, resourceKind: "person", resourceId: binding.resourceId,
          requestId: request.authorization.payload.requestId, capabilityHash: await hash(capability),
          authorizationHash: await hash(request.authorization), revision: 2, migrationPending: false, issuedAt: Date.now(),
        }, serviceId, "RUSTY/2") })
      })
      return async () => { await local.writeLocal(`tincanban.rusty-management.v1.${owner.identity.personId}`,
        JSON.stringify({ version: 1, personId: owner.identity.personId, records: [{ binding, capability: old }] })) }
    })
    if (server === "offline") {
      fetch.mockRejectedValue(new Error("offline"))
      const before = await local.readLocal("tincanban.local_profile.v1")
      await expect(installEnrollment(bytes, invite, guest, guest.identity.personId)).rejects.toThrow("offline")
      expect(await local.readLocal("tincanban.local_profile.v1")).toBe(before)
      expect((await bootstrapIdentity()).identity.personId).toBe(guest.identity.personId)
    } else {
      await installEnrollment(bytes, invite, guest, guest.identity.personId)
      expect((await bootstrapIdentity()).identity.personId).toBe(owner.identity.personId)
      expect((await new RustyManagementRepository(owner.identity.personId).read(binding!))?.capability).toEqual(current)
    }
    expect(fetch).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})

it("Given an accepted enrollment, when the device restarts, then open matching identity and private catalog without copying the root key", async () => {
  const { owner, guest, root, bytes, invite } = await fixture()
  await installEnrollment(bytes, invite, guest, guest.identity.personId)
  clearInMemoryProfileForReloadTest()
  const restored = await bootstrapIdentity()
  expect(restored.identity.personId).toBe(owner.identity.personId)
  expect(restored.device.deviceId).toBe(guest.device.deviceId)
  expect(restored.privateKeys.identityPrivateKey).toBeUndefined()
  expect((await defaultStorage.loadPersonalRoot(root.rootId))?.identity.personId).toBe(owner.identity.personId)
  expect(await local.readLocal(`tincanban.local_profile.v1.backup.${guest.identity.personId}`)).not.toBeNull()
})
