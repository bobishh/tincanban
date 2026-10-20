import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { replicaKey, replicaStatus, replicaConfirmationLifetime, type ReplicaHealth } from "./replicationHealth"

export type ProfileDeliveryState = { key: string; origin: string; status: string; lastSyncedAt?: number; error?: string }

/** Summarizes profile delivery independently, restricted to Rusty origins configured for this board. */
export function profileDeliveryStates(boardConfigs: BlindReplicaConfig[], identityConfigs: IdentityReplicaConfig[],
  health: Record<string, ReplicaHealth>, workspaceId: string, now: number): ProfileDeliveryState[] {
  const origins = [...new Set(boardConfigs.filter(config => config.workspaceId === workspaceId && !config.boardAccess).map(config => config.origin))]
  return origins.map(origin => {
    const configs = identityConfigs.filter(config => config.origin === origin)
    if (!configs.length) return { key: origin, origin, status: "Profile delivery not configured" }

    const states = configs.map(config => ({ config, health: health[replicaKey(config)] }))
    if (states.some(({ config }) => config.removalPending)) return { key: origin, origin, status: "Removal pending" }
    const failed = states.filter(({ health: state }) => state?.phase === "error")
    if (failed.length) {
      const failures = failed.flatMap(({ health: state }) => state?.error ? [state.error] : [])
      return { key: origin, origin, status: replicaStatus(failed[0]!.config, failed[0]!.health, now), ...(failures.length ? { error: failures.join("; ") } : {}) }
    }
    if (states.some(({ health: state }) => state?.phase === "paused")) return { key: origin, origin, status: "Sync paused" }
    if (states.some(({ health: state }) => !state)) return { key: origin, origin, status: "Not checked" }
    if (states.some(({ health: state }) => state?.phase === "syncing")) return { key: origin, origin, status: "Syncing" }
    if (states.some(({ health: state }) => state?.phase === "catching-up")) return { key: origin, origin, status: "Catching up" }

    const timestamps = states.map(({ health: state }) => state?.lastSyncedAt).filter((value): value is number => value !== undefined)
    const lastSyncedAt = timestamps.length ? Math.min(...timestamps) : undefined
    if (lastSyncedAt === undefined || now - lastSyncedAt > replicaConfirmationLifetime) return { key: origin, origin, status: "Check overdue", lastSyncedAt }
    return { key: origin, origin, status: "Synced", lastSyncedAt }
  })
}
