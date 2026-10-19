import { canonicalizeJson } from "../domain/identityCrypto"
import type { ReplicaPending, ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { record } from "./telemetry"

type Attempt<Object> = { object: Object; requestId: string; observedSequence: number }
class RejectedCheckpointUpload<Object> extends Error {
  constructor(readonly attempt: Attempt<Object>, cause: unknown) {
    super("Rusty history changed. Synchronization will refresh it automatically.", { cause })
  }
}

/** Only this protocol rejection proves that the attempted object was not stored. */
export async function uploadWithCheckpointEvidence<Object, Receipt>(attempt: Attempt<Object>,
  upload: () => Promise<Receipt>): Promise<Receipt> {
  attempt = structuredClone(attempt)
  try { return await upload() }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "checkpoint_generation_required" &&
      "status" in error && error.status === 409) throw new RejectedCheckpointUpload(attempt, error)
    throw error
  }
}

type CheckpointRefreshPorts<Object> = {
  guard: () => Promise<void>
  read: () => Promise<ReplicaState<Object>>
  commit: (expected: number, next: ReplicaState<Object>) => Promise<void>
  pull: () => Promise<boolean>
  push: () => Promise<boolean>
  /** Forget in-memory observations only; persisted receipts and cursor remain intact. */
  restart: () => void
  diagnostic?: (phase: "started" | "completed" | "deferred") => void
}

function observe<Object>(ports: CheckpointRefreshPorts<Object>, phase: "started" | "completed" | "deferred") {
  try { record(`rusty.checkpoint-refresh.${phase}`, { phase: "refresh_checkpoint_generation" }) }
  catch { /* Diagnostics must not affect persisted outbox evidence. */ }
  try { ports.diagnostic?.(phase) } catch { /* Optional host diagnostics. */ }
}

function assertRejectedPending<Object>(pending: ReplicaPending<Object> | undefined, attempt: Attempt<Object>) {
  if (!pending || pending.requestId !== attempt.requestId || (pending.observedSequence ?? 0) !== attempt.observedSequence ||
    canonicalizeJson(pending.object) !== canonicalizeJson(attempt.object)) throw new Error("Rusty pending upload changed during checkpoint refresh")
}

/** Keep the rejected outbox until the newer checkpoint is fully admitted; refresh at most once per pass. */
export async function pushWithCheckpointRefresh<Object>(ports: CheckpointRefreshPorts<Object>,
  operation = ports.push): Promise<boolean> {
  try { return await operation() }
  catch (error) {
    if (!(error instanceof RejectedCheckpointUpload)) throw error
    await ports.guard()
    const rejected = await ports.read()
    assertRejectedPending(rejected.pending, error.attempt)
    observe(ports, "started")
    const caughtUp = await ports.pull()
    await ports.guard()
    const current = await ports.read()
    if (canonicalizeJson(current.pending) !== canonicalizeJson(rejected.pending)) {
      throw new Error("Rusty pending upload changed while admitting its checkpoint", { cause: error })
    }
    if (!caughtUp || current.cursor <= error.attempt.observedSequence) {
      observe(ports, "deferred")
      return false
    }
    const admitted = { ...current }
    delete admitted.pending
    await ports.guard()
    await ports.commit(current.generation, { ...admitted, generation: current.generation + 1 })
    // A received old-key snapshot is not a receipt for the fresh-key upload.
    ports.restart()
    await ports.guard()
    observe(ports, "completed")
    try { return await ports.push() }
    catch (next) {
      if (!(next instanceof RejectedCheckpointUpload)) throw next
      observe(ports, "deferred")
      return false
    }
  }
}
