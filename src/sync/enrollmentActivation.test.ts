import { beforeEach, expect, it, vi } from "vitest"
import { createDeviceEnrollmentInvite } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import * as local from "../localDb"
import { defaultStorage } from "../storage"
import { enrollmentPayload, installEnrollment } from "./enrollment"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
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
  const bytes = await enrollmentPayload(invite, owner, certificate, root, [{ id: "board", title: "Board" }], "board",
    [{ version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
      ownerCertificates: [owner.certificate], transportSecret: "A".repeat(43), epoch: 1, peers: [] }], [], new TextEncoder().encode("[]"), context)
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
