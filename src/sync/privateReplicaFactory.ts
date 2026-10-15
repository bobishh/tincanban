import type { Ref } from "vue"
import type { useTincanban } from "../state"
import { canonicalizeJson } from "../domain/identity"
import type { BlindReplicaConfig, IdentityReplicaConfig, PrivateReplicaConfig } from "./blindReplication"
import { replicaKey, type ReplicaHealth } from "./replicationHealth"
import { getPrivateReplicaConfigurations, persistPrivateReplicaProgress, readReplicaWriterUpgrade } from "./privateReplicaRepository"
import { provisionIdentityReplicas } from "./provisionIdentityReplicas"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"

type Replica = { binding: string; sync: () => Promise<boolean | void> }
type Session = { owner: string; guard: () => void; reload: () => Promise<void>;
  configs: Ref<BlindReplicaConfig[]>; cache: Map<string, Replica>; attachmentCoverage?: Ref<Record<string, AttachmentCoverageStatus[]>> }
type State = { configs: Ref<BlindReplicaConfig[]>; identityConfigs: Ref<IdentityReplicaConfig[]>; statuses: Ref<Record<string, ReplicaHealth>>;
  profileSetupErrors: Ref<Record<string, string>>; attachmentCoverage?: Ref<Record<string, AttachmentCoverageStatus[]>> }

export async function provisionPrivateReplicas(app: ReturnType<typeof useTincanban>, state: State,
  guard: () => void, reload: () => Promise<void>): Promise<string[]> {
  const configurations = state.configs.value.filter(config => !config.removalPending)
  guard()
  const errors = configurations.length ? await provisionIdentityReplicas(app, configurations,
    new Set(state.identityConfigs.value.map(config => config.origin)), guard) : {}
  guard()
  state.profileSetupErrors.value = errors
  await reload()
  return Object.entries(errors).map(([origin, reason]) => `Profile (${new URL(origin).host}): ${reason}`)
}

export async function reloadPrivateReplicas(owner: string, state: State, cache: Map<string, Replica>, isCurrent: () => boolean): Promise<void> {
  const saved = await getPrivateReplicaConfigurations(owner)
  if (!isCurrent()) return
  state.configs.value = saved.filter((config): config is BlindReplicaConfig => config.purpose !== "identity")
  state.identityConfigs.value = saved.filter((config): config is IdentityReplicaConfig => config.purpose === "identity")
  const keys = new Set(saved.map(replicaKey))
  for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key)
  state.statuses.value = Object.fromEntries(Object.entries(state.statuses.value).filter(([key]) => keys.has(key)))
  if (state.attachmentCoverage) {
    state.attachmentCoverage.value = Object.fromEntries(Object.entries(state.attachmentCoverage.value).filter(([key]) => keys.has(key)))
  }
}

/** Removal maintenance loads with the connection adapters, independently of local board startup. */
export function forgetPrivateReplica(config: PrivateReplicaConfig, state: State, cache: Map<string, Replica>) {
  const key = replicaKey(config)
  cache.delete(key)
  const statuses = { ...state.statuses.value }
  delete statuses[key]
  state.statuses.value = statuses
  if (state.attachmentCoverage) {
    const coverage = { ...state.attachmentCoverage.value }
    delete coverage[key]
    state.attachmentCoverage.value = coverage
  }
}

/** Network-only construction and compatibility do not participate in rendering the saved local board. */
export async function resolvePrivateReplica(app: ReturnType<typeof useTincanban>, config: PrivateReplicaConfig, session: Session): Promise<Replica> {
  const { owner, guard, configs, cache } = session
  guard()
  if (config.purpose !== "identity" && (config.minimumWriterVersion !== 2 || await readReplicaWriterUpgrade(owner, config))) {
    const { ensureWorkspaceReplicaWriter } = await import("./workspaceReplicaWriter")
    guard()
    config = await ensureWorkspaceReplicaWriter(app, config, guard)
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
  const result = { binding, sync: () => implementation.sync() }
  cache.set(key, result)
  return result
}
