import { canonicalizeJson, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { blindHash } from "./blindClient"
import { blindOrigin } from "./blindOrigin"
import { decodeBlindBytes, encodeBlindBytes } from "./blindEnvelope"
import { parseReplicaConfig } from "./blindReplicaConfig"
import type { BlindReplicaConfig } from "./blindReplication"
import { approveRustyScope } from "./rustyEnrollment"
import { parseRustyScopePolicyReceipt, type RustyScopePolicyReceipt } from "./rustyScopePolicy"
import { exportPrivateReplicaState, getPrivateReplicaConflictSummaries, getReplicaConfigurations, planPrivateReplicaImport } from "./privateReplicaRepository"
import { changeReplicaPreference, portableReplicaState } from "./privateReplicaPreferences"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { assertReplicaCredentialsUnfrozen, replicaCredentialOriginCondition, replicaCredentialFreezeKey } from "./replicaCredentialFreeze"

type Service = { origin: string; servicePublicKey: string }
type Setup = { version: 1; personId: string; stage: "enroll" | "activate"; config: BlindReplicaConfig; receipt?: RustyScopePolicyReceipt }
const encoder = new TextEncoder()
const profileKey = "tincanban.local_profile.v1"

export async function workspaceReplicaSetupKey(personId: string, origin: string, workspaceId: string): Promise<string> {
  return `tincanban.workspace-replica-setup.v1.${await blindHash(encoder.encode(canonicalizeJson([personId, blindOrigin(origin), workspaceId])))}`
}

function parseSetup(raw: string, service: Service, workspaceId: string, personId: string): Setup {
  if (encoder.encode(raw).length > 32 * 1024) throw new Error("Saved board connection exceeds storage bound")
  const setup = JSON.parse(raw) as Setup
  assertSetupHeader(setup, personId)
  const config = parseReplicaConfig(JSON.stringify(setup.config))
  assertInitialSetupConfig(config, service, workspaceId)
  if ((setup.stage === "activate") !== Boolean(setup.receipt)) throw new Error("Saved board connection receipt is missing or premature")
  return { version: 1, personId, stage: setup.stage, config,
    ...(setup.receipt ? { receipt: parseRustyScopePolicyReceipt(setup.receipt) } : {}) }
}

function assertSetupHeader(setup: Setup, personId: string): void {
  const keys = new Set(["version", "personId", "stage", "config", "receipt"])
  if (!setup || setup.version !== 1 || setup.personId !== personId || !["enroll", "activate"].includes(setup.stage) ||
      Object.keys(setup).some(key => !keys.has(key))) throw new Error("Invalid saved board connection")
}

function assertInitialSetupConfig(config: BlindReplicaConfig, service: Service, workspaceId: string): void {
  const matchesPin = config.origin === service.origin && config.servicePublicKey === service.servicePublicKey && config.workspaceId === workspaceId
  const isInitial = config.keyEpoch === 1 && !config.historicalContentKeys && !config.removalPending && !config.preferenceRevision && config.cursor === 0 && config.lastUploaded === ""
  if (!matchesPin || !isInitial) throw new Error("Saved board connection workspace or service pin changed")
}

async function selectedConnection(personId: string, service: Service, workspaceId: string) {
  if ((await getPrivateReplicaConflictSummaries(personId)).some(conflict => conflict.origin === service.origin && conflict.workspaceIds.includes(workspaceId))) {
    throw new Error("Conflicting board connections require review before setup")
  }
  const matches = (await getReplicaConfigurations(personId)).filter(config => config.origin === service.origin && config.workspaceId === workspaceId)
  if (matches.length > 1) throw new Error("Multiple Rusty board connections require review")
  const selected = matches[0]
  if (selected && (selected.servicePublicKey !== service.servicePublicKey || selected.removalPending)) {
    throw new Error("Board connection service pin changed or removal is pending")
  }
  return selected
}

async function verifySetupReceipt(setup: Setup): Promise<void> {
  const receipt = setup.receipt!
  const payload = receipt.payload
  const serviceId = await blindHash(decodeBlindBytes(setup.config.servicePublicKey))
  const writerFloorMatches = setup.config.minimumWriterVersion === 2
    ? payload.minimumWriterVersion === 2
    : payload.minimumWriterVersion === undefined || payload.minimumWriterVersion === 2
  if (receipt.signerKeyId !== serviceId || payload.serviceId !== serviceId || payload.personId !== setup.personId ||
    payload.scopeId !== setup.config.scopeId || payload.revoked || payload.revision !== setup.config.policyRevision ||
    !writerFloorMatches || !await verifyEnvelope(receipt, setup.config.servicePublicKey, "RUSTY/2")) throw new Error("Saved board connection receipt binding or signature invalid")
}

function sameCredentials(left: BlindReplicaConfig, right: BlindReplicaConfig): boolean {
  const select = (config: BlindReplicaConfig) => [config.origin, config.workspaceId, config.scopeId, config.servicePublicKey,
    config.keyEpoch, config.contentKey, config.readToken, config.writeToken, config.historicalContentKeys ?? null]
  return canonicalizeJson(select(left)) === canonicalizeJson(select(right)) && left.policyRevision >= right.policyRevision
}

type ConnectionContext = { service: Service; workspaceId: string; profile: LocalProfile; personId: string; key: string;
  freeze: Awaited<ReturnType<typeof replicaCredentialOriginCondition>>; guard: () => void;
  options: { allowNewScopeAfterRemoval?: boolean; beforeSetup?: () => Promise<void> } }

function assertStoredProfile(profileRaw: string | null, profile: LocalProfile): asserts profileRaw is string {
  const stored = profileRaw ? JSON.parse(profileRaw) as LocalProfile : undefined
  if (!stored || stored.identity?.personId !== profile.identity.personId || stored.identity.publicKey !== profile.identity.publicKey ||
      stored.device?.deviceId !== profile.device.deviceId || stored.device.publicKey !== profile.device.publicKey ||
      canonicalizeJson(stored.certificate) !== canonicalizeJson(profile.certificate)) throw new Error("Board connection signing identity is stale")
}

function hasRemovedOrigin(wire: Awaited<ReturnType<typeof exportPrivateReplicaState>>, origin: string, scopeId?: string): boolean {
  return wire.entries.some(entry => entry.origin === origin && (!scopeId || entry.scopeId === scopeId) &&
    entry.operations.some(operation => operation.purpose === "workspace" && operation.config === null))
}

async function persistInitialSetup(context: ConnectionContext, profileRaw: string, raw: string | null): Promise<string> {
  if (raw !== null) return raw
  const previous = await exportPrivateReplicaState(context.personId)
  if (!context.options.allowNewScopeAfterRemoval && hasRemovedOrigin(previous, context.service.origin)) {
    throw new Error("A board connection was removed; explicitly add a new scope before retrying")
  }
  const random = () => encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32)))
  const config: BlindReplicaConfig = { purpose: "workspace", workspaceId: context.workspaceId, origin: context.service.origin,
    servicePublicKey: context.service.servicePublicKey, scopeId: random(), contentKey: random(), readToken: random(), writeToken: random(),
    keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "", minimumWriterVersion: 2 }
  const next = JSON.stringify({ version: 1, personId: context.personId, stage: "enroll", config } satisfies Setup)
  if (!await compareAndSwapLocal({ conditions: [{ key: context.key, value: null }, { key: profileKey, value: profileRaw }, context.freeze],
    writes: [{ key: context.key, value: next }] }, context.guard)) throw new Error("Board connection setup changed; retry required")
  return next
}

async function finishEnrollment(context: ConnectionContext, setup: Setup, expected: string, profileRaw: string): Promise<{ setup: Setup; raw: string }> {
  if (setup.stage !== "enroll") return { setup, raw: expected }
  const enrolling = setup
  await approveRustyScope(setup.config, context.profile, false, { ensureCurrent: context.guard,
    ...(setup.config.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 as const } : {}), confirmed: async receipt => {
    context.guard()
    await assertReplicaCredentialsUnfrozen(context.personId, context.service)
    const confirmed: Setup = { ...enrolling, stage: "activate", config: { ...enrolling.config, policyRevision: receipt.payload.revision }, receipt }
    await verifySetupReceipt(confirmed)
    const next = JSON.stringify(confirmed)
    parseSetup(next, context.service, context.workspaceId, context.personId)
    const currentFreeze = await replicaCredentialOriginCondition(context.personId, context.service.origin)
    if (!await compareAndSwapLocal({ conditions: [{ key: context.key, value: expected }, { key: profileKey, value: profileRaw }, currentFreeze],
      writes: [{ key: context.key, value: next }] }, context.guard)) throw new Error("Board receipt persistence changed; original setup retained for retry")
  } })
  context.guard()
  await assertReplicaCredentialsUnfrozen(context.personId, context.service)
  const raw = await readLocal(context.key)
  if (raw === null) throw new Error("Board connection setup disappeared before activation")
  const confirmed = parseSetup(raw, context.service, context.workspaceId, context.personId)
  if (confirmed.stage !== "activate") throw new Error("Rusty approval did not confirm board setup")
  return { setup: confirmed, raw }
}

async function activateConnection(context: ConnectionContext, setup: Setup, raw: string, profileRaw: string): Promise<BlindReplicaConfig> {
  await verifySetupReceipt(setup)
  context.guard()
  await assertReplicaCredentialsUnfrozen(context.personId, context.service)
  const current = await selectedConnection(context.personId, context.service, context.workspaceId)
  if (current && !sameCredentials(current, setup.config)) throw new Error("Another board connection was activated; original setup retained for review")
  const wire = await exportPrivateReplicaState(context.personId)
  if (hasRemovedOrigin(wire, context.service.origin, setup.config.scopeId)) throw new Error("Pending board connection was removed before activation")
  const changed = current ? wire : portableReplicaState(changeReplicaPreference({ ...wire, actorId: crypto.randomUUID(), progress: {}, migrated: true }, setup.config))
  const plan = await planPrivateReplicaImport(context.personId, changed)
  context.guard()
  const currentFreeze = await replicaCredentialOriginCondition(context.personId, context.service.origin)
  if (!await compareAndSwapLocal({ conditions: [...plan.conditions, currentFreeze, { key: context.key, value: raw }, { key: profileKey, value: profileRaw }],
    writes: [...plan.writes, { key: context.key, value: null }] }, context.guard)) throw new Error("Board connection activation changed; retry required")
  identityDevicePreferencesChanged(context.personId)
  const result = (await getReplicaConfigurations(context.personId)).find(config => config.scopeId === setup.config.scopeId)
  context.guard()
  if (!result || !sameCredentials(result, setup.config)) throw new Error("Board connection activation was superseded")
  return result
}

/** Persist original keys before enrollment, then atomically activate the receipt-confirmed private connection. */
export async function ensureWorkspaceReplicaConnection(service: Service, workspaceId: string, profile: LocalProfile,
  guard: () => void, options: { allowNewScopeAfterRemoval?: boolean; beforeSetup?: () => Promise<void> } = {}): Promise<BlindReplicaConfig> {
  service = { origin: blindOrigin(service.origin), servicePublicKey: service.servicePublicKey }
  profile = structuredClone(profile)
  const personId = profile.identity.personId
  const key = await workspaceReplicaSetupKey(personId, service.origin, workspaceId)
  const transitionKey = await replicaCredentialFreezeKey(personId, service.origin)
  return withLocalStateWriteLock(transitionKey, async () => {
    guard()
    const freeze = await replicaCredentialOriginCondition(personId, service.origin)
    guard()
    await assertReplicaCredentialsUnfrozen(personId, service)
    const context: ConnectionContext = { service, workspaceId, profile, personId, key, freeze, guard, options }
    return withLocalStateWriteLock(key, () => ensureWorkspaceReplicaConnectionLocked(context))
  })
}

async function ensureWorkspaceReplicaConnectionLocked(context: ConnectionContext): Promise<BlindReplicaConfig> {
  context.guard()
  const profileRaw = await readLocal(profileKey)
  assertStoredProfile(profileRaw, context.profile)
  let raw = await readLocal(context.key)
  const existing = await selectedConnection(context.personId, context.service, context.workspaceId)
  context.guard()
  await context.options.beforeSetup?.()
  context.guard()
  await assertReplicaCredentialsUnfrozen(context.personId, context.service)
  if (existing && raw === null) return existing
  raw = await persistInitialSetup(context, profileRaw, raw)
  let setup = parseSetup(raw, context.service, context.workspaceId, context.personId)
  if (existing && !sameCredentials(existing, setup.config)) throw new Error("Another board connection was activated; original setup retained for review")
  const prior = await exportPrivateReplicaState(context.personId)
  if (hasRemovedOrigin(prior, context.service.origin, setup.config.scopeId)) throw new Error("Pending board connection was removed; automatic resurrection refused")
  const confirmed = await finishEnrollment(context, setup, raw, profileRaw)
  setup = confirmed.setup
  return activateConnection(context, setup, confirmed.raw, profileRaw)
}
