import { expect, it, vi } from "vitest"
import * as local from "../localDb"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { exportPrivateReplicaState, getReplicaConfigurations, getPrivateReplicaProgress,
  persistPrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import type { BlindReplicaConfig } from "./blindReplication"
import { emptyReplicaState } from "@meta-uber/mesh-replication/replica-engine"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 0, lastUploaded: "" }
const nonce = encodeBlindBytes(new Uint8Array(12))
const ciphertext = encodeBlindBytes(new Uint8Array(32))
const uploadedHash = "B".repeat(43)
type LegacyStateFixture = { version: number; entries: Array<{ operations: Array<{ purpose?: string; config: Record<string, unknown> }> }>; progress: Record<string, unknown> }

async function selectedConfig(owner: string): Promise<BlindReplicaConfig> {
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]
  if (!selected) throw new Error("Replica preference was not selected")
  return selected
}

function pending(revision = "content-v1") {
  return { requestId: crypto.randomUUID(), hash: "C".repeat(43), bytes: 16,
    object: { version: 1 as const, scopeId: config.scopeId, keyEpoch: 1, nonce, ciphertext }, revision }
}

it("Given an encrypted object pending for upload, when local replica progress is persisted and reread, then restart returns exact pending bytes without exporting device-local state", async () => {
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const before = await getPrivateReplicaProgress(owner, selected)
  expect(before).toMatchObject({ version: 1, binding: expect.any(String), generation: 0, cursor: 0, lastUploaded: "" })
  const next = { ...before, generation: 1, pending: pending() }

  await persistPrivateReplicaState(owner, selected, 0, next, () => {})

  expect(await getPrivateReplicaProgress(owner, selected)).toEqual(next)
  const exported = JSON.stringify(await exportPrivateReplicaState(owner))
  expect(exported).not.toContain('"pending"')
  expect(exported).not.toContain('"uploadedRevision"')
})

it("Given v2 progress with a binding that matches no verified workspace credentials, when read, then reject without rewriting the stored outbox", async () => {
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const key = `tincanban.private-replica-state.v2.${owner}`
  const raw = JSON.parse((await local.readLocal(key))!) as LegacyStateFixture
  raw.version = 2
  delete raw.entries[0].operations[0].purpose
  delete raw.entries[0].operations[0].config.purpose
  raw.progress[`${selected.origin}/${selected.scopeId}`] = {
    revision: selected.preferenceRevision, cursor: 0, lastUploaded: "",
    replication: { ...emptyReplicaState<BlindObject>("unrelated-binding"), generation: 1, pending: pending() },
  }
  await local.writeLocal(key, JSON.stringify(raw))
  const exactBefore = await local.readLocal(key)

  await expect(getPrivateReplicaProgress(owner, selected)).rejects.toThrow(/binding|replica/i)
  expect(await local.readLocal(key)).toBe(exactBefore)
})

it("Given a failed atomic local progress write, when storage aborts, then prior generation remains intact", async () => {
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const before = await getPrivateReplicaProgress(owner, selected)
  const failure = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("Private progress transaction aborted"))
  try {
    await expect(persistPrivateReplicaState(owner, selected, before.generation,
      { ...before, generation: before.generation + 1, pending: pending() }, () => {})).rejects.toThrow("transaction aborted")
  } finally { failure.mockRestore() }

  expect(await getPrivateReplicaProgress(owner, selected)).toEqual(before)
})

it("Given two writers with the same expected generation, when both compare-and-set, then only one generation commits", async () => {
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const before = await getPrivateReplicaProgress(owner, selected)
  const left = { ...before, generation: 1, cursor: 3, pending: pending("left") }
  const right = { ...before, generation: 1, cursor: 7, pending: pending("right") }

  const results = await Promise.allSettled([
    persistPrivateReplicaState(owner, selected, 0, left, () => {}),
    persistPrivateReplicaState(owner, selected, 0, right, () => {}),
  ])

  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
  const committed = await getPrivateReplicaProgress(owner, selected)
  expect(committed.generation).toBe(1)
  expect([3, 7]).toContain(committed.cursor)
})

it("Given a credential is removed and re-added, when an old in-flight commit uses its previous selection, then stale progress is rejected", async () => {
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const before = await getPrivateReplicaProgress(owner, selected)
  await setReplicaPreference(owner, selected, true)
  await setReplicaPreference(owner, selected)

  await expect(persistPrivateReplicaState(owner, selected, before.generation,
    { ...before, generation: before.generation + 1, cursor: 99, pending: pending() }, () => {})).rejects.toThrow()

  const current = (await getReplicaConfigurations(owner))[0]!
  const progress = await getPrivateReplicaProgress(owner, current)
  expect(progress).toMatchObject({ generation: 0, cursor: 0 })
  expect(progress.pending).toBeUndefined()
})

it("Given a durable pending upload, when its verified acknowledgement and cursor are committed, then progress advances and outbox entry clears together", async () => {
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const before = await getPrivateReplicaProgress(owner, selected)
  const queued = { ...before, generation: 1, pending: pending() }
  await persistPrivateReplicaState(owner, selected, 0, queued, () => {})

  const acknowledged = { ...queued, generation: 2, cursor: 12, lastUploaded: uploadedHash,
    uploadedRevision: queued.pending!.revision }
  await persistPrivateReplicaState(owner, selected, 1, acknowledged, () => {})

  expect(await getPrivateReplicaProgress(owner, selected)).toEqual(acknowledged)
  expect(await exportPrivateReplicaState(owner)).not.toHaveProperty("progress")
})

it("Given legacy progress advances before the first engine commit, when an older cursor tries to persist, then retain newer progress and allow retry from it", async () => {
  const { persistPrivateReplicaProgress } = await import("./privateReplicaRepository")
  const { ReplicaProgressConflictError } = await import("./replicationErrors")
  const owner = crypto.randomUUID()
  const selected = await selectedConfig(owner)
  const before = await getPrivateReplicaProgress(owner, selected)
  await persistPrivateReplicaProgress(owner, { ...selected, cursor: 8 })
  await expect(persistPrivateReplicaState(owner, selected, before.generation,
    { ...before, generation: before.generation + 1, cursor: 3 })).rejects.toBeInstanceOf(ReplicaProgressConflictError)
  const current = await getPrivateReplicaProgress(owner, selected)
  expect(current.cursor).toBe(8)
  await persistPrivateReplicaState(owner, selected, current.generation, { ...current, generation: current.generation + 1 })
  expect((await getPrivateReplicaProgress(owner, selected)).cursor).toBe(8)
})
