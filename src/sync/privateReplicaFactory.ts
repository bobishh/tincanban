import type { Ref } from "vue"
import type { useTincanban } from "../state"
import { canonicalizeJson } from "../domain/identity"
import type { BlindReplica, BlindReplicaConfig, IdentityReplicaConfig, PrivateReplicaConfig, PrivateReplicaConflictSummary } from "./blindReplication"
import { replicaKey, type ReplicaHealth } from "./replicationHealth"
import { getPrivateReplicaConfigurations, getPrivateReplicaConflictSummaries, persistPrivateReplicaProgress, readReplicaWriterUpgrade } from "./privateReplicaRepository"
import { provisionIdentityReplicas } from "./provisionIdentityReplicas"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import type { ReplicaWriterUpgrade } from "./privateReplicaPreferences"
import { ParticipantStorageAccessPendingError } from "./replicationErrors"

type Replica = { binding: string; sync: () => Promise<boolean | void>; pull?: () => Promise<boolean>; flushCurrentSnapshot?: () => Promise<void>;
  checkpointHistoryBaseline?: BlindReplica["checkpointHistoryBaseline"] }
type Session = { owner: string; epoch?: number; guard: () => void; reload: () => Promise<void>;
  configs: Ref<BlindReplicaConfig[]>; cache: Map<string, Replica>; attachmentCoverage?: Ref<Record<string, AttachmentCoverageStatus[]>>;
  queueWriterMaintenance?: (config: BlindReplicaConfig) => void }
type State = { configs: Ref<BlindReplicaConfig[]>; identityConfigs: Ref<IdentityReplicaConfig[]>; statuses: Ref<Record<string, ReplicaHealth>>;
  profileSetupErrors: Ref<Record<string, string>>; profilePermissionUpdates?: Ref<string[]>; deviceSyncIssues?: Ref<Record<string, string>>;
  preferenceConflicts?: Ref<PrivateReplicaConflictSummary[]>; attachmentCoverage?: Ref<Record<string, AttachmentCoverageStatus[]>> }

export async function provisionPrivateReplicas(app: ReturnType<typeof useTincanban>, state: State,
  guard: () => void, reload: () => Promise<void>): Promise<string[]> {
  const configurations = state.configs.value.filter(config => !config.removalPending && !config.boardAccess)
  const migrations: string[] = []
  guard()
  const errors = configurations.length ? await provisionIdentityReplicas(app, configurations,
    new Set(state.identityConfigs.value.map(config => config.origin)), guard, origin => migrations.push(origin)) : {}
  guard()
  state.profileSetupErrors.value = errors
  if (state.profilePermissionUpdates) state.profilePermissionUpdates.value = migrations
  await reload()
  return Object.entries(errors).map(([origin, reason]) => `Profile (${new URL(origin).host}): ${reason}`)
}

export async function reloadPrivateReplicas(owner: string, state: State, cache: Map<string, Replica>, isCurrent: () => boolean): Promise<void> {
  const saved = await getPrivateReplicaConfigurations(owner)
  const conflicts = await getPrivateReplicaConflictSummaries(owner)
  if (!isCurrent()) return
  state.configs.value = saved.filter((config): config is BlindReplicaConfig => config.purpose !== "identity")
  state.identityConfigs.value = saved.filter((config): config is IdentityReplicaConfig => config.purpose === "identity")
  if (state.preferenceConflicts) state.preferenceConflicts.value = conflicts
  const keys = new Set(saved.map(replicaKey))
  for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key)
  if (state.deviceSyncIssues) state.deviceSyncIssues.value = Object.fromEntries(Object.entries(state.deviceSyncIssues.value).filter(([key]) => keys.has(key)))
  state.statuses.value = Object.fromEntries(Object.entries(state.statuses.value).filter(([key]) => keys.has(key)))
  if (state.attachmentCoverage) {
    state.attachmentCoverage.value = Object.fromEntries(Object.entries(state.attachmentCoverage.value).filter(([key]) => keys.has(key)))
  }
}

/** Removal maintenance loads with the connection adapters, independently of local board startup. */
export function forgetPrivateReplica(config: PrivateReplicaConfig, state: State, cache: Map<string, Replica>) {
  const key = replicaKey(config)
  cache.delete(key)
  if (state.deviceSyncIssues) { const next = { ...state.deviceSyncIssues.value }; delete next[key]; state.deviceSyncIssues.value = next }
  const statuses = { ...state.statuses.value }
  delete statuses[key]
  state.statuses.value = statuses
  if (state.attachmentCoverage) {
    const coverage = { ...state.attachmentCoverage.value }
    delete coverage[key]
    state.attachmentCoverage.value = coverage
  }
}

function requiresWriterRecovery(config: PrivateReplicaConfig, upgrade: ReplicaWriterUpgrade | undefined): config is BlindReplicaConfig {
  if (config.purpose === "identity" || !upgrade) return false
  return !upgrade.localActivated || (upgrade.confirmed?.payload.revision ?? 0) > config.policyRevision
}

/** Share construction so concurrent callers use one replica operation queue. */
const constructing = new WeakMap<Session["cache"], Map<string, Promise<Replica>>>()

export function resolvePrivateReplica(app: ReturnType<typeof useTincanban>, config: PrivateReplicaConfig, session: Session): Promise<Replica> {
  session.guard()
  if (config.purpose !== "identity" && config.boardAccess?.authorization.payload.version === 1) {
    return Promise.reject(new ParticipantStorageAccessPendingError("Waiting for board storage access"))
  }
  const { cursor, lastUploaded, ...credentials } = config
  void cursor; void lastUploaded
  const key = canonicalizeJson([session.owner, session.epoch ?? null, credentials])
  let pending = constructing.get(session.cache)
  if (!pending) { pending = new Map(); constructing.set(session.cache, pending) }
  const existing = pending.get(key)
  if (existing) return existing.then(replica => { session.guard(); return replica })
  const run = constructPrivateReplica(app, config, session).finally(() => { pending.delete(key) })
  pending.set(key, run)
  return run
}

async function constructPrivateReplica(app: ReturnType<typeof useTincanban>, config: PrivateReplicaConfig, session: Session): Promise<Replica> {
  const { owner, guard, configs, cache } = session
  config = JSON.parse(canonicalizeJson(config)) as PrivateReplicaConfig
  guard()
  const pendingWriterUpgrade = config.purpose !== "identity" ? await readReplicaWriterUpgrade(owner, config) : undefined
  if (requiresWriterRecovery(config, pendingWriterUpgrade)) {
    const { ensureWorkspaceReplicaWriter } = await import("./workspaceReplicaWriter")
    guard()
    config = await ensureWorkspaceReplicaWriter(app, config, guard, { storageOnly: true })
    await session.reload()
    guard()
  }
  const key = replicaKey(config)
  const { cursor, lastUploaded, ...credentials } = config
  void cursor; void lastUploaded
  const binding = canonicalizeJson(credentials)
  const cached = cache.get(key)
  if (cached?.binding === binding) return cached
  if (session.attachmentCoverage) session.attachmentCoverage.value = { ...session.attachmentCoverage.value, [key]: [] }
  const implementation = config.purpose === "identity"
    ? await import("./identityReplicaStore").then(module => {
      guard()
      const profile = app.getCurrentProfile()
      if (!profile) throw new Error("Identity unavailable during private replication")
      return module.createIdentityReplica(config, profile, guard)
    })
    : await import("./blindReplicaStore").then(module => {
      guard()
      return module.createBlindReplica(config, app, guard, async (value, configurations) => {
        guard()
        const next = configurations ?? await persistPrivateReplicaProgress(owner, value, guard)
        guard(); configs.value = next
      }, states => {
        guard()
        if (session.attachmentCoverage) session.attachmentCoverage.value = { ...session.attachmentCoverage.value, [key]: states }
      })
    })
  guard()
  const result: Replica = { binding, sync: async () => {
    const synced = await implementation.sync()
    if (config.purpose !== "identity" && (config.minimumWriterVersion !== 2 || pendingWriterUpgrade)) session.queueWriterMaintenance?.(config)
    return synced
  } }
  if (typeof implementation.pull === "function") {
    result.pull = async () => { guard(); const caughtUp = await implementation.pull(); guard(); return caughtUp }
  }
  if ("flushCurrentSnapshot" in implementation && typeof implementation.flushCurrentSnapshot === "function") {
    result.flushCurrentSnapshot = () => implementation.flushCurrentSnapshot()
  }
  if ("checkpointHistoryBaseline" in implementation && typeof implementation.checkpointHistoryBaseline === "function") {
    result.checkpointHistoryBaseline = (...args) => { guard(); return implementation.checkpointHistoryBaseline(...args) }
  }
  cache.set(key, result)
  return result
}
