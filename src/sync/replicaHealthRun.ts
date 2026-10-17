import { isRustyRequestFailure, ReplicaProgressConflictError } from "./replicationErrors"
import type { Ref } from "vue"
import type { PrivateReplicaConfig } from "./blindReplication"
import { replicaKey, type ReplicaHealth } from "./replicationHealth"
import { traceDiagnosticOperation } from "./telemetry"

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
    if (isRustyRequestFailure(cause)) {
      const failure = connectionFailure(cause)
      statuses.value = { ...statuses.value, [key]: { phase: "error", lastSyncedAt: previous?.lastSyncedAt, ...failure } }
      return failure.error
    }
    statuses.value = { ...statuses.value, [key]: { phase: "paused", lastSyncedAt: previous?.lastSyncedAt } }
    if (deviceIssues) deviceIssues.value = { ...deviceIssues.value,
      [key]: deviceSyncIssue(config) }
  }
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
