import type { BlindReplicaConfig } from "./blindReplication"
export type ReplicaHealth = { phase: "syncing" | "catching-up" | "synced" | "error"; lastSyncedAt?: number; error?: string }
export type ConnectionPresence = "connected" | "reconnecting" | "offline" | "empty"
export const replicaConfirmationLifetime = 45_000
export const replicaKey = (config: Pick<BlindReplicaConfig, "origin" | "scopeId">) => `${config.origin}/${config.scopeId}`
export const syncTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString()

export function replicaStatus(config: BlindReplicaConfig, health: ReplicaHealth | undefined, now: number): string {
  if (config.removalPending) return "Removal pending"
  if (!health) return "Not checked"
  if (health.phase === "syncing") return "Syncing"
  if (health.phase === "catching-up") return "Catching up"
  if (health.phase === "error") return "Unavailable"
  return health.lastSyncedAt && now - health.lastSyncedAt <= replicaConfirmationLifetime ? "Synced" : "Check overdue"
}

export function replicationPresence(device: ConnectionPresence, configs: BlindReplicaConfig[], health: Record<string, ReplicaHealth>, workspaceId: string, now: number): ConnectionPresence {
  if (device === "connected") return device
  const states = configs.filter(config => config.workspaceId === workspaceId && !config.removalPending)
    .map(config => replicaStatus(config, health[replicaKey(config)], now))
  if (!states.length) return device
  if (states.includes("Synced")) return "connected"
  if (device === "reconnecting" || states.some(state => state === "Syncing" || state === "Catching up" || state === "Not checked")) return "reconnecting"
  return "offline"
}

export function replicationSummary(configs: BlindReplicaConfig[], health: Record<string, ReplicaHealth>, workspaceId: string, now: number): string {
  return configs.filter(config => config.workspaceId === workspaceId).map(config => {
    const state = health[replicaKey(config)]
    const status = replicaStatus(config, state, now)
    const label = status === "Synced" ? `synced at ${syncTime(state!.lastSyncedAt!)}` : status.toLowerCase()
    const name = configs.filter(value => value.workspaceId === workspaceId).length > 1 ? `Rusty (${new URL(config.origin).host})` : "Rusty"
    return `${name} ${label}`
  }).join("; ")
}
