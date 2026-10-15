import {
  BrowserIdentityStore,
  canonicalizeJson,
  fromBase64Url,
  publicKeyId,
  sha256Base64Url,
  signEnvelope,
  toBase64Url,
  verifyEnvelope,
  generateIdentityRecovery,
  identitySeedFromPrivateKey,
  identitySecurityForRecovery,
  openIdentityRecoveryEnvelope,
  sealIdentitySeed,
  type IdentityRecoveryEnvelope,
  type IdentitySecurity,
  type IdentityAdoptionCommit,
  type LocalProfile as MeshLocalProfile,
  type SignedEnvelope,
} from "@meta-uber/mesh-identity"
import type {
  DeviceCertificate,
  PublicIdentity,
} from "./model"
import { readLocal, writeLocal, deleteLocal } from "../localDb"
import { normalizeDisplayName, randomDisplayName, validateDisplayName } from "../chat/names"

export {
  canonicalizeJson,
  fromBase64Url,
  publicKeyId,
  sha256Base64Url,
  signEnvelope,
  toBase64Url,
  verifyEnvelope,
}
export type { SignedEnvelope }
export type { IdentityRecoveryEnvelope, IdentitySecurity }

export type LocalProfile = MeshLocalProfile & {
  identity: PublicIdentity
  certificate: DeviceCertificate
}

const identityStore = new BrowserIdentityStore({
  storageKey: "tincanban.local_profile.v1",
  signatureDomain: "MATCH/1",
  asyncStorage: { getItem: readLocal, setItem: writeLocal, removeItem: deleteLocal },
  requirePersistence: typeof indexedDB !== "undefined",
})
const recoveryStorageKey = "tincanban.identity_recovery.v1"
let identityInitialized = false
let identityBootstrap: Promise<LocalProfile> | undefined

export function clearInMemoryProfileForReloadTest(): void {
  identityInitialized = false
  identityBootstrap = undefined
  identityStore.clearMemory()
}

export function resetIdentityStorageForTest(): void {
  identityInitialized = false
  identityBootstrap = undefined
  identityStore.reset()
}

export async function bootstrapIdentity(displayName?: string): Promise<LocalProfile> {
  const bootstrap = async () => {
    const profile = await identityStore.bootstrap(normalizeDisplayName(displayName ?? "") || randomDisplayName()) as LocalProfile
    return !normalizeDisplayName(profile.identity.displayName) || ["Match User", "tincanban User"].includes(profile.identity.displayName)
      ? await identityStore.rename(randomDisplayName()) as LocalProfile
      : profile
  }
  // Cross-tab exclusion protects creation/restoration. Cached reads must not
  // wait for another tab's scheduler on every scope/catalog operation.
  if (identityInitialized) return bootstrap()
  identityBootstrap ??= (async () => {
    const profile = typeof navigator !== "undefined" && navigator.locks
      ? await navigator.locks.request("tincanban-identity-bootstrap", bootstrap)
      : await bootstrap()
    identityInitialized = true
    return profile
  })().finally(() => { identityBootstrap = undefined })
  return identityBootstrap
}

export async function renameIdentity(displayName: string, commit?: IdentityAdoptionCommit): Promise<LocalProfile> {
  const normalized = normalizeDisplayName(displayName)
  const error = validateDisplayName(normalized)
  if (error) throw new Error(error)
  return await identityStore.rename(normalized, commit) as LocalProfile
}

export async function refreshIdentityPresentation(expectedRaw?: string): Promise<LocalProfile> {
  return await identityStore.refreshPresentation(expectedRaw) as LocalProfile
}

export async function renewDeviceIdentity(): Promise<LocalProfile> {
  const renew = () => identityStore.renewDevice() as Promise<LocalProfile>
  return typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request("tincanban-identity-bootstrap", renew) : await renew()
}

/** Creates an encrypted backup of the existing identity root; it never rotates identity. */
export async function createIdentityRecovery(
  security: IdentitySecurity = "better",
): Promise<{ recoveryKey: string; recoveryEnvelope: IdentityRecoveryEnvelope }> {
  const profile = await bootstrapIdentity()
  const key = profile.privateKeys.identityPrivateKey
  if (!key) throw new Error("This device cannot back up the workspace identity")
  const seed = await identitySeedFromPrivateKey(key, profile.identity.personId)
  const recoveryKey = generateIdentityRecovery(security)
  const recoveryEnvelope = await sealIdentitySeed(seed, profile.identity.personId, recoveryKey, security)
  const restored = await openIdentityRecoveryEnvelope(recoveryEnvelope, recoveryKey, profile.identity.displayName)
  if (restored.identity.personId !== profile.identity.personId) throw new Error("Identity backup does not match this identity")
  await writeLocal(recoveryStorageKey, JSON.stringify(recoveryEnvelope))
  return { recoveryKey, recoveryEnvelope }
}

export async function restoreIdentityRecovery(
  envelope: IdentityRecoveryEnvelope,
  recoveryKey: string,
  displayName: string,
  replaceExisting = false,
  beforeRestore?: () => Promise<void>,
  commit?: IdentityAdoptionCommit,
): Promise<LocalProfile> {
  if (!identitySecurityForRecovery(recoveryKey)) throw new Error("Invalid recovery words")
  const current = await bootstrapIdentity(displayName)
  const candidate = await openIdentityRecoveryEnvelope(envelope, recoveryKey, displayName)
  if (!isCurrentIdentityProfile(current)) throw new Error("Identity changed during recovery")
  if (current.identity.personId !== candidate.identity.personId && !replaceExisting)
    throw new Error("Confirm identity replacement before restoring a different identity")
  await beforeRestore?.()
  if (!isCurrentIdentityProfile(current)) throw new Error("Identity changed during recovery")
  return await identityStore.restoreEnvelope(envelope, recoveryKey, displayName, commit) as LocalProfile
}

export async function adoptEnrolledIdentity(
  identity: PublicIdentity,
  certificate: DeviceCertificate,
  commit?: IdentityAdoptionCommit,
): Promise<LocalProfile> {
  return await identityStore.adopt(identity, certificate, commit) as LocalProfile
}

export function isCurrentIdentityProfile(profile: LocalProfile): boolean { return identityStore.isCurrentProfile(profile) }
