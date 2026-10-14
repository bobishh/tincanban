import { canonicalizeJson, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { readLocal, writeLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { loadReplicaConfigs, parseReplicaConfig } from "./blindReplicaSettings"
import type { BlindReplicaConfig } from "./blindReplication"
import { verifyDeviceChain } from "./meshRecords"
import type { WorkspaceSetStore } from "./workspaceSet"
import { identityDevicePreferencesChanged as changed } from "./identityDevicePreferenceEvents"
import { controllerDelegation, installControllerDelegation, type ControllerDelegation } from "./deviceEnrollmentDelegation"

type ReplicaPreference = { origin: string; scopeId: string; changedAt: number; config: BlindReplicaConfig | null }
const preferenceKey = (owner: string) => `tincanban.device-replica-preferences.v1.${owner}`
const configKey = (owner: string) => `tincanban.blind-replicas.v1.${owner}`
const key = (value: Pick<ReplicaPreference, "origin" | "scopeId">) => `${value.origin}/${value.scopeId}`
const portable = (config: BlindReplicaConfig): BlindReplicaConfig => ({ ...config, cursor: 0, lastUploaded: "" })

export function parseReplicaPreferences(raw: unknown): ReplicaPreference[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error("Invalid private Rusty preferences")
  const values = raw.map((value: ReplicaPreference) => {
    if (!value || typeof value.origin !== "string" || typeof value.scopeId !== "string" ||
      !Number.isSafeInteger(value.changedAt) || value.changedAt < 1) throw new Error("Invalid private Rusty preference")
    const config = value.config === null ? null : portable(parseReplicaConfig(JSON.stringify(value.config)))
    if (config && (config.origin !== value.origin || config.scopeId !== value.scopeId)) throw new Error("Rusty preference scope mismatch")
    return { origin: value.origin, scopeId: value.scopeId, changedAt: value.changedAt, config }
  })
  if (new Set(values.map(key)).size !== values.length) throw new Error("Duplicate private Rusty preference")
  return values
}
async function storedPreferences(owner: string) {
  return parseReplicaPreferences(JSON.parse(await readLocal(preferenceKey(owner)) ?? "[]"))
}

/** Older devices have local credentials but no shared preference record yet. */
export async function readReplicaPreferences(owner: string): Promise<ReplicaPreference[]> {
  return withLocalStateWriteLock(configKey(owner), async () => {
    const values = await storedPreferences(owner)
    const configs = await loadReplicaConfigs(owner)
    for (const config of configs) {
      if (!values.some(value => key(value) === key(config))) values.push({ origin: config.origin, scopeId: config.scopeId, changedAt: Date.now(), config: portable(config) })
    }
    if (values.length > 128) throw new Error("Too many private Rusty preferences")
    await writeLocal(preferenceKey(owner), JSON.stringify(values))
    return values
  })
}

export async function recordReplicaPreference(owner: string, config: BlindReplicaConfig, removed = false) {
  const updated = await withLocalStateWriteLock(configKey(owner), async () => {
    const values = await storedPreferences(owner)
    const previous = values.find(value => key(value) === key(config))
    const nextConfig = removed ? null : portable(config)
    if (previous && canonicalizeJson(previous.config) === canonicalizeJson(nextConfig)) return false
    const next = { origin: config.origin, scopeId: config.scopeId, changedAt: Math.max(Date.now(), (previous?.changedAt ?? 0) + 1), config: nextConfig }
    const merged = [...values.filter(value => key(value) !== key(config)), next]
    if (merged.length > 128) throw new Error("Too many private Rusty preferences")
    await writeLocal(preferenceKey(owner), JSON.stringify(merged))
    await applyPreferences(owner, merged)
    return true
  })
  if (updated) changed(owner)
}

export async function receiveReplicaPreferences(owner: string, raw: unknown) {
  const incoming = parseReplicaPreferences(raw)
  const updated = await withLocalStateWriteLock(configKey(owner), async () => {
    const previousValues = await storedPreferences(owner)
    const merged = new Map(previousValues.map(value => [key(value), value]))
    for (const value of incoming) {
      const previous = merged.get(key(value))
      if (!previous || value.changedAt > previous.changedAt || value.changedAt === previous.changedAt && canonicalizeJson(value) > canonicalizeJson(previous)) merged.set(key(value), value)
    }
    if (merged.size > 128) throw new Error("Too many private Rusty preferences")
    const values = [...merged.values()]
    const preferencesChanged = canonicalizeJson(previousValues) !== canonicalizeJson(values)
    if (preferencesChanged) await writeLocal(preferenceKey(owner), JSON.stringify(values))
    return await applyPreferences(owner, values) || preferencesChanged
  })
  if (updated) changed(owner)
}

async function applyPreferences(owner: string, values: ReplicaPreference[]) {
  let configs = await loadReplicaConfigs(owner)
  const previousConfigs = JSON.stringify(configs)
  for (const value of values) {
    const previous = configs.find(config => key(config) === key(value))
    configs = configs.filter(config => key(config) !== key(value))
    if (value.config) configs.push(previous && canonicalizeJson(portable(previous)) === canonicalizeJson(value.config) ? previous : value.config)
  }
  if (previousConfigs === JSON.stringify(configs)) return false
  await writeLocal(configKey(owner), JSON.stringify(configs))
  return true
}

export async function persistReplicaCursor(owner: string, config: BlindReplicaConfig, ensureIdentity: () => void) {
  return withLocalStateWriteLock(configKey(owner), async () => {
    ensureIdentity()
    const saved = await loadReplicaConfigs(owner)
    const previous = saved.find(value => key(value) === key(config))
    if (!previous || canonicalizeJson(portable(previous)) !== canonicalizeJson(portable(config))) throw new Error("Rusty access changed during replication")
    const values = saved.map(value => value === previous ? { ...config } : value)
    ensureIdentity()
    await writeLocal(configKey(owner), JSON.stringify(values))
    return values
  })
}

type PreferencePayload = { kind: "identity-device-preferences"; version: 1; personId: string; replicas: ReplicaPreference[]; delegation?: ControllerDelegation }
export function withIdentityDevicePreferences(store: WorkspaceSetStore, profile: LocalProfile, remotePersonId: string, remoteDeviceId: string,
  isCurrent: () => boolean = () => true): WorkspaceSetStore {
  if (remotePersonId !== profile.identity.personId) return store
  return { ...store,
    readMesh: async id => {
      const payload: PreferencePayload = { kind: "identity-device-preferences", version: 1, personId: profile.identity.personId,
        replicas: await readReplicaPreferences(profile.identity.personId),
        ...await controllerDelegation(profile, remoteDeviceId).then(delegation => delegation ? { delegation } : {}) }
      const record = await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId)
      return { ...await store.readMesh?.(id) as object, identityDevicePreferences: record }
    },
    mergeMesh: async (id, raw) => {
      const { identityDevicePreferences, ...mesh } = raw as Record<string, unknown>
      await store.mergeMesh?.(id, mesh)
      if (!identityDevicePreferences) return
      if (!isCurrent()) throw new Error("Device session is no longer authorized")
      const record = identityDevicePreferences as SignedEnvelope<PreferencePayload>
      if (JSON.stringify(record).length > 256 * 1024 || record.signerKeyId !== remoteDeviceId || record.payload?.kind !== "identity-device-preferences" ||
        record.payload.version !== 1 || record.payload.personId !== profile.identity.personId) throw new Error("Invalid identity device preferences")
      const publicKey = await verifyDeviceChain({ personId: profile.identity.personId, publicKey: profile.identity.publicKey,
        deviceId: remoteDeviceId, certificates: await defaultProofStore.listCertificates() })
      if (!await verifyEnvelope(record, publicKey)) throw new Error("Invalid identity device preferences signature")
      if (!isCurrent()) throw new Error("Device session is no longer authorized")
      await installControllerDelegation(profile, remoteDeviceId, record.payload.delegation)
      await receiveReplicaPreferences(profile.identity.personId, record.payload.replicas)
    },
  }
}
