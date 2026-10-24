import { profileFromIdentitySeedForDevice, signEnvelope } from "@meta-uber/mesh-identity"
import { adoptEnrolledIdentity } from "../domain/identity"
import { useTincanban } from "./stateFixture"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { bootstrapIdentity } from "../domain/identity"

/** Public deterministic identity shared only by the isolated Reflux compatibility fixtures. */
export async function adoptRefluxFixtureOwner() {
  const workspace = useTincanban()
  await workspace.whenReady()
  const root = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(7), "Bridge owner")
  const local = workspace.getCurrentProfile()!
  const certificate = await signEnvelope(root.privateKeys.identityPrivateKey!, {
    kind: "device-certificate" as const, version: 1 as const, personId: root.identity.personId,
    deviceId: local.device.deviceId, devicePublicKey: local.device.publicKey,
    issuerCertificateHash: null, canEnrollDevices: true as const,
  }, root.identity.personId)
  await adoptEnrolledIdentity(root.identity, certificate)
  const adopted = await bootstrapIdentity()
  await defaultStorage.savePersonalRoot(createPersonalRoot(adopted, await certHashDefault(adopted.certificate)))
  await workspace.refreshIdentity()
  const profile = workspace.getCurrentProfile()!
  return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
}
