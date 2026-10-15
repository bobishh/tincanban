import type { Ref } from "vue"
import type { PrivateReplicaConfig } from "./blindReplication"
import { replicaKey, type ReplicaHealth } from "./replicationHealth"

export async function syncReplicaConnections(configs: PrivateReplicaConfig[], isCurrent: () => boolean,
  run: (config: PrivateReplicaConfig) => Promise<string | undefined>, label: string): Promise<string[]> {
  const failures: string[] = []
  for (const config of configs) {
    if (!isCurrent()) break
    const message = await run(config)
    if (message) failures.push(`${label} (${new URL(config.origin).host}): ${message}`)
  }
  return failures
}

export async function recordReplicaHealth(config: PrivateReplicaConfig, statuses: Ref<Record<string, ReplicaHealth>>,
  operation: () => Promise<boolean | void>, isCurrent: () => boolean): Promise<string | undefined> {
  const key = replicaKey(config)
  const previous = statuses.value[key]
  statuses.value = { ...statuses.value, [key]: { phase: "syncing", lastSyncedAt: previous?.lastSyncedAt } }
  try {
    const caughtUp = await operation()
    if (!isCurrent() || config.removalPending) return
    statuses.value = { ...statuses.value, [key]: caughtUp === false
      ? { phase: "catching-up", lastSyncedAt: previous?.lastSyncedAt }
      : { phase: "synced", lastSyncedAt: Date.now() } }
  } catch (cause) {
    if (!isCurrent()) return
    const message = cause instanceof Error ? cause.message : "Rusty unavailable"
    statuses.value = { ...statuses.value, [key]: { phase: "error", lastSyncedAt: previous?.lastSyncedAt, error: message } }
    return message
  }
}
