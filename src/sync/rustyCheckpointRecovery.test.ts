import { expect, test, vi } from "vitest"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { pushWithCheckpointRefresh, uploadWithCheckpointEvidence } from "./rustyCheckpointRecovery"

test("Given a rejected upload and admitted checkpoint, when a guard fails after retiring the rejected request, then discard old-key memory observations before retrying", async () => {
  const object = { ciphertext: "original" }
  const pending = { object, requestId: "original-request", observedSequence: 0, contentIdentity: "same-snapshot", hash: "snapshot-hash", bytes: 1 }
  let state: ReplicaState<typeof object> = { ...emptyReplicaState("binding"), pending }
  let retired = false, failGuard = true, oldKeyObserved = false
  const restart = vi.fn(() => { oldKeyObserved = false })
  const push = vi.fn(async () => {
    if (state.pending) return uploadWithCheckpointEvidence({ object, requestId: pending.requestId, observedSequence: 0 }, async () => {
      throw Object.assign(new Error("Known rejected upload"), { code: "checkpoint_generation_required", status: 409 })
    })
    if (oldKeyObserved) return true
    state = { ...state, lastUploaded: "fresh-key-receipt" }
    return true
  })
  const ports = {
    guard: async () => {
      if (retired && failGuard) { failGuard = false; throw new Error("Temporary storage read failed") }
    },
    read: async () => structuredClone(state),
    commit: async (expected: number, next: ReplicaState<typeof object>) => {
      expect(expected).toBe(state.generation)
      state = structuredClone(next); retired = true
    },
    pull: async () => {
      oldKeyObserved = true
      state = { ...state, cursor: 7, generation: state.generation + 1 }
      return true
    },
    push, restart,
  }
  await expect(pushWithCheckpointRefresh(ports)).rejects.toThrow("Temporary storage read failed")
  expect(state.pending).toBeUndefined()
  expect(restart).toHaveBeenCalledOnce()
  await expect(pushWithCheckpointRefresh(ports)).resolves.toBe(true)
  expect(state.lastUploaded).toBe("fresh-key-receipt")
})
