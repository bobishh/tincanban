import { replicaKey, replicaStatus, type ReplicaHealth } from "../sync/replicationHealth"

type Connection = { origin: string; scopeId: string; removalPending?: boolean }
type BoardConnection = Connection & { workspaceId: string; boardAccess?: unknown }
export type RustyConnectionState = {
  origin: string
  status: string
  lastSyncedAt?: number
  errors: string[]
}

const priority = ["Removal pending", "Access required", "Response rejected", "Unavailable", "Sync paused",
  "Setup required", "Not connected", "Not checked", "Syncing", "Catching up", "Check overdue", "Synced"]

/** One server indicator; every required delivery must confirm before it says Synced. */
export function rustyConnectionStates(boards: readonly BoardConnection[], identity: readonly Connection[],
  health: Record<string, ReplicaHealth>, workspaceId: string, owner: boolean, now: number): RustyConnectionState[] {
  const selected = boards.filter(config => config.workspaceId === workspaceId)
  const origins = [...new Set([...selected, ...(owner ? identity : [])].map(config => config.origin))]
  return origins.map(origin => {
    const board = selected.filter(config => config.origin === origin)
    const privateDelivery = owner && !board.some(config => config.boardAccess)
      ? identity.filter(config => config.origin === origin) : []
    const configs = [...board, ...privateDelivery]
    const states = configs.map(config => replicaStatus(config, health[replicaKey(config)], now))
    if (!board.length) states.push("Not connected")
    else if (owner && !board.some(config => config.boardAccess) && !privateDelivery.length) states.push("Setup required")
    const timestamps = configs.map(config => health[replicaKey(config)]?.lastSyncedAt)
      .filter((value): value is number => value !== undefined)
    return { origin, status: priority.find(status => states.includes(status)) ?? "Not checked",
      ...(timestamps.length ? { lastSyncedAt: Math.min(...timestamps) } : {}),
      errors: [...new Set(configs.flatMap(config => health[replicaKey(config)]?.error ? [health[replicaKey(config)]!.error!] : []))] }
  })
}
