import { adoptEnrolledIdentity, bootstrapIdentity, signEnvelope, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { verifyDeviceChain } from "./meshRecords"

export type ControllerDelegation = { certificate: DeviceCertificate; certificates: DeviceCertificate[] }

/** Repair older root-issued enrollments with evidence of the actual approving device. */
export async function controllerDelegation(profile: LocalProfile, recipientDeviceId: string): Promise<ControllerDelegation | undefined> {
  if (!profile.privateKeys.identityPrivateKey || !profile.certificate.payload.canEnrollDevices || recipientDeviceId === profile.device.deviceId) return undefined
  const certificates = [profile.certificate, ...await defaultProofStore.listCertificates()]
    .filter(certificate => certificate.payload.personId === profile.identity.personId)
  const publicKey = await verifyDeviceChain({ personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    deviceId: recipientDeviceId, certificates })
  const certificate = await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "device-certificate" as const, version: 1 as const, personId: profile.identity.personId,
    deviceId: recipientDeviceId, devicePublicKey: publicKey, issuerCertificateHash: await certHashDefault(profile.certificate), canEnrollDevices: true as const,
  }, profile.device.deviceId)
  return { certificate, certificates: [profile.certificate] }
}

export async function installControllerDelegation(profile: LocalProfile, issuerDeviceId: string, value?: ControllerDelegation) {
  if (!value || profile.privateKeys.identityPrivateKey) return
  const certificate = await validateControllerDelegation(profile, issuerDeviceId, value)
  if (certificate.signature === profile.certificate.signature) return
  if ((await bootstrapIdentity()).identity.personId !== profile.identity.personId) throw new Error("Identity changed during controller delegation")
  for (const item of [certificate, ...value.certificates]) await defaultProofStore.putCertificate(await certHashDefault(item), item)
  await adoptEnrolledIdentity(profile.identity, certificate)
  profile.certificate = certificate
  const certificateHash = await certHashDefault(certificate)
  await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, root => {
    const device = root?.devices[profile.device.deviceId]
    if (root && device) device.certificateHash = certificateHash
    return root
  })
}

async function validateControllerDelegation(profile: LocalProfile, issuerDeviceId: string, value: ControllerDelegation) {
  const certificate = value.certificate
  if (!Array.isArray(value.certificates) || value.certificates.length > 32 || certificate?.signerKeyId !== issuerDeviceId ||
    certificate.payload?.deviceId !== profile.device.deviceId || certificate.payload.personId !== profile.identity.personId ||
    certificate.payload.devicePublicKey !== profile.device.publicKey) throw new Error("Invalid device controller delegation")
  const issuer = value.certificates.find(item => item.payload.deviceId === issuerDeviceId)
  if (!issuer || certificate.payload.issuerCertificateHash !== await certHashDefault(issuer)) throw new Error("Invalid controller delegation issuer")
  await verifyDeviceChain({ personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    deviceId: profile.device.deviceId, certificates: [certificate, ...value.certificates] })
  return certificate
}
