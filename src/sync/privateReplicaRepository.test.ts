import { expect, it, vi } from "vitest"
import * as local from "../localDb"
import type { LocalStatePlan } from "../localDb"
import { encodeBlindBytes } from "./blindEnvelope"
import { changeReplicaPreference, emptyPrivateReplicaState, mergePrivateReplicaState, portableReplicaState } from "./privateReplicaPreferences"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, getPrivateReplicaProgress, getReplicaConfigurations, getReplicaPreferenceConflicts, persistPrivateReplicaProgress, persistPrivateReplicaState,
  receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const identityConfig = (personId: string): IdentityReplicaConfig => ({ purpose: "identity", personId,
  origin: "https://rusty.example", scopeId: "B".repeat(43), readToken: token, writeToken: token, contentKey: token,
  servicePublicKey: token, policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "" })
const testKey = (fill: number) => encodeBlindBytes(new Uint8Array(32).fill(fill))

async function seedRotatedReplica() {
  const owner = crypto.randomUUID()
  const firstKey = testKey(1)
  const secondKey = testKey(2)
  const initial = { ...config, keyEpoch: 1, contentKey: firstKey }
  const rotated: BlindReplicaConfig = { ...initial, keyEpoch: 2, contentKey: secondKey,
    historicalContentKeys: { "1": firstKey } }
  await setReplicaPreference(owner, initial)
  await setReplicaPreference(owner, rotated)
  const selected = (await getReplicaConfigurations(owner))[0]!
  await persistPrivateReplicaProgress(owner, { ...selected, cursor: 17, lastUploaded: token })
  return { owner, initial, rotated, firstKey, secondKey }
}

function newerPrivateImport(wire: Awaited<ReturnType<typeof exportPrivateReplicaState>>, config: BlindReplicaConfig) {
  const incoming = structuredClone(wire) as typeof wire & { entries: Array<{ operations: Array<{ dot: { actorId: string; counter: number };
    context: Record<string, number>; config: BlindReplicaConfig | null }> }> }
  const operation = incoming.entries[0]!.operations[0]!
  const actor = operation.dot.actorId
  operation.context = structuredClone(incoming.clock)
  operation.dot.counter = (incoming.clock[actor] ?? 0) + 1
  incoming.clock[actor] = operation.dot.counter
  operation.config = { ...config, cursor: 0, lastUploaded: "" }
  return incoming
}

type UnsafeKeyChange = (value: BlindReplicaConfig, firstKey: string, otherKey: string) => BlindReplicaConfig
const unsafeKeyChanges: Array<[string, UnsafeKeyChange]> = [
  ["rolls the epoch back", (value, firstKey) => {
    const withoutHistory = { ...value }; delete withoutHistory.historicalContentKeys
    return { ...withoutHistory, keyEpoch: 1, contentKey: firstKey }
  }],
  ["changes the active key at the same epoch", (value, _firstKey, otherKey) => ({ ...value, contentKey: otherKey })],
  ["drops retained history", value => {
    const withoutHistory = { ...value }; delete withoutHistory.historicalContentKeys
    return withoutHistory
  }],
  ["changes a retained key", (value, _firstKey, otherKey) => ({ ...value, historicalContentKeys: { "1": otherKey } })],
]

it("Given an uncertain encrypted upload, when local credentials rotate, then refuse migration and preserve exact outbox bytes", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const progress = await getPrivateReplicaProgress(owner, selected)
  const pending = { requestId: crypto.randomUUID(), hash: token, bytes: 1, object: { version: 1 as const,
    scopeId: config.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } }
  await persistPrivateReplicaState(owner, selected, progress.generation, { ...progress, generation: progress.generation + 1, pending })
  const before = await local.readLocal(`tincanban.private-replica-state.v2.${owner}`)
  await expect(setReplicaPreference(owner, { ...selected, keyEpoch: 2, contentKey: testKey(21),
    historicalContentKeys: { "1": config.contentKey } })).rejects.toThrow(/pending.*outbox|migration/i)
  expect(await local.readLocal(`tincanban.private-replica-state.v2.${owner}`)).toBe(before)
  expect((await getPrivateReplicaProgress(owner, selected)).pending).toEqual(pending)
})

it("Given an uncertain encrypted upload, when only scope policy advances, then rebind progress without replacing ciphertext or request identity", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const progress = await getPrivateReplicaProgress(owner, selected)
  const pending = { requestId: crypto.randomUUID(), hash: token, bytes: 1, object: { version: 1 as const,
    scopeId: config.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } }
  await persistPrivateReplicaState(owner, selected, progress.generation, { ...progress, generation: progress.generation + 1, pending })
  await setReplicaPreference(owner, { ...selected, policyRevision: 2 })
  const updated = (await getReplicaConfigurations(owner))[0]!
  expect((await getPrivateReplicaProgress(owner, updated)).pending).toEqual(pending)
})

it("Given unchanged keys with concurrent policy observations and an uncertain upload, when importing and reopening, then keep ciphertext, request identity and cursor without recovery", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const base = await exportPrivateReplicaState(owner)
  const peer = mergePrivateReplicaState(emptyPrivateReplicaState(owner, "peer"), base)
  const progress = await getPrivateReplicaProgress(owner, selected)
  const pending = { requestId: crypto.randomUUID(), hash: token, bytes: 1, object: { version: 1 as const,
    scopeId: config.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } }
  await persistPrivateReplicaState(owner, selected, progress.generation, { ...progress, cursor: 17, generation: progress.generation + 1, pending })
  await setReplicaPreference(owner, { ...selected, policyRevision: 2, minimumWriterVersion: 2 })
  await receivePrivateReplicaState(owner, portableReplicaState(changeReplicaPreference(peer, { ...config, policyRevision: 3 })))
  expect(await getReplicaPreferenceConflicts(owner)).toEqual([])
  const updated = (await getReplicaConfigurations(owner))[0]!
  expect(updated).toMatchObject({ policyRevision: 3, minimumWriterVersion: 2, cursor: 17 })
  expect((await getPrivateReplicaProgress(owner, updated)).pending).toEqual(pending)
  expect(await getReplicaConfigurations(owner)).toEqual([updated])
})

it("Given same-person identity credentials, when stored and read, then keep them out of workspace configuration APIs and bind progress to identity purpose", async () => {
  const owner = "person-owner"
  const identity = identityConfig(owner)
  await setReplicaPreference(owner, config)
  await setReplicaPreference(owner, identity)
  const selectedIdentity = (await getIdentityReplicaConfigurations(owner))[0]

  expect(await getReplicaConfigurations(owner)).toHaveLength(1)
  expect(await getReplicaConfigurations(owner)).not.toContainEqual(expect.objectContaining({ personId: owner }))
  expect(await getIdentityReplicaConfigurations(owner)).toEqual(expect.arrayContaining([expect.objectContaining({ personId: owner, purpose: "identity" })]))
  expect(await getPrivateReplicaProgress(owner, selectedIdentity)).toMatchObject({ binding: expect.any(String), cursor: 0 })
  expect(await getPrivateReplicaProgress(owner, selectedIdentity)).not.toEqual(await getPrivateReplicaProgress(owner, (await getReplicaConfigurations(owner))[0]))
  expect(await exportPrivateReplicaState(owner).then(value => JSON.stringify(value))).toContain('"purpose":"identity"')
})

it("Given identity credentials belonging to another person, when setting or reading progress, then reject the mismatched subject", async () => {
  const owner = "person-owner"
  await expect(async () => setReplicaPreference(owner, identityConfig("person-other"))).rejects.toThrow(/identity/i)
  await setReplicaPreference(owner, identityConfig(owner))
  await expect(getPrivateReplicaProgress(owner, identityConfig("person-other"))).rejects.toThrow(/identity/i)
})

it("Given a same-resource key rotation, when saving locally or importing it, then retain each prior active key and keep policy-only changes key-stable", async () => {
  const owner = crypto.randomUUID()
  const firstKey = testKey(11)
  const secondKey = testKey(12)
  const thirdKey = testKey(13)
  const initial = { ...config, keyEpoch: 1, contentKey: firstKey }
  const rotated: BlindReplicaConfig = { ...initial, keyEpoch: 2, contentKey: secondKey,
    historicalContentKeys: { "1": firstKey } }
  await setReplicaPreference(owner, initial)
  await setReplicaPreference(owner, rotated)
  expect((await getReplicaConfigurations(owner))[0]).toMatchObject({ keyEpoch: 2, contentKey: secondKey,
    historicalContentKeys: { "1": firstKey } })

  const policyOnly = { ...rotated, policyRevision: 2 }
  await setReplicaPreference(owner, policyOnly)
  expect((await getReplicaConfigurations(owner))[0]).toMatchObject({ keyEpoch: 2, contentKey: secondKey,
    historicalContentKeys: { "1": firstKey } })

  const beforeImport = await exportPrivateReplicaState(owner)
  const next: BlindReplicaConfig = { ...policyOnly, keyEpoch: 3, contentKey: thirdKey,
    historicalContentKeys: { "1": firstKey, "2": secondKey } }
  await receivePrivateReplicaState(owner, newerPrivateImport(beforeImport, next))
  expect((await getReplicaConfigurations(owner))[0]).toMatchObject({ keyEpoch: 3, contentKey: thirdKey,
    historicalContentKeys: { "1": firstKey, "2": secondKey } })
})

it.each(unsafeKeyChanges)("Given saved progress and a same-resource config that %s, when setting it locally, then reject without changing exact bytes, exported state or progress", async (_name, mutate) => {
  const { owner, firstKey, rotated } = await seedRotatedReplica()
  const stateKey = `tincanban.private-replica-state.v2.${owner}`
  const beforeBytes = await local.readLocal(stateKey)
  const beforeExport = await exportPrivateReplicaState(owner)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const beforeProgress = await getPrivateReplicaProgress(owner, selected)
  const candidate = mutate(rotated, firstKey, testKey(21))

  await expect(setReplicaPreference(owner, candidate)).rejects.toThrow(/key|epoch|history|rotation/i)

  expect(await local.readLocal(stateKey)).toBe(beforeBytes)
  expect(await exportPrivateReplicaState(owner)).toEqual(beforeExport)
  expect(await getPrivateReplicaProgress(owner, (await getReplicaConfigurations(owner))[0]!)).toEqual(beforeProgress)
})

it.each(unsafeKeyChanges)("Given saved progress and an imported config that %s, when the causally newer private state arrives, then reject without changing exact bytes, exported state or progress", async (_name, mutate) => {
  const { owner, firstKey, rotated } = await seedRotatedReplica()
  const stateKey = `tincanban.private-replica-state.v2.${owner}`
  const beforeBytes = await local.readLocal(stateKey)
  const beforeExport = await exportPrivateReplicaState(owner)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const beforeProgress = await getPrivateReplicaProgress(owner, selected)
  const candidate = mutate(rotated, firstKey, testKey(31))
  const incoming = newerPrivateImport(beforeExport, candidate)

  await expect(receivePrivateReplicaState(owner, incoming)).rejects.toThrow(/key|epoch|history|rotation/i)

  expect(await local.readLocal(stateKey)).toBe(beforeBytes)
  expect(await exportPrivateReplicaState(owner)).toEqual(beforeExport)
  expect(await getPrivateReplicaProgress(owner, (await getReplicaConfigurations(owner))[0]!)).toEqual(beforeProgress)
})

it("Given a failed atomic preference transaction, when reconnecting the repository, then retain the previous complete state", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const before = await exportPrivateReplicaState(owner)
  const failure = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("Private-state transaction aborted"))
  try { await expect(setReplicaPreference(owner, { ...config, policyRevision: 2 })).rejects.toThrow("transaction aborted") }
  finally { failure.mockRestore() }
  expect(await exportPrivateReplicaState(owner)).toEqual(before)
  expect((await getReplicaConfigurations(owner))[0].policyRevision).toBe(1)
})

it("Given an identity switch during a cursor transaction, when commit is attempted, then leave the prior progress intact", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]
  await expect(persistPrivateReplicaProgress(owner, { ...selected, cursor: 99 }, () => { throw new Error("Identity changed") })).rejects.toThrow("Identity changed")
  expect((await getReplicaConfigurations(owner))[0].cursor).toBe(0)
})

it("Given private state arriving during a cursor update, when both transactions commit, then preserve the imported connection and existing progress", async () => {
  const owner = crypto.randomUUID()
  const peer = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  await setReplicaPreference(peer, { ...config, scopeId: "B".repeat(43), workspaceId: "other-board" })
  const incoming = { ...await exportPrivateReplicaState(peer), personId: owner }
  const current = (await getReplicaConfigurations(owner))[0]
  await Promise.all([receivePrivateReplicaState(owner, incoming), persistPrivateReplicaProgress(owner, { ...current, cursor: 7 })])
  const configs = await getReplicaConfigurations(owner)
  expect(configs).toHaveLength(2)
  expect(configs.find(value => value.scopeId === config.scopeId)?.cursor).toBe(7)
})

it("Given malformed local progress, when exporting state, then reject it instead of exporting valid preferences", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]
  await persistPrivateReplicaProgress(owner, { ...selected, cursor: 7, lastUploaded: token })
  const key = `tincanban.private-replica-state.v2.${owner}`
  const progressKey = `${config.origin}/${config.scopeId}`
  const original = JSON.parse((await local.readLocal(key))!)
  for (const mutate of [
    (saved: { progress: Record<string, Record<string, unknown>> }) => { saved.progress[progressKey].unexpected = "must be rejected" },
    (saved: { progress: Record<string, Record<string, unknown>> }) => { saved.progress[progressKey].cursor = Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const saved = structuredClone(original)
    mutate(saved)
    await local.writeLocal(key, JSON.stringify(saved))
    await expect(exportPrivateReplicaState(owner)).rejects.toThrow(/progress|private replica/i)
  }
})

it("Given existing replica progress, when planning a same-person import, then retain its durable cursor and reject a stale current-state CAS", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]
  await persistPrivateReplicaProgress(owner, { ...selected, cursor: 31, lastUploaded: token })
  const before = (await exportPrivateReplicaState(owner))
  const peer = crypto.randomUUID()
  const other = { ...config, scopeId: "B".repeat(43), workspaceId: "other-board" }
  await setReplicaPreference(peer, other)
  const incoming = { ...await exportPrivateReplicaState(peer), personId: owner }
  const stateKey = `tincanban.private-replica-state.v2.${owner}`
  const plan = await (await import("./privateReplicaRepository") as unknown as {
    planPrivateReplicaImport(owner: string, incoming: unknown): Promise<LocalStatePlan>
  }).planPrivateReplicaImport(owner, incoming)
  expect(plan.conditions).toHaveLength(2)
  expect(plan.conditions.find(value => value.key === stateKey)?.value).not.toBeNull()
  const next = JSON.parse(plan.writes[0].value!)
  expect(next.progress[`${config.origin}/${config.scopeId}`]).toMatchObject({ cursor: 31, lastUploaded: token })
  expect(before.entries).toHaveLength(1)

  await persistPrivateReplicaProgress(owner, { ...(await getReplicaConfigurations(owner))[0]!, cursor: 32, lastUploaded: token })
  expect(await local.compareAndSwapLocal(plan)).toBe(false)
  expect(await local.readLocal(stateKey)).not.toBe(plan.writes[0].value)
})

it("Given an incoming private replica state for another person, when planning import, then reject before reading local records", async () => {
  const owner = crypto.randomUUID()
  const other = crypto.randomUUID()
  const incoming = { version: 2 as const, personId: other, clock: {}, entries: [] }
  const read = vi.spyOn(local, "readLocal")
  await expect((await import("./privateReplicaRepository") as unknown as {
    planPrivateReplicaImport(owner: string, incoming: unknown): Promise<LocalStatePlan>
  }).planPrivateReplicaImport(owner, incoming)).rejects.toThrow(/identity mismatch/i)
  expect(read).not.toHaveBeenCalled()
})
