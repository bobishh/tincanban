import {
  BrowserIdentityStore,
  generateIdentityRecovery,
  identitySeedFromPrivateKey,
  identitySecurityForRecovery,
  openIdentityRecoveryEnvelope,
  sealIdentitySeed,
  type IdentityRecoveryEnvelope,
  type IdentitySecurity,
  type IdentityAdoptionCommit,
  type LocalProfile as MeshLocalProfile,
} from "@meta-uber/mesh-identity"
import {
  canonicalizeJson,
  fromBase64Url,
  publicKeyId,
  sha256Base64Url,
  signEnvelope,
  toBase64Url,
  verifyEnvelope,
  type SignedEnvelope,
} from "./identityCrypto"
import type {
  DeviceCertificate,
  PublicIdentity,
} from "./model"
import { readLocal, writeLocal, deleteLocal, compareAndSwapLocal } from "../localDb"
import { normalizeDisplayName, unprovidedDisplayName, validateDisplayName } from "../chat/names"
import { identityNameChoiceKey, planIdentityNameChoice } from "./identityNameChoice"
import { requestWebLock } from "../webLock"

export { canonicalizeJson, fromBase64Url, publicKeyId, sha256Base64Url, signEnvelope, toBase64Url, verifyEnvelope }
export type { SignedEnvelope }
export type { IdentityRecoveryEnvelope, IdentitySecurity }

export type LocalProfile = MeshLocalProfile & {
  identity: PublicIdentity
  certificate: DeviceCertificate
}

/** Snapshot mutable profile data without cloning browser-owned CryptoKey handles. */
export function captureIdentityProfile(profile: LocalProfile): LocalProfile {
  return { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
    certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } }
}

const profileStorageKey = "tincanban.local_profile.v1"
let creatingUnprovidedName = false
async function persistIdentityProfile(key: string, value: string): Promise<void> {
  if (key !== profileStorageKey || !creatingUnprovidedName || identityInitialized) return writeLocal(key, value)
  const profile = JSON.parse(value) as { identity: PublicIdentity }
  const markerKey = identityNameChoiceKey(profile.identity.personId)
  const committed = await compareAndSwapLocal({
    conditions: [{ key, value: null }, { key: markerKey, value: null }],
    writes: [{ key, value }, { key: markerKey, value: unprovidedDisplayName }],
  })
  if (!committed) throw new Error("Identity changed while creating this profile")
}

const identityStore = new BrowserIdentityStore({
  storageKey: profileStorageKey,
  signatureDomain: "MATCH/1",
  asyncStorage: { getItem: readLocal, setItem: persistIdentityProfile, removeItem: deleteLocal },
  requirePersistence: true,
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
    const name = normalizeDisplayName(displayName ?? "")
    creatingUnprovidedName = !name
    try { return await identityStore.bootstrap(name || unprovidedDisplayName) }
    finally { creatingUnprovidedName = false }
  }
  // Cross-tab exclusion protects creation/restoration. Cached reads must not
  // wait for another tab's scheduler on every scope/catalog operation.
  if (identityInitialized) return bootstrap()
  identityBootstrap ??= (async () => {
    const profile = typeof navigator !== "undefined" && navigator.locks
      ? await requestWebLock("tincanban-identity-bootstrap", bootstrap)
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
  return await identityStore.rename(normalized, commit ?? (async (rename, ensureCurrent) => {
    const choice = await planIdentityNameChoice(rename.publicProfile.identity.personId)
    const committed = await compareAndSwapLocal({
      conditions: [...choice.conditions, { key: rename.storageKey, value: rename.previousProfile }],
      writes: [...choice.writes, { key: rename.storageKey, value: rename.candidateProfile }],
    }, ensureCurrent)
    if (!committed) throw new Error("Identity changed while saving this name")
  }))
}

export async function refreshIdentityPresentation(expectedRaw?: string): Promise<LocalProfile> {
  return await identityStore.refreshPresentation(expectedRaw)
}

export async function renewDeviceIdentity(): Promise<LocalProfile> {
  const renew = () => identityStore.renewDevice()
  return typeof navigator !== "undefined" && navigator.locks
    ? await requestWebLock("tincanban-identity-bootstrap", renew) : await renew()
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
  return await identityStore.restoreEnvelope(envelope, recoveryKey, displayName, commit)
}

export async function adoptEnrolledIdentity(
  identity: PublicIdentity,
  certificate: DeviceCertificate,
  commit?: IdentityAdoptionCommit,
): Promise<LocalProfile> {
  return await identityStore.adopt(identity, certificate, commit)
}

/** Adopt only an explicitly enrolled device for the current person; never replace local identity data. */
export async function adoptEnrolledIdentityDevice(
  submitted: MeshLocalProfile,
  certificates: DeviceCertificate[],
  expectedPersonId: string,
  commit?: IdentityAdoptionCommit,
  signal?: AbortSignal,
): Promise<LocalProfile> {
  const adopt = async () => {
    const current = await bootstrapIdentity()
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Identity enrollment was cancelled", "AbortError")
    if (current.identity.personId !== expectedPersonId || submitted.identity.personId !== expectedPersonId ||
        submitted.identity.publicKey !== current.identity.publicKey) {
      throw new Error("The approved device belongs to another person")
    }
    if (!identityStore.isCurrentProfile(current)) throw new Error("Identity changed during device adoption")
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Identity enrollment was cancelled", "AbortError")
    const adopted = await identityStore.adoptEnrolledDevice(submitted, certificates,
      { consentToReplaceExistingIdentity: true, ...(commit ? { commit } : {}) })
    return { ...adopted, identity: adopted.identity as PublicIdentity,
      certificate: adopted.certificate as DeviceCertificate }
  }
  return typeof navigator !== "undefined" && navigator.locks
    ? await requestWebLock("tincanban-identity-bootstrap", adopt) : await adopt()
}

/** Replace this browser's person only after the caller has obtained explicit user consent. */
export async function replaceWithEnrolledIdentityDevice(
  submitted: MeshLocalProfile,
  certificates: DeviceCertificate[],
  expectedCurrent: LocalProfile,
  options: { consentToReplaceExistingIdentity: boolean; commit?: IdentityAdoptionCommit; signal?: AbortSignal },
): Promise<LocalProfile> {
  if (!options.consentToReplaceExistingIdentity) throw new Error("Confirm replacing the local Identity before continuing")
  if (submitted.identity.personId === expectedCurrent.identity.personId) {
    throw new Error("Identity replacement requires a different person")
  }
  const replace = async () => {
    const current = await bootstrapIdentity()
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("Identity enrollment was cancelled", "AbortError")
    if (current.identity.personId !== expectedCurrent.identity.personId ||
        current.identity.publicKey !== expectedCurrent.identity.publicKey ||
        current.device.deviceId !== expectedCurrent.device.deviceId || !identityStore.isCurrentProfile(expectedCurrent)) {
      throw new Error("Local Identity changed before replacement")
    }
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("Identity enrollment was cancelled", "AbortError")
    const adopted = await identityStore.adoptEnrolledDevice(submitted, certificates,
      { consentToReplaceExistingIdentity: true, ...(options.commit ? { commit: options.commit } : {}) })
    return { ...adopted, identity: adopted.identity as PublicIdentity,
      certificate: adopted.certificate as DeviceCertificate }
  }
  return typeof navigator !== "undefined" && navigator.locks
    ? await requestWebLock("tincanban-identity-bootstrap", replace) : await replace()
}

export function isCurrentIdentityProfile(profile: LocalProfile): boolean { return identityStore.isCurrentProfile(profile) }
