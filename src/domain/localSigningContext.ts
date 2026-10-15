import { bootstrapIdentity, canonicalizeJson, toBase64Url, type LocalProfile } from "./identity"
import { defaultProofStore } from "./proofs"
import type { DeviceCertificate } from "./model"
import { resolveSigningContext } from "./signingContext"
import { readLocal } from "../localDb"

type LocalSigningOptions = {
  certificates?: DeviceCertificate[]
  currentAuthority?: () => Promise<string>
  ensureCurrent?: () => void | Promise<void>
  expiresAt?: number
  domain?: string
}
type DurablePublicIdentity = { personId: string; publicKey: string; displayName: string }
type DurableDevice = { deviceId: string; publicKey: string; displayName: string }
type DurableProfile = {
  identity: DurablePublicIdentity
  device: DurableDevice
  certificate: DeviceCertificate
  privateKeys: { identityPrivateKeyPkcs8?: string; devicePrivateKeyPkcs8: string }
}
const encodedPrivateKeys = new WeakMap<CryptoKey, Promise<string>>()

/** Bind browser producers to the active device. Scope policy remains enforced by the supplied authority guard. */
export async function resolveLocalSigningContext(profile: LocalProfile, purpose: string,
  binding: Record<string, string | number>, options: LocalSigningOptions = {}) {
  const snapshot = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
    certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } }
  const scope = structuredClone(binding)
  options = { ...options, ...(options.certificates ? { certificates: structuredClone(options.certificates) } : {}) }
  await options.ensureCurrent?.()
  await assertDurableIdentityProfile(snapshot)
  const authority = options.currentAuthority ? await options.currentAuthority() : ""
  const revision = (current: LocalProfile, rights: string) => canonicalizeJson([current.certificate.signature, rights])
  return resolveSigningContext({ profile: snapshot, purpose, binding: scope, domain: options.domain, expiresAt: options.expiresAt,
    certificates: options.certificates ?? await defaultProofStore.listCertificates(), authorityRevision: revision(snapshot, authority),
    current: async () => {
      await options.ensureCurrent?.()
      await assertDurableIdentityProfile(snapshot)
      const current = await bootstrapIdentity()
      const rights = options.currentAuthority ? await options.currentAuthority() : ""
      await options.ensureCurrent?.()
      await assertDurableIdentityProfile(snapshot)
      return { personId: current.identity.personId, deviceId: current.device.deviceId, authorityRevision: revision(current, rights) }
    },
  })
}

async function assertDurableIdentityProfile(expected: LocalProfile): Promise<void> {
  const stale = () => new Error("Stale identity profile or signing key: reload before signing")
  const deviceKey = await encodedPrivateKey(expected.privateKeys.devicePrivateKey)
  const identityKey = expected.privateKeys.identityPrivateKey ? await encodedPrivateKey(expected.privateKeys.identityPrivateKey) : undefined
  let raw: string | null
  try { raw = await readLocal("tincanban.local_profile.v1") } catch { throw stale() }
  if (!raw) throw stale()

  let stored: unknown
  try { stored = JSON.parse(raw) as unknown } catch { throw stale() }
  if (!isDurableProfile(stored)) throw stale()
  if (stored.identity.personId !== expected.identity.personId || stored.identity.publicKey !== expected.identity.publicKey ||
      stored.device.deviceId !== expected.device.deviceId || stored.device.publicKey !== expected.device.publicKey ||
      stored.certificate.signature !== expected.certificate.signature ||
      canonicalizeJson(stored.certificate) !== canonicalizeJson(expected.certificate) ||
      stored.privateKeys.devicePrivateKeyPkcs8 !== deviceKey || stored.privateKeys.identityPrivateKeyPkcs8 !== identityKey) throw stale()
}

/** Local profiles already persist exportable PKCS8 keys. Cache by immutable CryptoKey, never by mutable profile metadata. */
function encodedPrivateKey(key: CryptoKey): Promise<string> {
  let encoded = encodedPrivateKeys.get(key)
  if (!encoded) {
    encoded = crypto.subtle.exportKey("pkcs8", key).then(value => toBase64Url(new Uint8Array(value)))
    encodedPrivateKeys.set(key, encoded)
  }
  return encoded
}

function isDurableProfile(value: unknown): value is DurableProfile {
  if (!isRecord(value) || !hasKeys(value, ["identity", "device", "certificate", "privateKeys"])) return false
  return isDurablePublicIdentity(value.identity) && isDurableDevice(value.device) &&
    isDurableCertificate(value.certificate) && isDurablePrivateKeys(value.privateKeys)
}

function isDurablePublicIdentity(value: unknown): value is DurablePublicIdentity {
  return isRecord(value) && hasKeys(value, ["personId", "publicKey", "displayName"]) &&
    nonEmptyString(value.personId) && nonEmptyString(value.publicKey) && typeof value.displayName === "string"
}

function isDurableDevice(value: unknown): value is DurableDevice {
  return isRecord(value) && hasKeys(value, ["deviceId", "publicKey", "displayName"]) &&
    nonEmptyString(value.deviceId) && nonEmptyString(value.publicKey) && typeof value.displayName === "string"
}

function isDurableCertificate(value: unknown): value is DeviceCertificate {
  if (!isRecord(value) || !hasKeys(value, ["payload", "signerKeyId", "signature"]) ||
      !nonEmptyString(value.signerKeyId) || !nonEmptyString(value.signature) || !isRecord(value.payload)) return false
  const payload = value.payload
  return hasKeys(payload, ["kind", "version", "personId", "deviceId", "devicePublicKey", "issuerCertificateHash", "canEnrollDevices"]) &&
    payload.kind === "device-certificate" && payload.version === 1 && nonEmptyString(payload.personId) &&
    nonEmptyString(payload.deviceId) && nonEmptyString(payload.devicePublicKey) &&
    (payload.issuerCertificateHash === null || typeof payload.issuerCertificateHash === "string") &&
    typeof payload.canEnrollDevices === "boolean"
}

function isDurablePrivateKeys(value: unknown): value is DurableProfile["privateKeys"] {
  if (!isRecord(value) || Object.keys(value).some(key => !["identityPrivateKeyPkcs8", "devicePrivateKeyPkcs8"].includes(key)) ||
      !nonEmptyString(value.devicePrivateKeyPkcs8)) return false
  return value.identityPrivateKeyPkcs8 === undefined || nonEmptyString(value.identityPrivateKeyPkcs8)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
