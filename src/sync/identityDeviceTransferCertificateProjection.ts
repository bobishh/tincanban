import { certificateHash, publicKeyId, verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import type { DeviceCertificate, PersonalRootDocumentV1 } from "../domain/model"
import { canonicalizeJson, verifyEnvelope } from "../domain/identity"
import { deviceCertificateSchema } from "./identityDeviceTransferSchemas"

type CertificateChain = { chain: DeviceCertificate[]; repeatedAncestor?: { index: number; certificate: DeviceCertificate } }

/** Drop only redundant same-key reissues whose signed path otherwise verifies completely. */
export async function projectRedundantDeviceCertificates(root: PersonalRootDocumentV1,
  input: DeviceCertificate[]): Promise<{ root: PersonalRootDocumentV1; certificates: DeviceCertificate[] }> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 512) throw new Error("Invalid device-state certificate evidence")
  if (await publicKeyId(root.identity.publicKey) !== root.identity.personId) throw new Error("Device-state identity does not match its key")

  const byHash = new Map<string, DeviceCertificate>()
  for (const value of input) {
    const certificate = deviceCertificateSchema.parse(value)
    const hash = await certificateHash(certificate)
    const previous = byHash.get(hash)
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(certificate)) {
      throw new Error("Conflicting device-state certificate evidence hash")
    }
    byHash.set(hash, certificate)
  }

  const redundant = new Map<string, { deviceId: string; ancestor: DeviceCertificate }>()
  for (const [hash, certificate] of byHash) {
    const result = await validateCertificatePath(root, certificate, byHash)
    if (!result.repeatedAncestor) {
      await verifyDeviceCertificateChain(root.identity, certificate.payload.deviceId, result.chain)
      continue
    }
    const { index, certificate: ancestor } = result.repeatedAncestor
    await verifyDeviceCertificateChain(root.identity, ancestor.payload.deviceId, result.chain.slice(index))
    redundant.set(hash, await assertRegisteredRedundancy(root, certificate, ancestor, hash))
  }

  const projectedRoot = structuredClone(root)
  const redundantDevices = new Map<string, DeviceCertificate>()
  for (const { deviceId, ancestor } of redundant.values()) {
    const previous = redundantDevices.get(deviceId)
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(ancestor)) {
      throw new Error("Conflicting redundant device certificate ancestors")
    }
    redundantDevices.set(deviceId, ancestor)
  }
  for (const [deviceId, ancestor] of redundantDevices) {
    const device = projectedRoot.devices[deviceId]!
    projectedRoot.devices[deviceId] = { ...device, certificateHash: await certificateHash(ancestor) }
  }

  return { root: projectedRoot, certificates: [...byHash].filter(([hash]) => !redundant.has(hash)).map(([, certificate]) => certificate) }
}

async function validateCertificatePath(root: PersonalRootDocumentV1, leaf: DeviceCertificate,
  byHash: ReadonlyMap<string, DeviceCertificate>): Promise<CertificateChain> {
  const chain: DeviceCertificate[] = []
  const visitedHashes = new Set<string>()
  const seenDevices = new Map<string, { publicKey: string }>()
  let repeatedAncestor: CertificateChain["repeatedAncestor"]
  let current = leaf
  while (true) {
    const certificate = deviceCertificateSchema.parse(current)
    const payload = certificate.payload
    if (payload.personId !== root.identity.personId || await publicKeyId(payload.devicePublicKey) !== payload.deviceId) {
      throw new Error("Invalid device-state certificate identity")
    }
    const previousDevice = seenDevices.get(payload.deviceId)
    if (previousDevice) {
      if (previousDevice.publicKey !== payload.devicePublicKey || repeatedAncestor) {
        throw new Error("Invalid repeated device-state certificate")
      }
      repeatedAncestor = { index: chain.length, certificate }
    } else seenDevices.set(payload.deviceId, { publicKey: payload.devicePublicKey })

    const hash = await certificateHash(certificate)
    if (visitedHashes.has(hash) || chain.length >= 32) throw new Error("Invalid device-state certificate chain")
    visitedHashes.add(hash)
    chain.push(certificate)

    const issuer = await verifiedIssuer(root, certificate, byHash)
    if (!issuer) {
      return { chain, ...(repeatedAncestor ? { repeatedAncestor } : {}) }
    }
    current = issuer
  }
}

async function assertRegisteredRedundancy(root: PersonalRootDocumentV1, leaf: DeviceCertificate,
  ancestor: DeviceCertificate, leafHash: string): Promise<{ deviceId: string; ancestor: DeviceCertificate }> {
  const deviceId = leaf.payload.deviceId
  const device = root.devices[deviceId]
  const ancestorHash = await certificateHash(ancestor)
  if (!device || device.deviceId !== deviceId || device.publicKey !== leaf.payload.devicePublicKey ||
      device.publicKey !== ancestor.payload.devicePublicKey ||
      leaf.payload.canEnrollDevices !== ancestor.payload.canEnrollDevices ||
      (device.certificateHash !== leafHash && device.certificateHash !== ancestorHash)) {
    throw new Error("Redundant device certificate is not bound to its registered device")
  }
  return { deviceId, ancestor }
}

async function verifiedIssuer(root: PersonalRootDocumentV1, certificate: DeviceCertificate,
  byHash: ReadonlyMap<string, DeviceCertificate>): Promise<DeviceCertificate | undefined> {
  const issuerHash = certificate.payload.issuerCertificateHash
  if (issuerHash === null) {
    if (certificate.signerKeyId !== root.identity.personId || !await verifyEnvelope(certificate, root.identity.publicKey)) {
      throw new Error("Invalid device-state root certificate")
    }
    return undefined
  }
  const issuer = byHash.get(issuerHash)
  if (!issuer || issuer.payload.personId !== root.identity.personId || !issuer.payload.canEnrollDevices ||
      certificate.signerKeyId !== issuer.payload.deviceId || !await verifyEnvelope(certificate, issuer.payload.devicePublicKey)) {
    throw new Error("Invalid device-state certificate link")
  }
  return issuer
}
