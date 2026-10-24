import { beforeEach, expect, it } from "vitest"
import { certificateHash, createIdentityAuthorityView, createIdentityEnrollmentDevice, createRecoverableIdentity,
  emptyIdentityProfileState, signEnvelope } from "@meta-uber/mesh-identity"
import { resetIdentityStorageForTest } from "../domain/identity"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { rustySignerCertificateChain } from "./rustySignerCertificates"

beforeEach(() => resetIdentityStorageForTest())

it("Given a delegated active app key, When preparing Rusty signer evidence, Then preserve SDK leaf-to-root order", async () => {
  const owner = (await createRecoverableIdentity("better", "Owner")).profile
  const app = await createIdentityEnrollmentDevice("Tincanban app")
  const appCertificate = await signEnvelope(owner.privateKeys.devicePrivateKey!, {
    kind: "device-certificate" as const, version: 1 as const, personId: owner.identity.personId,
    deviceId: app.device.deviceId, devicePublicKey: app.device.publicKey,
    issuerCertificateHash: await certificateHash(owner.certificate), canEnrollDevices: false,
  }, owner.device.deviceId)
  const certificates = [owner.certificate, appCertificate]
  const authorityView = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] },
    emptyIdentityProfileState(owner.identity.personId))
  await mergeIdentityAuthorityView(authorityView)
  const profile = { ...owner, device: app.device, certificate: appCertificate }

  await expect(rustySignerCertificateChain(profile)).resolves.toEqual([appCertificate, owner.certificate])
})
