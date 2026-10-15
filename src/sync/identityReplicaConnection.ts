import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, readLocal, updateLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { blindHash } from "./blindClient"
import { blindOrigin } from "./blindOrigin"
import { encodeBlindBytes } from "./blindEnvelope"
import type { IdentityReplicaConfig } from "./blindReplication"
import { parsePrivateReplicaConfig } from "./blindReplicaConfig"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, planPrivateReplicaImport } from "./privateReplicaRepository"
import { changeReplicaPreference, portableReplicaState } from "./privateReplicaPreferences"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { ensureRustyPersonPolicy, readRustyManagementStatus, retryRustyManagementUpdate, updateRustyManagementPolicy } from "./rustyManagementClient"
import { approveRustyScope } from "./rustyEnrollment"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"

type Service = { origin: string; servicePublicKey: string; scopeManagement?: 1; personManagement?: 1 }
type Setup = { version: 1; personId: string; config: IdentityReplicaConfig; stage: "policy" | "activate" }
const encoder = new TextEncoder()
function assertStoredProfile(raw: string | null, expected: LocalProfile) {
  let stored: LocalProfile | undefined
  try { stored = raw ? JSON.parse(raw) as LocalProfile : undefined } catch { throw new Error("Saved identity cannot be read; restore it before profile setup") }
  if (!stored || stored.identity?.personId !== expected.identity.personId || stored.identity.publicKey !== expected.identity.publicKey ||
    stored.device?.deviceId !== expected.device.deviceId || stored.device.publicKey !== expected.device.publicKey ||
    canonicalizeJson(stored.certificate ?? null) !== canonicalizeJson(expected.certificate)) throw new Error("Private scope signing identity is stale")
}
export async function identityReplicaSetupKey(personId: string, origin: string) {
  return `tincanban.identity-replica-setup.v1.${personId}.${await blindHash(encoder.encode(blindOrigin(origin)))}`
}

function parseSetup(raw: string, service: Service, personId: string): Setup {
  const value = JSON.parse(raw) as Setup
  if (value?.version !== 1 || value.personId !== personId || !["policy", "activate"].includes(value.stage) ||
    Object.keys(value).sort().join(",") !== "config,personId,stage,version") throw new Error("Invalid saved private scope setup")
  const config = parsePrivateReplicaConfig(JSON.stringify(value.config), personId)
  if (config.purpose !== "identity" || config.origin !== service.origin || config.servicePublicKey !== service.servicePublicKey) {
    throw new Error("Private scope setup service pin changed")
  }
  if (config.removalPending || config.preferenceRevision || config.cursor !== 0 || config.lastUploaded !== "") throw new Error("Invalid private scope setup progress")
  return { version: 1, personId, config, stage: value.stage }
}

async function selectedConnection(service: Service, personId: string) {
  const configs = (await getIdentityReplicaConfigurations(personId)).filter(config => config.origin === service.origin)
  if (configs.length > 1) throw new Error("Multiple private profile scopes require owner review")
  if (configs[0]?.servicePublicKey !== undefined && configs[0].servicePublicKey !== service.servicePublicKey) throw new Error("Private profile service pin changed")
  if (configs[0]?.removalPending) throw new Error("Private profile connection removal is pending")
  if (configs[0]) return configs[0]
  const state = await exportPrivateReplicaState(personId)
  if (state.entries.some(entry => entry.origin === service.origin && entry.operations.some(operation => operation.purpose === "identity"))) {
    throw new Error("Private profile connection was removed or conflicted; explicit recovery is required")
  }
}

async function confirmPolicy(service: Service, profile: LocalProfile, config: IdentityReplicaConfig, guard: () => void) {
  if (service.personManagement === 1) await ensureRustyPersonPolicy(service, profile, true, { ensureCurrent: guard })
  const binding = { origin: config.origin, servicePublicKey: config.servicePublicKey, resourceKind: "scope" as const, resourceId: config.scopeId }
  const status = await readRustyManagementStatus(binding, profile, { ensureCurrent: guard })
  guard()
  const saved = await new RustyManagementRepository(profile.identity.personId).read(binding)
  if (saved?.pending) await retryRustyManagementUpdate(binding, profile, { ensureCurrent: guard })
  else if (status.migrationPending) throw new Error("Private scope policy migration is pending; owner review required")
  else if (!status.capability) {
    if (service.scopeManagement !== 1) throw new Error("Rusty upgrade required for private profile delivery")
    await updateRustyManagementPolicy(binding, profile, { operations: ["management.update", "scope.policy", "snapshot.checkpoint"],
      revokedDeviceIds: [] }, { ensureCurrent: guard })
  }
  guard()
}

async function activateSetup(key: string, raw: string, setup: Setup, profileRaw: string | null, guard: () => void) {
  const wire = await exportPrivateReplicaState(setup.personId)
  const changed = changeReplicaPreference({ ...wire, actorId: crypto.randomUUID(), progress: {}, migrated: true }, setup.config)
  const plan = await planPrivateReplicaImport(setup.personId, portableReplicaState(changed))
  guard()
  if (!await compareAndSwapLocal({ conditions: [...plan.conditions, { key, value: raw },
    { key: "tincanban.local_profile.v1", value: profileRaw }], writes: [...plan.writes, { key, value: null }] }, guard)) {
    throw new Error("Private scope activation changed; retry required")
  }
}

/** Durable credentials precede enrollment. A lost response cannot generate a different key or scope on retry. */
export async function ensureIdentityReplicaConnection(service: Service, profile: LocalProfile,
  ensureCurrent: () => void): Promise<IdentityReplicaConfig> {
  service = { ...service, origin: blindOrigin(service.origin) }
  profile = structuredClone(profile)
  ensureCurrent()
  const profileRaw = await readLocal("tincanban.local_profile.v1")
  assertStoredProfile(profileRaw, profile)
  const personId = profile.identity.personId, key = await identityReplicaSetupKey(personId, service.origin)
  return withLocalStateWriteLock(key, async () => {
    ensureCurrent()
    const existing = await selectedConnection(service, personId)
    ensureCurrent()
    if (existing) return existing
    if (service.scopeManagement !== 1) throw new Error("Rusty upgrade required for private profile delivery")
    const raw = await updateLocal(key, previous => {
      ensureCurrent()
      if (previous) { parseSetup(previous, service, personId); return previous }
      const random = () => encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32)))
      const config: IdentityReplicaConfig = { purpose: "identity", personId, origin: service.origin, servicePublicKey: service.servicePublicKey,
        scopeId: `identity-${random()}`, contentKey: random(), readToken: random(), writeToken: random(),
        keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" }
      const next = JSON.stringify({ version: 1, personId, config, stage: "policy" } satisfies Setup)
      parseSetup(next, service, personId)
      return next
    })
    const setup = parseSetup(raw, service, personId)
    let activationRaw = raw
    await confirmPolicy(service, profile, setup.config, ensureCurrent)
    if (setup.stage === "policy") {
      setup.config.policyRevision = await approveRustyScope(setup.config, profile)
      ensureCurrent()
      setup.stage = "activate"
      activationRaw = JSON.stringify(setup)
      if (!await compareAndSwapLocal({ conditions: [{ key, value: raw }], writes: [{ key, value: activationRaw }] }, ensureCurrent)) {
        throw new Error("Private scope setup changed before activation")
      }
    }
    ensureCurrent()
    const selected = await selectedConnection(service, personId)
    if (selected && selected.scopeId !== setup.config.scopeId) throw new Error("Another private scope was activated; owner review required")
    await activateSetup(key, activationRaw, setup, profileRaw, ensureCurrent)
    identityDevicePreferencesChanged(personId)
    const result = (await getIdentityReplicaConfigurations(personId)).find(config => config.scopeId === setup.config.scopeId)
    ensureCurrent()
    const credentials = (config: IdentityReplicaConfig) => {
      const { preferenceRevision, cursor, lastUploaded, ...value } = config
      void preferenceRevision; void cursor; void lastUploaded
      return canonicalizeJson(value)
    }
    if (!result || credentials(result) !== credentials(setup.config)) {
      throw new Error("Private scope activation was superseded")
    }
    return result
  })
}
