import { certificateHash, verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { canonicalizeJson, signEnvelope, verifyEnvelope, type SignedEnvelope } from "./identityCrypto"
import type { LocalProfile } from "./identity"
import type { DeviceCertificate, PublicIdentity } from "./model"

type CurrentAuthority = { personId: string; deviceId: string; authorityRevision: string }
export type SigningContextRequest = {
  profile: LocalProfile
  certificates: DeviceCertificate[]
  purpose: string
  binding?: Record<string, string | number>
  authorityRevision: string
  current: () => Promise<CurrentAuthority>
  domain?: string
  signer?: "device" | "identity"
  expiresAt?: number
  now?: () => number
}
export type VerifiedSigningContext = Readonly<CurrentAuthority & { purpose: string; domain: string }>
type Evidence = { identity: PublicIdentity; certificates: DeviceCertificate[]; publicKey: string; signerKeyId: string }
type Internal = { key: CryptoKey; evidence: Evidence; purpose: string; domain: string; binding: Record<string, string | number>;
  revision: string; current: SigningContextRequest["current"]; now: () => number; expiresAt?: number; resolvedAt: number }
const contexts = new WeakMap<VerifiedSigningContext, Internal>()
const verifiedKeys = new WeakMap<CryptoKey, Map<string, Evidence>>()
const copy = <T>(value: T): T => structuredClone(value)

/** Resolve identity proof and live scope binding; the current-authority provider must enforce its policy. */
export async function resolveSigningContext(request: SigningContextRequest): Promise<VerifiedSigningContext> {
  const snapshot = snapshotRequest(request)
  const evidence = await verifiedSigningEvidence(snapshot)
  const key = signingKey(snapshot)
  const now = snapshot.now ?? Date.now
  const domain = snapshot.domain ?? "MATCH/1"
  const context = Object.freeze({ personId: snapshot.profile.identity.personId, deviceId: snapshot.profile.device.deviceId,
    authorityRevision: snapshot.authorityRevision, purpose: snapshot.purpose, domain })
  const value: Internal = { key, evidence, purpose: snapshot.purpose, domain, binding: snapshot.binding ?? {},
    revision: snapshot.authorityRevision, current: snapshot.current, now, expiresAt: snapshot.expiresAt, resolvedAt: now() }
  await assertCurrent(context, value)
  contexts.set(context, value)
  return context
}

/** Freeze caller-owned inputs before the first cryptographic await. The authority callback remains live. */
function snapshotRequest(request: SigningContextRequest): SigningContextRequest {
  if (!request || !request.purpose || request.purpose.length > 128 || !request.authorityRevision ||
    typeof request.current !== "function") throw new Error("Signing purpose and authority are required")
  const domain = request.domain ?? "MATCH/1"
  const binding = copy(request.binding ?? {})
  if (!domain || domain.length > 64 || Object.values(binding).some(value => !isBindingValue(value))) throw new Error("Invalid signing context binding")
  validateRequestEvidence(request)
  return { ...request, domain, binding, certificates: copy(request.certificates), profile: {
    ...request.profile, identity: copy(request.profile.identity), device: copy(request.profile.device),
    certificate: copy(request.profile.certificate), privateKeys: { ...request.profile.privateKeys },
  } }
}

function isBindingValue(value: unknown): value is string | number {
  return typeof value === "string" ? value.length > 0 : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validateRequestEvidence(request: SigningContextRequest) {
  validatePublicIdentity(request.profile?.identity)
  validateCertificate(request.profile?.certificate)
  if (!Array.isArray(request.certificates) || request.certificates.length > 512) throw new Error("Invalid signing certificate evidence")
  request.certificates.forEach(validateCertificate)
  if (request.expiresAt !== undefined && (!Number.isFinite(request.expiresAt) || request.expiresAt < 0)) throw new Error("Invalid signing expiry")
  if (request.signer !== undefined && !["device", "identity"].includes(request.signer)) throw new Error("Invalid signing mode")
}

function exactObject(value: unknown, fields: readonly string[], label: string): asserts value is Record<string, unknown> {
  const prototype: unknown = value && typeof value === "object" ? Object.getPrototypeOf(value as object) as unknown : undefined
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (prototype !== Object.prototype && prototype !== null) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new Error(`Invalid ${label} schema`)
  }
}

function validatePublicIdentity(value: unknown): asserts value is PublicIdentity {
  exactObject(value, ["personId", "publicKey", "displayName"], "public identity evidence")
  if (typeof value.personId !== "string" || !value.personId || typeof value.publicKey !== "string" || !value.publicKey ||
      typeof value.displayName !== "string") throw new Error("Invalid public identity evidence")
}

function validateCertificate(value: unknown): asserts value is DeviceCertificate {
  exactObject(value, ["payload", "signerKeyId", "signature"], "signing certificate evidence")
  validateCertificateEnvelopeMetadata(value)
  exactObject(value.payload, ["kind", "version", "personId", "deviceId", "devicePublicKey", "issuerCertificateHash", "canEnrollDevices"],
    "signing certificate payload")
  validateCertificatePayload(value.payload)
}

function validateCertificateEnvelopeMetadata(value: Record<string, unknown>) {
  if (typeof value.signerKeyId !== "string" || !value.signerKeyId || typeof value.signature !== "string" || !value.signature) {
    throw new Error("Invalid signing certificate evidence")
  }
}

function validateCertificatePayload(payload: Record<string, unknown>) {
  if (payload.kind !== "device-certificate" || payload.version !== 1 || typeof payload.personId !== "string" ||
      !payload.personId || typeof payload.deviceId !== "string" || !payload.deviceId ||
      typeof payload.devicePublicKey !== "string" || !payload.devicePublicKey ||
      !(payload.issuerCertificateHash === null || typeof payload.issuerCertificateHash === "string") ||
      typeof payload.canEnrollDevices !== "boolean") throw new Error("Invalid signing certificate payload")
}

function signingKey(request: SigningContextRequest): CryptoKey {
  const key = request.signer === "identity" ? request.profile.privateKeys.identityPrivateKey : request.profile.privateKeys.devicePrivateKey
  if (!key) throw new Error("Signing key is unavailable")
  return key
}

async function verifiedSigningEvidence(request: SigningContextRequest): Promise<Evidence> {
  const { identity, device, certificate: leaf } = request.profile
  const key = signingKey(request)
  const rootSigner = request.signer === "identity"
  const domain = request.domain!
  const pool = [leaf, ...request.certificates].filter(certificate => certificate.payload?.personId === identity.personId)
  const fingerprint = canonicalizeJson([identity.personId, identity.publicKey, device.deviceId, device.publicKey, leaf,
    pool.map(certificate => canonicalizeJson(certificate)).sort(), domain, rootSigner])
  let cached = verifiedKeys.get(key)
  if (!cached) { cached = new Map(); verifiedKeys.set(key, cached) }
  const prior = cached.get(fingerprint)
  if (prior) return prior
  const certificates = await completeChain(leaf, pool)
  const deviceKey = await verifyDeviceCertificateChain(identity, device.deviceId, certificates, "MATCH/1")
  if (deviceKey !== device.publicKey || leaf.payload.devicePublicKey !== device.publicKey) throw new Error("Certified signing device key mismatch")
  const publicKey = rootSigner ? identity.publicKey : deviceKey
  const signerKeyId = rootSigner ? identity.personId : device.deviceId
  const probe = await signEnvelope(key, { kind: "signing-key-binding", personId: identity.personId, deviceId: device.deviceId }, signerKeyId, domain)
  if (!await verifyEnvelope(probe, publicKey, domain)) throw new Error("Private signing key does not match its certified signer")
  const evidence = { identity, certificates, publicKey, signerKeyId }
  cached.set(fingerprint, evidence)
  if (cached.size > 128) cached.delete(cached.keys().next().value!)
  return evidence
}

async function completeChain(leaf: DeviceCertificate, pool: DeviceCertificate[]): Promise<DeviceCertificate[]> {
  const byHash = new Map<string, DeviceCertificate>()
  for (const certificate of pool) byHash.set(await certificateHash(certificate), certificate)
  const certificates: DeviceCertificate[] = []
  const seen = new Set<string>()
  let current: DeviceCertificate | undefined = leaf
  while (current && certificates.length < 32) {
    const hash = await certificateHash(current)
    if (seen.has(hash)) throw new Error("Cyclic signing certificate chain")
    seen.add(hash); certificates.push(current)
    if (current.payload.issuerCertificateHash === null) return certificates
    current = byHash.get(current.payload.issuerCertificateHash)
  }
  throw new Error("Missing signing certificate ancestor or excessive chain depth")
}

async function assertCurrent(context: VerifiedSigningContext, value: Internal) {
  const assertTime = () => {
    if (value.now() < value.resolvedAt) throw new Error("Signing context clock moved before validation")
    if (value.expiresAt !== undefined && value.now() >= value.expiresAt) throw new Error("Signing context expired")
  }
  assertTime()
  const current = await value.current()
  assertTime()
  if (current.personId !== context.personId || current.deviceId !== context.deviceId || current.authorityRevision !== value.revision) {
    throw new Error("Signing context identity or authority is stale")
  }
}

function internal(context: VerifiedSigningContext): Internal {
  const value = contexts.get(context)
  if (!value) throw new Error("Unknown or forged signing context")
  return value
}

/** Revalidate an opaque context before non-signing I/O that carries private credentials. */
export async function assertSigningContextCurrent(context: VerifiedSigningContext): Promise<void> {
  await assertCurrent(context, internal(context))
}

/** Sign a private copy only after live authorization; repeat the guard after asynchronous crypto. */
export async function signWithContext<T extends { kind: string }>(context: VerifiedSigningContext, payload: T): Promise<SignedEnvelope<T>> {
  const value = internal(context)
  const snapshot = copy(payload)
  if (snapshot.kind !== value.purpose) throw new Error("Signing payload purpose does not match context")
  const fields = snapshot as Record<string, unknown>
  if (Object.entries(value.binding).some(([field, expected]) => fields[field] !== expected)) throw new Error("Signing payload scope binding does not match context")
  await assertCurrent(context, value)
  const signed = await signEnvelope(value.key, snapshot, value.evidence.signerKeyId, value.domain)
  await assertCurrent(context, value)
  return signed
}

export function signingEvidence(context: VerifiedSigningContext): Evidence { return copy(internal(context).evidence) }
