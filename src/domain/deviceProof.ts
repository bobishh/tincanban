import { z } from "zod"
import { publicKeyId, verifyEnvelope, type SignedEnvelope } from "./identity"
import { certHashDefault, validateCertificateChain } from "./proofs"
import type { DeviceCertificate } from "./model"

const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

const deviceCertificateSchema = z.strictObject({
  payload: z.strictObject({
    kind: z.literal("device-certificate"), version: z.literal(1), personId: identifier, deviceId: identifier,
    devicePublicKey: z.string().min(1).max(128), issuerCertificateHash: hash.nullable(), canEnrollDevices: z.boolean(),
  }),
  signerKeyId: identifier, signature: z.string().min(1).max(128),
})

export const publicDeviceProofFields = {
  publicKey: z.string().min(1).max(128),
  certificates: z.array(deviceCertificateSchema).min(1).max(32),
}

/** Verify one signed device envelope and its complete, unique certificate chain. */
export async function verifyDeviceProofSignature(value: {
  publicKey: string
  certificates: DeviceCertificate[]
  signed: SignedEnvelope<{ kind: string }>
}, expectedPersonId: string, expectedDeviceId: string): Promise<DeviceCertificate> {
  const captured = structuredClone(value)
  if (await publicKeyId(captured.publicKey) !== expectedPersonId) throw new Error("Device proof identity key is invalid")
  const certificates = captured.certificates.map(certificate => deviceCertificateSchema.parse(certificate)) as DeviceCertificate[]
  const hashes = new Map<string, DeviceCertificate>()
  for (const certificate of certificates) {
    const hashValue = await certHashDefault(certificate)
    if (hashes.has(hashValue)) throw new Error("Device proof certificate chain contains duplicates")
    hashes.set(hashValue, certificate)
  }
  const leaves = certificates.filter(certificate => certificate.payload.deviceId === expectedDeviceId &&
    certificate.payload.personId === expectedPersonId && certificate.payload.devicePublicKey.length > 0)
  if (leaves.length !== 1 || captured.signed.signerKeyId !== expectedDeviceId) {
    throw new Error("Device proof signer is not uniquely identified")
  }
  const leaf = leaves[0]!
  let current: DeviceCertificate | undefined = leaf
  const visited = new Set<string>()
  while (current) {
    const currentHash = await certHashDefault(current)
    if (visited.has(currentHash)) throw new Error("Device proof certificate chain contains a cycle")
    visited.add(currentHash)
    const issuerHash = current.payload.issuerCertificateHash
    if (issuerHash === null) {
      if (visited.size !== certificates.length) throw new Error("Device proof contains certificates outside the signer chain")
      break
    }
    current = hashes.get(issuerHash)
    if (!current) throw new Error("Device proof certificate chain is incomplete")
  }
  const chain = await validateCertificateChain(leaf, captured.publicKey, certificates)
  if (!chain.ok || !await verifyEnvelope(captured.signed, leaf.payload.devicePublicKey)) {
    throw new Error("Device proof certificate chain or signature is invalid")
  }
  return leaf
}
