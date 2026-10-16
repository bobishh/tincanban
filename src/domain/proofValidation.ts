import type { DeviceCertificate } from "./model"
import { canonicalizeJson, sha256Base64Url, verifyEnvelope } from "./identityCrypto"

export type ChainValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export type ChainValidationOptions = {
  hashFn?: (cert: DeviceCertificate) => string | Promise<string>
  skipSigVerify?: boolean
}

export async function certHashDefault(cert: DeviceCertificate): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeJson(cert))
  return sha256Base64Url(bytes)
}

export async function validateCertificateChain(
  cert: DeviceCertificate,
  identityPublicKey: string,
  certPool: DeviceCertificate[],
  options: ChainValidationOptions = {},
): Promise<ChainValidationResult> {
  const getHash = options.hashFn ?? certHashDefault
  let current = cert
  const visited = new Set<string>()
  let depth = 0

  while (current) {
    depth++
    if (depth > 32) {
      return { ok: false, error: "Certificate chain depth exceeds limit 32" }
    }

    const currentHash = await getHash(current)
    if (visited.has(currentHash)) {
      return { ok: false, error: "Cycle detected in certificate chain" }
    }
    visited.add(currentHash)

    if (current.payload.issuerCertificateHash === null) {
      return verifyRootCertificate(current, identityPublicKey, options.skipSigVerify)
    }

    const issuerHash = current.payload.issuerCertificateHash
    if (visited.has(issuerHash)) {
      return { ok: false, error: "Cycle detected in certificate chain" }
    }

    const issuer = await findCertificate(certPool, issuerHash, getHash)
    if (!issuer) return { ok: false, error: `Missing issuer certificate for hash ${issuerHash}` }

    const delegation = await validateDelegation(current, issuer, options.skipSigVerify)
    if (!delegation.ok) return delegation
    current = issuer
  }

  return { ok: true }
}

async function verifyRootCertificate(cert: DeviceCertificate, publicKey: string, skipVerify?: boolean): Promise<ChainValidationResult> {
  if (skipVerify || await verifyEnvelope(cert, publicKey)) return { ok: true }
  return { ok: false, error: "Root certificate signature invalid" }
}

async function findCertificate(pool: DeviceCertificate[], hash: string,
  getHash: NonNullable<ChainValidationOptions["hashFn"]>): Promise<DeviceCertificate | undefined> {
  for (const certificate of pool) if (await getHash(certificate) === hash) return certificate
  return undefined
}

async function validateDelegation(current: DeviceCertificate, issuer: DeviceCertificate,
  skipVerify?: boolean): Promise<ChainValidationResult> {
  if (issuer.payload.personId !== current.payload.personId) return { ok: false, error: "Issuer personId does not match subject personId" }
  if (!issuer.payload.canEnrollDevices) return { ok: false, error: "Issuer certificate lacks canEnrollDevices capability" }
  if (skipVerify || await verifyEnvelope(current, issuer.payload.devicePublicKey)) return { ok: true }
  return { ok: false, error: "Certificate signature invalid under issuer key" }
}
