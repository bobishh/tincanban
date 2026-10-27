import type { BlindReplicaConfig } from "./blindReplication"
export type ReplicaHealth = { phase: "syncing" | "catching-up" | "synced" | "paused" | "error"; lastSyncedAt?: number; error?: string; errorKind?: "unavailable" | "access" | "response" }
export type ConnectionPresence = "connected" | "reconnecting" | "offline" | "empty"
const replicaConfirmationLifetime = 45_000
export const replicaKey = (config: Pick<BlindReplicaConfig, "origin" | "scopeId">) => `${config.origin}/${config.scopeId}`
export const syncTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString()

export function replicaStatus(config: Pick<BlindReplicaConfig, "removalPending">, health: ReplicaHealth | undefined, now: number): string {
  if (config.removalPending) return "Removal pending"
  if (!health) return "Not checked"
  if (health.phase === "syncing") return "Syncing"
  if (health.phase === "catching-up") return "Catching up"
  if (health.phase === "paused") return "Sync paused"
  if (health.phase === "error") return health.errorKind === "access" ? "Access required" : health.errorKind === "response" ? "Response rejected" : "Unavailable"
  return health.lastSyncedAt && now - health.lastSyncedAt <= replicaConfirmationLifetime ? "Synced" : "Check overdue"
}

export function replicationPresence(device: ConnectionPresence, configs: BlindReplicaConfig[], health: Record<string, ReplicaHealth>, workspaceId: string, now: number): ConnectionPresence {
  if (device === "connected") return device
  const active = configs.filter(config => config.workspaceId === workspaceId && !config.removalPending)
  const confirmedPoll = active.some(config => {
    const state = health[replicaKey(config)]
    return state?.phase === "syncing" && !!state.lastSyncedAt && now - state.lastSyncedAt <= replicaConfirmationLifetime
  })
  const states = active.map(config => replicaStatus(config, health[replicaKey(config)], now))
  if (!states.length) return device
  if (confirmedPoll || states.includes("Synced")) return "connected"
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
