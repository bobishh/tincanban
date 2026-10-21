import { expect, it, vi } from "vitest"
import * as local from "../localDb"
import type { BlindReplicaConfig } from "./blindReplication"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { privateReplicaBinding, privateReplicaStateStorageKey, setReplicaPreference, getReplicaConfigurations,
  getPrivateReplicaProgress, persistPrivateReplicaState, planPrivateReplicaImport, exportPrivateReplicaState } from "./privateReplicaRepository"
import { changeReplicaPreference, emptyPrivateReplicaState, type PrivateReplicaState } from "./privateReplicaPreferences"

const token = encodeBlindBytes(new Uint8Array(32))
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token,
  policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "" }

async function staleProgress(pending = false, changedAccess = false) {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const raw = (await local.readLocal(privateReplicaStateStorageKey(owner)))!
  const state = JSON.parse(raw) as PrivateReplicaState
  const original = { ...selected, preferenceRevision: "retired:1",
    ...(changedAccess ? { readToken: encodeBlindBytes(new Uint8Array(32).fill(1)) } : {}) }
  const outbox = { requestId: crypto.randomUUID(), hash: token, bytes: 1, object: { version: 1 as const,
    scopeId: config.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } }
  state.progress[`${config.origin}/${config.scopeId}`] = { revision: original.preferenceRevision,
    cursor: 17, lastUploaded: token, replication: { version: 1, binding: privateReplicaBinding(owner, original),
      generation: 7, cursor: 17, lastUploaded: token, ...(pending ? { pending: outbox } : {}) } }
  await local.writeLocal(privateReplicaStateStorageKey(owner), JSON.stringify(state))
  return { owner, selected, outbox }
}

it("Given saved progress predates the selected causal revision with unchanged access, when one client reads and commits, then preserve its generation and cursor instead of retrying generation zero forever", async () => {
  const { owner, selected } = await staleProgress()
  const progress = await getPrivateReplicaProgress(owner, selected)
  expect(progress).toMatchObject({ generation: 7, cursor: 17, binding: privateReplicaBinding(owner, selected) })
  await expect(persistPrivateReplicaState(owner, selected, 7, { ...progress, generation: 8, cursor: 16 }))
    .rejects.toThrow("Replica progress generation changed")
  await persistPrivateReplicaState(owner, selected, progress.generation, { ...progress, generation: 8, cursor: 18 })
  const reopened = (await getReplicaConfigurations(owner))[0]!
  expect(await getPrivateReplicaProgress(owner, reopened)).toMatchObject({ generation: 8, cursor: 18 })
  await expect(persistPrivateReplicaState(owner, reopened, 7, { ...progress, generation: 8, cursor: 19 }))
    .rejects.toThrow("Replica progress generation changed")
})

it("Given a saved pending upload and a stale metadata revision, when the same access is selected, then retain exact ciphertext and request identity through the next commit", async () => {
  const { owner, selected, outbox } = await staleProgress(true)
  const progress = await getPrivateReplicaProgress(owner, selected)
  expect(progress.pending).toEqual(outbox)
  await persistPrivateReplicaState(owner, selected, progress.generation, { ...progress, generation: 8, cursor: 18 })
  expect((await getPrivateReplicaProgress(owner, selected)).pending).toEqual(outbox)
})

it("Given stale progress belongs to different access and has no outbox, when replay starts, then require fresh confirmation while retaining the physical CAS generation", async () => {
  const { owner, selected } = await staleProgress(false, true)
  const progress = await getPrivateReplicaProgress(owner, selected)
  expect(progress).toMatchObject({ generation: 7, cursor: 0, lastUploaded: "" })
  await persistPrivateReplicaState(owner, selected, 7, { ...progress, generation: 8, cursor: 1 })
})

it("Given stale progress has a pending upload under different access, when reading, then reject without dropping or replacing its outbox", async () => {
  const { owner, selected } = await staleProgress(true, true)
  const key = privateReplicaStateStorageKey(owner), before = await local.readLocal(key)
  await expect(getPrivateReplicaProgress(owner, selected)).rejects.toThrow(/pending.*migration/i)
  expect(await local.readLocal(key)).toBe(before)
})

it("Given the current repository is authoritative, when an obsolete writer changes retired records, then never read them or invalidate a current import transaction", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const before = await exportPrivateReplicaState(owner)
  const plan = await planPrivateReplicaImport(owner, before)
  const retired = [`tincanban.blind-replicas.v1.${owner}`, `tincanban.device-replica-preferences.v1.${owner}`,
    `tincanban.private-replica-legacy-snapshot.v1.${owner}`]
  for (const key of retired) await local.writeLocal(key, "malformed obsolete data")
  const read = vi.spyOn(local, "readLocal")
  try {
    expect(await getReplicaConfigurations(owner)).toHaveLength(1)
    expect(read.mock.calls.some(([key]) => retired.includes(key))).toBe(false)
    expect(await local.compareAndSwapLocal(plan)).toBe(true)
  } finally { read.mockRestore() }
  expect(await exportPrivateReplicaState(owner)).toEqual(before)
})

it("Given a validated current repository and records from an older tab, when opening and saving this identity, then preserve those records without importing them or changing current progress", async () => {
  const owner = crypto.randomUUID()
  const state = changeReplicaPreference(emptyPrivateReplicaState(owner, "current"), config)
  const key = privateReplicaStateStorageKey(owner), raw = JSON.stringify(state)
  await local.writeLocal(key, raw)
  const retired = [`tincanban.blind-replicas.v1.${owner}`, `tincanban.device-replica-preferences.v1.${owner}`,
    `tincanban.private-replica-legacy-snapshot.v1.${owner}`]
  for (const obsolete of retired) await local.writeLocal(obsolete, "invalid retired data")
  expect(await getReplicaConfigurations(owner)).toHaveLength(1)
  expect(await Promise.all(retired.map(obsolete => local.readLocal(obsolete)))).toEqual(retired.map(() => "invalid retired data"))
  expect(await local.readLocal(key)).toBe(raw)
  await setReplicaPreference(owner, { ...config, policyRevision: 2 })
  expect(await Promise.all(retired.map(obsolete => local.readLocal(obsolete)))).toEqual(retired.map(() => "invalid retired data"))
})

it.each(["read", "save"] as const)("Given older private access without a current repository, when performing a current %s, then preserve exact older sources without activating them", async action => {
  const owner = crypto.randomUUID()
  const records = [
    { key: `tincanban.blind-replicas.v1.${owner}`, value: JSON.stringify([config]) },
    { key: `tincanban.device-replica-preferences.v1.${owner}`, value: JSON.stringify([
      { origin: config.origin, scopeId: config.scopeId, changedAt: 9999999999999, config: null },
    ]) },
    { key: `tincanban.private-replica-legacy-snapshot.v1.${owner}`, value: "original-migration-fingerprint" },
  ]
  for (const { key, value } of records) await local.writeLocal(key, value)
  const added = { ...config, scopeId: encodeBlindBytes(new Uint8Array(32).fill(3)), workspaceId: "new-board" }
  if (action === "save") await setReplicaPreference(owner, added)
  const selected = await getReplicaConfigurations(owner)
  expect(selected.map(value => value.workspaceId)).toEqual(action === "save" ? ["new-board"] : [])
  expect(await Promise.all(records.map(({ key }) => local.readLocal(key)))).toEqual(records.map(({ value }) => value))
  expect(await local.readLocal(privateReplicaStateStorageKey(owner))).not.toBeNull()
})

it("Given an authoritative removal and older credentials, when reopening, then retain the older evidence without resurrecting the removed scope", async () => {
  const owner = crypto.randomUUID()
  const active = changeReplicaPreference(emptyPrivateReplicaState(owner, "current"), config)
  const removed = changeReplicaPreference(active, config, true)
  const raw = JSON.stringify(removed)
  await local.writeLocal(privateReplicaStateStorageKey(owner), raw)
  const legacyKey = `tincanban.blind-replicas.v1.${owner}`, legacy = JSON.stringify([config])
  await local.writeLocal(legacyKey, legacy)
  expect(await getReplicaConfigurations(owner)).toEqual([])
  expect(await local.readLocal(privateReplicaStateStorageKey(owner))).toBe(raw)
  expect(await local.readLocal(legacyKey)).toBe(legacy)
})
