import { RustyResponseError } from "@meta-uber/mesh-replication/rusty-replica"

const requestFailures = new WeakSet<Error>()

/** Preserve HTTP error identity and protocol fields while recording its actual source. */
export function rustyRequestFailure(cause: unknown, status?: number): Error {
  const error = cause instanceof Error ? cause : new Error("Rusty request failed", { cause })
  if (status !== undefined && !("status" in error)) Object.assign(error, { status })
  requestFailures.add(error)
  return error
}
export function isRustyRequestFailure(cause: unknown): cause is Error {
  return cause instanceof RustyResponseError || cause instanceof Error && requestFailures.has(cause)
}

/** A competing local writer committed first; restart from its durable state. */
export class ReplicaProgressConflictError extends Error {
  readonly code = "replica_progress_conflict"
  constructor(detail?: { expectedGeneration: number; actualGeneration: number; attemptedCursor: number; currentCursor: number }) {
    super("Replica progress generation changed during persistence" + (detail
      ? ` (generation ${detail.expectedGeneration}/${detail.actualGeneration}, cursor ${detail.attemptedCursor}/${detail.currentCursor})` : ""))
    this.name = "ReplicaProgressConflictError"
  }
}
