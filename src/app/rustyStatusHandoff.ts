import type { BlindReplicaConfig, PrivateReplicaConflictSummary } from "../sync/blindReplication"
import { replicaKey, replicaStatus, type ReplicaHealth } from "../sync/replicationHealth"

export type RustyStatusRequest = { origin: string; requestId: string; expiresAt: number }

/** A request grants no access; the original opener still needs explicit confirmation. */
export function parseRustyStatusRequest(hash: string, now: number): RustyStatusRequest | undefined {
  const raw = new URLSearchParams(hash.slice(1)).get("rusty-status")
  if (raw === null) return
  if (raw.length > 2048) throw new Error("Invalid Rusty status request")
  const value = JSON.parse(raw) as Partial<RustyStatusRequest>
  const url = new URL(value.origin ?? "")
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.origin !== value.origin || url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      !/^[a-f0-9]{32}$/.test(value.requestId ?? "") || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt! <= now || value.expiresAt! > now + 120_000) throw new Error("Rusty status request is invalid or expired")
  return { origin: url.origin, requestId: value.requestId!, expiresAt: value.expiresAt! }
}

export function assertRustyStatusRequest(current: RustyStatusRequest | undefined, expected: RustyStatusRequest,
  opener: Window | null, expectedOpener: Window | null, now: number): void {
  if (!opener || opener !== expectedOpener || current?.origin !== expected.origin || current.requestId !== expected.requestId ||
      current.expiresAt !== expected.expiresAt) throw new Error("Rusty status request changed")
  if (now >= expected.expiresAt) throw new Error("Rusty status request expired. Retry from Rusty.")
}

/** Explicit output fields prevent private replica credentials entering a cross-origin message. */
export function createRustyStatusReply(request: RustyStatusRequest, configs: BlindReplicaConfig[],
  catalog: readonly { id: string; title: string; boardId: string }[], health: Record<string, ReplicaHealth>, now: number,
  conflicts: PrivateReplicaConflictSummary[] = []) {
  const selected = configs.filter(config => config.origin === request.origin)
  const paused = new Set(conflicts.filter(conflict => conflict.origin === request.origin).flatMap(conflict => conflict.workspaceIds))
  const boards = catalog.filter(board => paused.has(board.id) || selected.some(config => config.workspaceId === board.id))
  if (boards.length > 128) throw new Error("Too many board connections for one status view")
  return { type: "rusty-status@1" as const, requestId: request.requestId, origin: request.origin, checkedAt: now,
    boards: boards.map(board => {
      const matches = selected.filter(config => config.workspaceId === board.id)
      const base = { id: board.boardId, title: board.title.slice(0, 512) }
      if (paused.has(board.id) || matches.length !== 1) return { ...base, status: "Sync paused", access: "not-confirmed" }
      const config = matches[0]!
      const state = health[replicaKey(config)]
      return { ...base, status: replicaStatus(config, state, now),
        access: config.boardAccess?.mode === "read" || !config.writeToken ? "read-only" : "read-write",
        ...(state?.lastSyncedAt ? { lastSyncedAt: state.lastSyncedAt } : {}) }
    }) }
}
