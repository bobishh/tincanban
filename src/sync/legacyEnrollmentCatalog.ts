import { certificateHash } from "@meta-uber/mesh-identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"

const deviceFields = new Set(["deviceId", "publicKey", "displayName", "certificateHash", "addedAt"])
const requestFields = new Set(["kind", "version", "invitationId"])

/** Project only the known released enrollment spread; keep the original local catalog intact. */
export async function projectLegacyEnrollmentCatalog(root: PersonalRootDocumentV1,
  certificates: DeviceCertificate[]): Promise<PersonalRootDocumentV1> {
  const byHash = new Map(await Promise.all(certificates.map(async certificate =>
    [await certificateHash(certificate), certificate] as const)))
  const devices = { ...root.devices }
  for (const [id, device] of Object.entries(devices)) {
    const row = device as typeof device & Record<string, unknown>
    const extras = Object.keys(row).filter(key => !deviceFields.has(key))
    if (!extras.length) continue
    if (extras.length !== requestFields.size || extras.some(key => !requestFields.has(key)) ||
      row.kind !== "device-enrollment-request" || row.version !== 2 || typeof row.invitationId !== "string" ||
      !row.invitationId.length || row.invitationId.length > 512) {
      throw new Error("Unsupported registered-device metadata")
    }
    const certificate = byHash.get(device.certificateHash)
    if (!certificate || device.deviceId !== id || certificate.payload.personId !== root.identity.personId ||
      certificate.payload.deviceId !== id || certificate.payload.devicePublicKey !== device.publicKey) {
      throw new Error("Registered device does not match its certificate")
    }
    devices[id] = { deviceId: device.deviceId, publicKey: device.publicKey, displayName: device.displayName,
      certificateHash: device.certificateHash, addedAt: device.addedAt }
  }
  return { ...root, devices }
}
