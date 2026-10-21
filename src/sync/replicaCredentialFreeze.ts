import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import type { PrivateReplicaConfig } from "./blindReplication"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { rotateReplicaContentKeys } from "./replicaContentKeys"
import { exportPrivateReplicaState, getPrivateReplicaConfigurations, getPrivateReplicaConflictSummaries,
  planPrivateReplicaImport, privateReplicaBinding, privateReplicaStateStorageKey, readReplicaWriterUpgrade } from "./privateReplicaRepository"
import { replicaCredentialFreezeKey, readReplicaCredentialFreeze, parseReplicaCredentialFreeze as parseFreeze, type ReplicaCredentialFreeze } from "./replicaCredentialFreezeState"
export { replicaCredentialFreezeKey, parseReplicaCredentialFreeze, readReplicaCredentialFreeze,
  assertReplicaCredentialsUnfrozen, replicaCredentialOriginCondition, replicaCredentialFreezeCondition,
  type ReplicaCredentialFreeze } from "./replicaCredentialFreezeState"
const profileKey = "tincanban.local_profile.v1"

function assertFreezeProfile(raw: string | null, profile: LocalProfile) {
  const stored = raw ? JSON.parse(raw) as LocalProfile : undefined
  if (!stored || stored.identity?.personId !== profile.identity.personId || stored.identity.publicKey !== profile.identity.publicKey ||
      stored.device?.deviceId !== profile.device.deviceId || stored.device.publicKey !== profile.device.publicKey ||
      canonicalizeJson(stored.certificate) !== canonicalizeJson(profile.certificate)) throw new Error("Credential transition signing profile is stale")
}

/** Freeze every known scope before person-wide revocation. Existing queues and original credentials remain intact. */
export async function prepareReplicaCredentialFreeze(profile: LocalProfile, origin: string, servicePublicKey: string,
  revokedDeviceId: string, guard: () => void,
  preflight?: (configurations: readonly PrivateReplicaConfig[]) => Promise<void>): Promise<ReplicaCredentialFreeze> {
  profile = structuredClone(profile)
  origin = blindOrigin(origin)
  const personId = profile.identity.personId
  if (!revokedDeviceId || revokedDeviceId.length > 128 || revokedDeviceId === profile.device.deviceId) {
    throw new Error("Use another currently authorized device to revoke this device")
  }
  const key = await replicaCredentialFreezeKey(personId, origin)
  return withLocalStateWriteLock(key, async () => {
    guard()
    const profileRaw = await readLocal(profileKey)
    assertFreezeProfile(profileRaw, profile)
    const raw = await readLocal(key)
    if (raw !== null) {
      const pending = parseFreeze(raw, personId, origin)
      if (pending.servicePublicKey !== servicePublicKey || pending.revokedDeviceId !== revokedDeviceId ||
        pending.signerDeviceId !== profile.device.deviceId) throw new Error("Another credential transition is pending")
      guard()
      return pending
    }
    const transitionKey = key.replace("tincanban.replica-credential-freeze.v1.", "tincanban.replica-credential-transition.v1.")
    const transition = await readLocal(transitionKey)
    if (transition !== null) throw new Error("Finish fresh-epoch confirmation for the previous credential transition first")
    let configurations = (await getPrivateReplicaConfigurations(personId)).filter(config => config.origin === origin)
    if ((await getPrivateReplicaConflictSummaries(personId)).some(conflict => conflict.origin === origin)) {
      throw new Error("Resolve conflicting Rusty credentials before revoking a device")
    }
    if (!configurations.length || configurations.some(config => config.servicePublicKey !== servicePublicKey || config.removalPending)) {
      throw new Error("Current pinned Rusty connections are required before credential transition")
    }
    for (const config of configurations) {
      if (config.purpose !== "identity" && await readReplicaWriterUpgrade(personId, config)) throw new Error("Finish the pending writer policy transition first")
    }
    const bindings = (configs: readonly PrivateReplicaConfig[]) => configs.map(config => privateReplicaBinding(personId, config)).sort()
    const preparedBindings = bindings(configurations)
    await preflight?.(structuredClone(configurations))
    guard()
    // Normal replication can advance while remote checks run. Capture progress only after those checks.
    const sourceRaw = await readLocal(privateReplicaStateStorageKey(personId))
    const wire = await exportPrivateReplicaState(personId)
    const plan = await planPrivateReplicaImport(personId, wire)
    configurations = (await getPrivateReplicaConfigurations(personId)).filter(config => config.origin === origin)
    if (canonicalizeJson(preparedBindings) !== canonicalizeJson(bindings(configurations))) {
      throw new Error("Private credentials changed before freeze; retry required")
    }
    const random = () => encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32)))
    const resources = configurations.map(previous => {
      const next: PrivateReplicaConfig = { ...previous, ...rotateReplicaContentKeys(previous, random()),
        readToken: random(), writeToken: random(), lastUploaded: "" }
      delete next.preferenceRevision
      return { previous, next }
    })
    const pending: ReplicaCredentialFreeze = { version: 1, id: crypto.randomUUID(), personId,
      signerDeviceId: profile.device.deviceId, revokedDeviceId, origin, servicePublicKey, resources }
    const nextRaw = JSON.stringify(pending)
    parseFreeze(nextRaw, personId, origin)
    guard()
    if (!await compareAndSwapLocal({ conditions: [...plan.conditions, { key, value: null }, { key: transitionKey, value: null }, { key: profileKey, value: profileRaw },
      { key: privateReplicaStateStorageKey(personId), value: sourceRaw }], writes: [...plan.writes, { key, value: nextRaw }] }, guard)) {
      throw new Error("Private credentials changed before freeze; retry required")
    }
    return pending
  })
}

/** Maintenance binds the original exact credential revision; an arbitrary stale config cannot use the freeze as authority. */
export async function assertReplicaCredentialFreezeCurrent(pending: ReplicaCredentialFreeze, config: PrivateReplicaConfig): Promise<void> {
  const current = await readReplicaCredentialFreeze(pending.personId, pending.origin)
  if (canonicalizeJson(current ?? null) !== canonicalizeJson(pending) || !pending.resources.some(resource =>
    privateReplicaBinding(pending.personId, resource.previous) === privateReplicaBinding(pending.personId, config))) {
    throw new Error("Credential transition or its exact original resource changed")
  }
}
