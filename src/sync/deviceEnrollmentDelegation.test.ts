import { expect, it, vi } from "vitest"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { controllerDelegation, installControllerDelegation } from "./deviceEnrollmentDelegation"
import { verifyDeviceChain } from "./meshRecords"

vi.mock("../storage", () => ({ defaultStorage: { updatePersonalRootForIdentity: vi.fn(async (_id, update) => update(null)) } }))

it("Given a phone enrolled with an older root-issued certificate, when its approving computer reconnects, then preserve its keys and renew through that controller", async () => {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Computer")
  await defaultProofStore.putCertificate(await certHashDefault(owner.certificate), owner.certificate)
  resetIdentityStorageForTest()
  const guest = await bootstrapIdentity("Phone")
  const certificate = await signEnvelope(owner.privateKeys.identityPrivateKey!, {
    kind: "device-certificate" as const, version: 1 as const, personId: owner.identity.personId,
    deviceId: guest.device.deviceId, devicePublicKey: guest.device.publicKey, issuerCertificateHash: null, canEnrollDevices: true as const,
  }, owner.identity.personId)
  const phone = await adoptEnrolledIdentity(owner.identity, certificate)
  await defaultProofStore.putCertificate(await certHashDefault(certificate), certificate)
  const delegation = await controllerDelegation(owner, phone.device.deviceId)
  expect(delegation?.certificate.payload.issuerCertificateHash).toBe(await certHashDefault(owner.certificate))
  await installControllerDelegation(phone, owner.device.deviceId, delegation)
  const restored = await bootstrapIdentity()
  expect(restored.device).toEqual(guest.device)
  expect(restored.privateKeys.devicePrivateKey).toBe(guest.privateKeys.devicePrivateKey)
  expect(restored.privateKeys.identityPrivateKey).toBeUndefined()
  expect(restored.certificate).toEqual(delegation!.certificate)
  expect(await verifyDeviceChain({ personId: owner.identity.personId, publicKey: owner.identity.publicKey,
    deviceId: phone.device.deviceId, certificates: [restored.certificate, owner.certificate] })).toBe(phone.device.publicKey)
  const forged = { ...delegation!, certificate: { ...delegation!.certificate, signature: "forged" } }
  await expect(installControllerDelegation(phone, owner.device.deviceId, forged)).rejects.toThrow()
  expect((await bootstrapIdentity()).certificate).toEqual(delegation!.certificate)
})
