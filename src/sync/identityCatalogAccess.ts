import { canonicalizeJson, isCurrentIdentityProfile, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { parsePrivateReplicaConfig } from "./blindReplicaConfig"
import type { IdentityReplicaConfig } from "./blindReplication"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, planPrivateReplicaImport } from "./privateReplicaRepository"
import { effectiveIdentityReplicaConfigs, parsePrivateReplicaWire, type PrivateReplicaWire } from "./privateReplicaPreferences"
import { RustyManagementRepository, type ManagementBinding, type PortableManagementRecord } from "./rustyManagementRepository"
import { verifyRustyManagementCapability } from "./rustyManagementCapability"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"

/** catalogId identifies an authenticated delivery projection, not the encrypted replica scope. */
export type IdentityCatalogBinding = { origin: string; servicePublicKey: string; catalogId: string }
type CatalogAccess = {
  kind: "tincanban-identity-catalog-access"
  version: 1
  personId: string
  catalog: IdentityReplicaConfig
  connectionState: PrivateReplicaWire
  capabilities: PortableManagementRecord[]
}
const maximumBytes = 32 * 1024
const same = (left: unknown, right: unknown) => canonicalizeJson(left) === canonicalizeJson(right)

function portable(config: IdentityReplicaConfig): IdentityReplicaConfig {
  const { preferenceRevision, cursor, lastUploaded, ...credentials } = config
  void preferenceRevision; void cursor; void lastUploaded
  if (credentials.removalPending) throw new Error("Catalog connection removal is pending")
  return { ...credentials, cursor: 0, lastUploaded: "" }
}

function managementBinding(config: IdentityReplicaConfig, kind: "scope" | "person"): ManagementBinding {
  return { origin: config.origin, servicePublicKey: config.servicePublicKey, resourceKind: kind,
    resourceId: kind === "scope" ? config.scopeId : config.personId }
}

/** Domain projection only: the protocol SDK encrypts, signs and transports these bytes. */
export async function captureIdentityCatalogAccess(profile: LocalProfile, selected: IdentityReplicaConfig): Promise<Uint8Array> {
  if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed before sharing catalog access")
  const configs = await getIdentityReplicaConfigurations(profile.identity.personId)
  const config = configs.find(value => value.origin === selected.origin && value.scopeId === selected.scopeId)
  if (!config || !same(portable(config), portable(selected))) throw new Error("Catalog credentials changed before sharing")
  const repository = new RustyManagementRepository(profile.identity.personId)
  const sourceState = await exportPrivateReplicaState(profile.identity.personId)
  const connectionState = { ...sourceState, entries: sourceState.entries.filter(entry =>
    entry.origin === config.origin && entry.scopeId === config.scopeId) }
  const capabilities: PortableManagementRecord[] = []
  for (const kind of ["person", "scope"] as const) {
    const binding = managementBinding(config, kind)
    const record = await repository.read(binding)
    if (!record?.capability || record.pending) throw new Error("Catalog authority is not confirmed")
    capabilities.push({ binding, capability: record.capability })
  }
  const value: CatalogAccess = { kind: "tincanban-identity-catalog-access", version: 1,
    personId: profile.identity.personId, catalog: portable(config), connectionState, capabilities }
  const bytes = new TextEncoder().encode(canonicalizeJson(value))
  await readIdentityCatalogAccess(bytes, profile, { origin: config.origin, servicePublicKey: config.servicePublicKey, catalogId: config.scopeId })
  if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed while sharing catalog access")
  return bytes
}

function parseCatalogAccess(bytes: Uint8Array, profile: LocalProfile,
  expected: IdentityCatalogBinding): CatalogAccess {
  if (!bytes.length || bytes.length > maximumBytes) throw new Error("Catalog access exceeds its size limit")
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as CatalogAccess
  if (!value || Object.keys(value).sort().join() !== "capabilities,catalog,connectionState,kind,personId,version" ||
    value.kind !== "tincanban-identity-catalog-access" || value.version !== 1 || value.personId !== profile.identity.personId ||
    !Array.isArray(value.capabilities) || value.capabilities.length !== 2) throw new Error("Invalid catalog access")
  const catalog = parsePrivateReplicaConfig(JSON.stringify(value.catalog), profile.identity.personId)
  if (catalog.purpose !== "identity" || catalog.origin !== expected.origin || catalog.servicePublicKey !== expected.servicePublicKey ||
    !same(value.catalog, portable(catalog))) throw new Error("Catalog access binding does not match")
  return { ...value, catalog, connectionState: catalogPreferenceState(value.connectionState, catalog, profile.identity.personId) }
}

function catalogPreferenceState(input: unknown, catalog: IdentityReplicaConfig, personId: string): PrivateReplicaWire {
  const connectionState = parsePrivateReplicaWire(input)
  const entries = connectionState.entries
  const effective = effectiveIdentityReplicaConfigs({ ...connectionState, actorId: "catalog-preflight", progress: {} }, personId)
  if (connectionState.personId !== personId || entries.length !== 1 ||
      entries[0]!.origin !== catalog.origin || entries[0]!.scopeId !== catalog.scopeId ||
      entries[0]!.operations.some(operation => operation.purpose !== "identity" || operation.config === null) ||
      effective.length !== 1 || !same(portable(effective[0]!), catalog) || !same(connectionState, input)) {
    throw new Error("Catalog preference evidence does not match its access credentials")
  }
  return connectionState
}

/** Call only with the service/catalog binding authenticated by the shared approval SDK. */
export async function readIdentityCatalogAccess(bytes: Uint8Array, profile: LocalProfile,
  expected: IdentityCatalogBinding): Promise<CatalogAccess> {
  const value = parseCatalogAccess(bytes, profile, expected)
  const capabilities: PortableManagementRecord[] = []
  for (const kind of ["person", "scope"] as const) {
    const binding = managementBinding(value.catalog, kind)
    const entry = value.capabilities.find(record => same(record.binding, binding))
    if (!entry || Object.keys(entry).sort().join() !== "binding,capability") throw new Error("Catalog authority is missing")
    await verifyRustyManagementCapability(entry.capability, binding, { personId: profile.identity.personId,
      deviceId: profile.device.deviceId, resourceKind: kind, resourceId: binding.resourceId,
      operation: "management.update", minimumRevision: 1 })
    capabilities.push({ binding, capability: entry.capability })
  }
  return { ...value, capabilities }
}

async function currentProfileRecord(profile: LocalProfile): Promise<string> {
  if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed before installing catalog access")
  const raw = await readLocal("tincanban.local_profile.v1")
  if (!raw) throw new Error("Durable Identity is unavailable")
  const stored = JSON.parse(raw) as LocalProfile
  if (stored.identity.personId !== profile.identity.personId || stored.device.deviceId !== profile.device.deviceId ||
    stored.device.publicKey !== profile.device.publicKey || !same(stored.certificate, profile.certificate)) {
    throw new Error("Durable Identity changed before installing catalog access")
  }
  return raw
}

/** Credentials and their authority become available in one transaction; retries preserve existing local data. */
export async function installIdentityCatalogAccess(bytes: Uint8Array, profile: LocalProfile,
  expected: IdentityCatalogBinding, ensureCurrent: () => void): Promise<void> {
  const access = await readIdentityCatalogAccess(bytes, profile, expected)
  const repository = new RustyManagementRepository(profile.identity.personId)
  for (let attempt = 0; attempt < 8; attempt++) {
    ensureCurrent()
    const profileRaw = await currentProfileRecord(profile)
    const current = await getIdentityReplicaConfigurations(profile.identity.personId)
    const selected = current.find(config => config.origin === access.catalog.origin && config.scopeId === access.catalog.scopeId)
    if (selected && !same(portable(selected), access.catalog)) throw new Error("Existing catalog credentials differ; automatic replacement refused")
    if (!selected && (await exportPrivateReplicaState(profile.identity.personId)).entries.some(entry =>
      entry.origin === access.catalog.origin && entry.scopeId === access.catalog.scopeId)) {
      throw new Error("Catalog was removed or has a credential conflict; automatic reconnection refused")
    }
    const retained = await Promise.all(access.capabilities.map(entry => repository.read(entry.binding)))
    if (selected && retained.every((entry, index) => !entry?.pending && same(entry?.capability, access.capabilities[index]!.capability))) return
    const plans = await Promise.all([
      planPrivateReplicaImport(profile.identity.personId, access.connectionState),
      repository.planImport(access.capabilities),
    ])
    ensureCurrent()
    const committed = await compareAndSwapLocal({ conditions: [
      { key: "tincanban.local_profile.v1", value: profileRaw }, ...plans.flatMap(plan => plan.conditions),
    ], writes: plans.flatMap(plan => plan.writes) }, ensureCurrent)
    if (!committed) continue
    identityDevicePreferencesChanged(profile.identity.personId)
    return
  }
  throw new Error("Catalog access changed repeatedly; retry required")
}
