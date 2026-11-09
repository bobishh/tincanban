import { isRustyRequestFailure, ReplicaProgressConflictError, ParticipantStorageAccessPendingError } from "./replicationErrors"
import { computed, shallowReactive, type Ref } from "vue"
import type { BlindReplicaConfig, PrivateReplicaConfig } from "./blindReplication"
import { replicaConfirmationLifetime, replicaKey, type BoardFreshness, type BoardReplicaRead, type ReplicaHealth } from "./replicationHealth"
import { traceDiagnosticOperation } from "./telemetry"
import { meshTrace } from "./meshTrace"
import { privateReplicaBinding } from "./privateReplicaBinding"

export async function syncReplicaConnections<Config extends PrivateReplicaConfig>(configs: Config[], isCurrent: () => boolean,
  run: (config: Config) => Promise<string | undefined>, label: string): Promise<string[]> {
  const failures: string[] = []
  for (const config of configs) {
    if (!isCurrent()) break
    const message = await run(config)
    if (message) failures.push(`${label} (${new URL(config.origin).host}): ${message}`)
  }
  return failures
}

export async function recordReplicaHealth(config: PrivateReplicaConfig, statuses: Ref<Record<string, ReplicaHealth>>,
  operation: () => Promise<boolean | void>, isCurrent: () => boolean,
  deviceIssues?: Ref<Record<string, string>>): Promise<string | undefined> {
  const key = replicaKey(config)
  const previous = statuses.value[key]
  if (deviceIssues) { const next = { ...deviceIssues.value }; delete next[key]; deviceIssues.value = next }
  statuses.value = { ...statuses.value, [key]: { phase: "syncing", lastSyncedAt: previous?.lastSyncedAt } }
  try {
    const caughtUp = await traceDiagnosticOperation("rusty.sync", {
      "workspace.id": "workspaceId" in config ? config.workspaceId : "",
      "sync.scope.kind": config.purpose ?? "workspace", "server.address": new URL(config.origin).host,
    }, () => retryReplicaSync(operation))
    if (!isCurrent() || config.removalPending) return
    statuses.value = { ...statuses.value, [key]: caughtUp === false
      ? { phase: "catching-up", lastSyncedAt: previous?.lastSyncedAt }
      : { phase: "synced", lastSyncedAt: Date.now() } }
  } catch (cause) {
    if (!isCurrent()) return
    return recordReplicaFailure(config, statuses, cause, previous?.lastSyncedAt, deviceIssues)
  }
}
function recordReplicaFailure(config: PrivateReplicaConfig, statuses: Ref<Record<string, ReplicaHealth>>,
  cause: unknown, lastSyncedAt: number | undefined, deviceIssues?: Ref<Record<string, string>>): string | undefined {
  const key = replicaKey(config)
  if (cause instanceof ParticipantStorageAccessPendingError) {
    statuses.value = { ...statuses.value, [key]: { phase: "access-pending" } }
    return
  }
  if (isRustyRequestFailure(cause)) {
    const failure = connectionFailure(cause)
    statuses.value = { ...statuses.value, [key]: { phase: "error", lastSyncedAt, ...failure } }
    return failure.error
  }
  meshTrace("replication.device.scope.failed", { workspaceId: "workspaceId" in config ? config.workspaceId : "",
    reason: cause instanceof Error ? cause.message : String(cause) }, "warn", cause)
  statuses.value = { ...statuses.value, [key]: { phase: "paused", lastSyncedAt } }
  if (deviceIssues) deviceIssues.value = { ...deviceIssues.value,
    [key]: deviceSyncIssue(config) }
}

async function retryReplicaSync(operation: () => Promise<boolean | void>): Promise<boolean | void> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (cause) { if (!(cause instanceof ReplicaProgressConflictError) || attempt >= 2) throw cause }
  }
}

function connectionFailure(cause: Error): Pick<ReplicaHealth, "error" | "errorKind"> {
  const status = "status" in cause && typeof cause.status === "number" ? cause.status : undefined
  if (status === 401 || status === 403) return { errorKind: "access", error: "Rusty access needs attention. Check device access." }
  if (status !== undefined && status < 500) return { errorKind: "response", error: "Rusty response could not be accepted. Retry sync." }
  return { errorKind: "unavailable", error: "Rusty connection unavailable. Retry sync." }
}

function deviceSyncIssue(config: PrivateReplicaConfig): string {
  return `${config.purpose === "identity" ? "Profile" : "Board"} sync paused on this device. Your saved changes are retained. Retry sync.`
}

type Observation = { binding: string; result: BoardReplicaRead }

/** A board check covers only the Rusty copies configured for that board in this session. */
export function createBoardFreshness(configs: Readonly<Ref<BlindReplicaConfig[]>>, now: Readonly<Ref<number>>,
  owner: () => string, workspaceId: () => string) {
  const reads = shallowReactive(new Map<string, Observation>())
  let generation = 0
  const status = computed<BoardFreshness>(() => {
    const sources = configs.value.filter(config => config.workspaceId === workspaceId() && !config.removalPending)
    if (!sources.length) return { phase: "unknown" }
    const results = sources.map(config => {
      const observed = reads.get(replicaKey(config))
      return observed?.binding === privateReplicaBinding(owner(), config) ? observed.result : undefined
    })
    if (results.some(result => result?.phase === "unavailable")) return { phase: "unavailable" }
    if (results.some(result => result?.phase === "catching-up")) return { phase: "catching-up" }
    let checkedAt = Infinity
    for (const result of results) {
      if (result?.phase !== "checked") return { phase: "checking" }
      checkedAt = Math.min(checkedAt, result.checkedAt)
    }
    if (now.value - checkedAt > replicaConfirmationLifetime) return { phase: "overdue" }
    return { phase: "checked", checkedAt }
  })
  return {
    status,
    reset() {
      generation++
      reads.clear()
    },
    async check<T>(config: BlindReplicaConfig, isCurrent: () => boolean,
      sync: (observe: (result: BoardReplicaRead) => void) => Promise<T>): Promise<T> {
      const startedIn = generation
      const binding = privateReplicaBinding(owner(), config)
      let observed = false
      const observe = (result: BoardReplicaRead) => {
        observed = true
        if (startedIn !== generation || !isCurrent()) return
        reads.set(replicaKey(config), { binding, result })
      }
      try { return await sync(observe) }
      catch (cause) {
        if (!observed) observe({ phase: "unavailable" })
        throw cause
      }
    },
  }
}
