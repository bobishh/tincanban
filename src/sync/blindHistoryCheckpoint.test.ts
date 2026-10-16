import { expect, it, vi } from "vitest"
import { publishHistoryStorageCheckpoint, recordHistoryStorageFence } from "./blindHistoryCheckpoint"
import { blindHash } from "./blindClient"
import { encodeBlindBytes } from "./blindEnvelope"
import type { BlindCheckpointRequest, BlindCheckpointReceipt } from "./blindCheckpoint"
import type { BlindReplicaConfig } from "./blindReplication"
import { readReplicaWriterUpgrade } from "./privateReplicaRepository"
vi.mock("./privateReplicaRepository", async original => ({ ...await original<typeof import("./privateReplicaRepository")>(),
  readReplicaWriterUpgrade: vi.fn(async () => undefined) }))
vi.mock("./blindCheckpoint", () => ({ verifyCheckpointReceipt: vi.fn(async () => {}) }))
function fixture() {
  const config = { workspaceId: crypto.randomUUID(), scopeId: "scope", origin: "https://rusty.example", servicePublicKey: "A".repeat(43),
    policyRevision: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), keyEpoch: 1,
    readToken: "read", writeToken: "write", cursor: 7, lastUploaded: "" } satisfies BlindReplicaConfig
  const transitionId = crypto.randomUUID(), requests: BlindCheckpointRequest[] = []
  let maximum = 7, retained = 7, loseReply = false
  const bytes = new Uint8Array([1, 2, 3]), plaintext = new TextEncoder().encode(JSON.stringify({ document: encodeBlindBytes(bytes) }))
  const ports = { guard: vi.fn(), ensureCurrent: vi.fn(async () => {}),
    capture: vi.fn(async () => ({ bytes, plaintext, hash: await blindHash(plaintext) })),
    prepare: vi.fn<Parameters<typeof publishHistoryStorageCheckpoint>[4]["prepare"]>(async (_bytes, object, sequence, _baseline, existing) => existing ?? ({ object,
      authorization: { payload: { expectedSequence: sequence } } } as BlindCheckpointRequest)),
    submit: vi.fn(async (request: BlindCheckpointRequest) => {
      requests.push(structuredClone(request))
      if (maximum !== request.authorization.payload.expectedSequence && maximum !== request.authorization.payload.expectedSequence + 1) throw new Error("checkpoint_conflict")
      maximum = request.authorization.payload.expectedSequence + 1; retained = 1
      if (loseReply) { loseReply = false; throw new Error("reply lost after durable checkpoint") }
      return { payload: { sequence: maximum } } as BlindCheckpointReceipt
    }) }
  return { config, transitionId, requests, ports, setMaximum: (value: number) => { maximum = value },
    loseReply: () => { loseReply = true }, retained: () => retained }
}
it("Given unfinished automation maintenance after local writer activation, when publishing compact history, then retain old objects and never submit deletion", async () => {
  const f = fixture()
  await recordHistoryStorageFence("owner", f.config, f.transitionId, 7, f.ports.guard)
  vi.mocked(readReplicaWriterUpgrade).mockResolvedValueOnce({ localActivated: true } as never)
  await expect(publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports))
    .rejects.toThrow("Finish automation storage maintenance")
  expect(f.ports.submit).not.toHaveBeenCalled()
  expect(f.retained()).toBe(7)
})
it("Given remote checkpoint committed but reply lost, when a fresh publisher resumes, then reuse exact ciphertext, signature and original drained fence", async () => {
  const f = fixture(); await recordHistoryStorageFence("owner", f.config, f.transitionId, 7, f.ports.guard); f.loseReply()
  await expect(publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports)).rejects.toThrow("reply lost")
  await recordHistoryStorageFence("owner", f.config, f.transitionId, 100, f.ports.guard)
  await expect(publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports)).resolves.toMatchObject({ sequence: 8 })
  expect(f.requests[1]).toEqual(f.requests[0]); expect(f.ports.capture).toHaveBeenCalledOnce()
  expect(f.requests[1]!.authorization.payload.expectedSequence).toBe(7)
  await publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports)
  expect(f.ports.submit).toHaveBeenCalledTimes(2)
})
it("Given unseen concurrent appends after source capture, when checkpointing, then exact fence refuses pruning and never adopts a fresh maximum", async () => {
  const f = fixture(); await recordHistoryStorageFence("owner", f.config, f.transitionId, 7, f.ports.guard); f.setMaximum(10)
  await expect(publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports)).rejects.toThrow("checkpoint_conflict")
  expect(f.retained()).toBe(7)
  await recordHistoryStorageFence("owner", f.config, f.transitionId, 10, f.ports.guard)
  await expect(publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports)).rejects.toThrow("checkpoint_conflict")
  expect(f.requests.every(request => request.authorization.payload.expectedSequence === 7)).toBe(true)
})
it("Given a durably prepared checkpoint, when another baseline tries to reuse its transition, then preserve the original and refuse before network", async () => {
  const f = fixture(); await recordHistoryStorageFence("owner", f.config, f.transitionId, 7, f.ports.guard)
  await publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "baseline", f.ports)
  await expect(publishHistoryStorageCheckpoint("owner", f.config, f.transitionId, "fork", f.ports)).rejects.toThrow(/another compact basis/)
  expect(f.ports.submit).toHaveBeenCalledOnce()
})

it("Given a confirmed concurrent write conflict, when a fresh explicit capture admits that branch, then use new capture and fence while retaining the abandoned request", async () => {
  const { currentHistoryCaptureAttempt, restartConflictedHistoryCapture } = await import("./historyCaptureAttempt")
  const { HistoryStorageCheckpointConflictError } = await import("./blindHistoryCheckpoint")
  const f = fixture(), frozenId = crypto.randomUUID()
  const first = await currentHistoryCaptureAttempt(f.config.workspaceId, frozenId, f.ports.guard)
  await recordHistoryStorageFence("owner", f.config, first, 7, f.ports.guard)
  f.ports.submit.mockRejectedValueOnce(Object.assign(new Error("new signed original arrived"), { code: "checkpoint_conflict", status: 409 }))
  await expect(publishHistoryStorageCheckpoint("owner", f.config, first, "first-basis", f.ports)).rejects.toBeInstanceOf(HistoryStorageCheckpointConflictError)
  await restartConflictedHistoryCapture(f.config.workspaceId, frozenId, first, f.ports.guard)
  const next = await currentHistoryCaptureAttempt(f.config.workspaceId, frozenId, f.ports.guard)
  expect(next).not.toBe(first)
  // The caller has drained and admitted the concurrent original before this new capture/fence.
  f.setMaximum(10)
  await recordHistoryStorageFence("owner", f.config, next, 10, f.ports.guard)
  f.ports.capture.mockImplementationOnce(async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]), plaintext = new TextEncoder().encode(JSON.stringify({ document: encodeBlindBytes(bytes) }))
    return { bytes, plaintext, hash: await blindHash(plaintext) }
  })
  await expect(publishHistoryStorageCheckpoint("owner", f.config, next, "recaptured-basis", f.ports)).resolves.toMatchObject({ sequence: 11 })
  expect(f.ports.capture).toHaveBeenCalledTimes(2)
  expect(f.requests.at(-1)!.authorization.payload.expectedSequence).toBe(10)
  await expect(publishHistoryStorageCheckpoint("owner", f.config, first, "recaptured-basis", f.ports)).rejects.toThrow(/another compact basis/)
})

it("Given a service without snapshot ordering protection, when starting compaction, then require Rusty upgrade before maintenance proceeds", async () => {
  const client = await import("./blindClient"), { assertHistoryStorageCheckpointSupport } = await import("./blindHistoryCheckpoint")
  const f = fixture(), discovery = vi.spyOn(client, "discoverBlindKeeper")
  try {
    discovery.mockResolvedValue({ servicePublicKey: f.config.servicePublicKey, snapshotCheckpoints: 1 } as never)
    await expect(assertHistoryStorageCheckpointSupport(f.config, f.ports.guard)).rejects.toThrow("Update Rusty")
    discovery.mockResolvedValue({ servicePublicKey: f.config.servicePublicKey, snapshotCheckpoints: 1, snapshotWriteFence: 1 } as never)
    await expect(assertHistoryStorageCheckpointSupport(f.config, f.ports.guard)).resolves.toBeUndefined()
    discovery.mockResolvedValue({ servicePublicKey: "other pin", snapshotCheckpoints: 1, snapshotWriteFence: 1 } as never)
    await expect(assertHistoryStorageCheckpointSupport(f.config, f.ports.guard)).rejects.toThrow("identity changed")
  } finally { discovery.mockRestore() }
})
