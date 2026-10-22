import { afterEach, beforeEach, expect, it } from "vitest"
import { createIdentityEnrollmentDevice, profileFromIdentitySeedForDevice } from "@meta-uber/mesh-identity"
import { adoptEnrolledIdentityDevice, bootstrapIdentity, replaceWithEnrolledIdentityDevice, resetIdentityStorageForTest } from "./identity"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { readLocal } from "../localDb"

beforeEach(resetIdentityStorageForTest)
afterEach(resetIdentityStorageForTest)

it("Given an approved same-person device, when adopting it, then retain its exact enrolled key", async () => {
  const current = await bootstrapIdentity("Owner")
  const enrolled = await createIdentityEnrollmentDevice("Portal device")
  const certificate = await createDelegatedCertificate(current.privateKeys.devicePrivateKey, current.device.deviceId,
    current.identity.personId, enrolled.device.deviceId, enrolled.device.publicKey, await certHashDefault(current.certificate))
  const submitted = { identity: current.identity, device: enrolled.device, certificate,
    privateKeys: { devicePrivateKey: enrolled.privateKey } }

  const adopted = await adoptEnrolledIdentityDevice(submitted, [certificate, current.certificate], current.identity.personId)

  expect(adopted.identity.personId).toBe(current.identity.personId)
  expect(adopted.device).toEqual(enrolled.device)
  expect(adopted.privateKeys.devicePrivateKey).toBe(enrolled.privateKey)
  expect(adopted.privateKeys.identityPrivateKey).toBeUndefined()
})

it("Given an approved device for another person, when adopting it, then keep the current local Identity", async () => {
  const current = await bootstrapIdentity("Owner")
  const enrolled = await createIdentityEnrollmentDevice("Foreign device")
  const foreignIdentity = { ...current.identity, personId: "A".repeat(43) }
  const submitted = { identity: foreignIdentity, device: enrolled.device, certificate: current.certificate,
    privateKeys: { devicePrivateKey: enrolled.privateKey } }

  await expect(adoptEnrolledIdentityDevice(submitted, [current.certificate], current.identity.personId))
    .rejects.toThrow(/another person/i)

  expect((await bootstrapIdentity()).identity.personId).toBe(current.identity.personId)
})

it("Given an approved device for another person, when replacement is declined, then keep local Identity unchanged", async () => {
  const current = await bootstrapIdentity("Local person")
  const originalBytes = await readLocal("tincanban.local_profile.v1")
  const submitted = await foreignEnrollment()

  await expect(replaceWithEnrolledIdentityDevice(submitted.profile, submitted.certificates, current,
    { consentToReplaceExistingIdentity: false })).rejects.toThrow(/confirm replacing/i)

  expect((await bootstrapIdentity()).identity.personId).toBe(current.identity.personId)
  expect(await readLocal("tincanban.local_profile.v1")).toBe(originalBytes)
})

it("Given explicit replacement consent, when adopting another person's approved device, then preserve original profile bytes", async () => {
  const current = await bootstrapIdentity("Local person")
  const originalBytes = await readLocal("tincanban.local_profile.v1")
  const submitted = await foreignEnrollment()

  const adopted = await replaceWithEnrolledIdentityDevice(submitted.profile, submitted.certificates, current,
    { consentToReplaceExistingIdentity: true })

  expect(adopted.identity.personId).toBe(submitted.profile.identity.personId)
  expect(adopted.privateKeys.identityPrivateKey).toBeUndefined()
  expect(await readLocal(`tincanban.local_profile.v1.backup.${current.identity.personId}`)).toBe(originalBytes)
})

async function foreignEnrollment() {
  const root = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(21), "Existing Identity",
    new Uint8Array(32).fill(22))
  const device = await createIdentityEnrollmentDevice("This device")
  const certificate = await createDelegatedCertificate(root.privateKeys.devicePrivateKey, root.device.deviceId,
    root.identity.personId, device.device.deviceId, device.device.publicKey, await certHashDefault(root.certificate))
  return { profile: { identity: root.identity, device: device.device, certificate,
    privateKeys: { devicePrivateKey: device.privateKey } }, certificates: [certificate, root.certificate] }
}
