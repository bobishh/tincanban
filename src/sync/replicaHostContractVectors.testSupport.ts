import { expect } from "vitest"

const replicaHostContractVectors = [
  "response-loss-restart",
  "revoked-credential",
  "wrong-signed-receipt",
  "failed-ack-cas",
] as const

export type ReplicaHostContractVector = typeof replicaHostContractVectors[number]
export type ReplicaHostPending = { object: unknown; requestId: string }
type ReplicaHostAcknowledgement = { cursor: number; lastUploaded: string }
export type ReplicaHostVectorObservation = {
  pendingAtUpload: ReplicaHostPending | undefined
  upload: ReplicaHostPending
  pendingAfter: ReplicaHostPending | undefined
  acknowledgementBefore: ReplicaHostAcknowledgement
  acknowledgementAfter: ReplicaHostAcknowledgement
  uploadCount: number
  retryUpload?: ReplicaHostPending
  failure?: unknown
}

/** Run the same outbox/receipt acceptance vectors through each real host adapter. */
export async function runReplicaHostContractVectors(
  run: (vector: ReplicaHostContractVector) => Promise<ReplicaHostVectorObservation>,
): Promise<void> {
  for (const vector of replicaHostContractVectors) {
    const observation = await run(vector)
    expect(observation.pendingAtUpload, `${vector}: pending ciphertext must be durable before upload`)
      .toEqual(observation.upload)

    if (vector === "response-loss-restart") {
      expect(observation.failure).toBeDefined()
      expect(String(observation.failure)).toContain("Response lost")
      expect(observation.retryUpload).toEqual(observation.upload)
      expect(observation.pendingAfter).toBeUndefined()
      expect(observation.acknowledgementAfter.lastUploaded).not.toBe(observation.acknowledgementBefore.lastUploaded)
      expect(observation.uploadCount).toBe(2)
      continue
    }

    expect(observation.failure, `${vector}: rejected remote evidence must fail the adapter operation`).toBeDefined()
    if (vector === "revoked-credential") expect(String(observation.failure)).toContain("revoked")
    if (vector === "wrong-signed-receipt") expect(String(observation.failure)).toMatch(/receipt|request|does not cover/i)
    if (vector === "failed-ack-cas") expect(String(observation.failure)).toMatch(/conflict|generation/i)
    expect(observation.pendingAfter).toEqual(observation.upload)
    expect(observation.acknowledgementAfter).toEqual(observation.acknowledgementBefore)
    expect(observation.uploadCount).toBe(1)
  }
}
