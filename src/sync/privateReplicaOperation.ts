import { withLocalStateWriteLock } from "../localStateLock"
import type { PrivateReplicaConfig } from "./blindReplication"

/** Own a complete cursor/outbox operation across clients and tabs, independently of storage transactions. */
export function withPrivateReplicaOperation<T>(owner: string, config: Pick<PrivateReplicaConfig, "origin" | "scopeId">,
  operation: () => Promise<T>): Promise<T> {
  // Credential revisions share durable progress, so they must share the same lock.
  return withLocalStateWriteLock(`private-replica-operation:${JSON.stringify([owner, config.origin, config.scopeId])}`, operation)
}
