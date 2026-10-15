import { expect, it, vi } from "vitest"
import * as local from "../localDb"
import type { LocalStatePlan } from "../localDb"
import { encodeBlindBytes } from "./blindEnvelope"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, getPrivateReplicaProgress, getReplicaConfigurations, getReplicaPreferenceConflicts, getPrivateReplicaConflictSummaries, persistPrivateReplicaProgress, persistPrivateReplicaState,
  receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const identityConfig = (personId: string): IdentityReplicaConfig => ({ purpose: "identity", personId,
  origin: "https://rusty.example", scopeId: "B".repeat(43), readToken: token, writeToken: token, contentKey: token,
  servicePublicKey: token, policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "" })
const legacyKey = (owner: string) => `tincanban.blind-replicas.v1.${owner}`
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

it("Given legacy credentials and progress, when migrating and restarting the repository, then preserve local progress and export only portable state", async () => {
  const owner = crypto.randomUUID()
  await local.writeLocal(legacyKey(owner), JSON.stringify([config]))
  const migrated = await getReplicaConfigurations(owner)
  expect(migrated[0]).toMatchObject({ cursor: 19, lastUploaded: token })
  expect(await getReplicaConfigurations(owner)).toEqual(migrated)
  expect(await local.readLocal(legacyKey(owner))).toBe(JSON.stringify([config]))
  const wire = await exportPrivateReplicaState(owner)
  expect(wire.version).toBe(3)
  expect(JSON.stringify(wire)).not.toContain('"cursor":19')
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

it("Given a tombstone in the old registry but a stale effective config, when migrating, then do not resurrect the removed connection", async () => {
  const owner = crypto.randomUUID()
  await local.writeLocal(legacyKey(owner), JSON.stringify([config]))
  await local.writeLocal(`tincanban.device-replica-preferences.v1.${owner}`,
    JSON.stringify([{ origin: config.origin, scopeId: config.scopeId, changedAt: 9999999999999, config: null }]))
  expect(await getReplicaConfigurations(owner)).toEqual([])
})

it("Given a v2 migration and an older live tab writing a late tombstone beside a newer registry credential, when local state is read, then retain the removal without timestamp precedence", async () => {
  const owner = crypto.randomUUID()
  const newerLegacy = { ...config, contentKey: testKey(37) }
  await local.writeLocal(legacyKey(owner), JSON.stringify([config]))
  expect((await getReplicaConfigurations(owner))[0]?.contentKey).toBe(config.contentKey)

  const registry = `tincanban.device-replica-preferences.v1.${owner}`
  await local.writeLocal(registry, JSON.stringify([
    { origin: config.origin, scopeId: config.scopeId, changedAt: 9999999999999, config: newerLegacy },
    { origin: config.origin, scopeId: config.scopeId, changedAt: 1, config: null },
  ]))

  expect(await getReplicaConfigurations(owner)).toEqual([])
  const migrated = await exportPrivateReplicaState(owner)
  expect(migrated.entries[0]?.operations.map(operation => operation.config?.contentKey ?? null).sort())
    .toEqual([null, config.contentKey, newerLegacy.contentKey].sort())
  expect(await exportPrivateReplicaState(owner)).toEqual(migrated)
})

it("Given unchanged legacy bytes after migration, when the repository is read repeatedly, then reuse the exact-pair fingerprint", async () => {
  const owner = crypto.randomUUID()
  await local.writeLocal(legacyKey(owner), JSON.stringify([config]))
  await getReplicaConfigurations(owner)
  const digest = vi.spyOn(crypto.subtle, "digest")
  try {
    await getReplicaConfigurations(owner)
    await exportPrivateReplicaState(owner)
    expect(digest).not.toHaveBeenCalled()
  } finally {
    digest.mockRestore()
  }
})

it("Given legacy effective credentials disagree with the registry, when migrating, then preserve both variants as a restart-stable conflict without trusting wall-clock timestamps", async () => {
  const owner = crypto.randomUUID()
  const other = { ...config, contentKey: testKey(31) }
  const settings = JSON.stringify([config])
  const preferences = JSON.stringify([{ origin: config.origin, scopeId: config.scopeId, changedAt: 9999999999999, config: other }])
  await local.writeLocal(legacyKey(owner), settings)
  await local.writeLocal(`tincanban.device-replica-preferences.v1.${owner}`, preferences)
  expect(await getReplicaConfigurations(owner)).toEqual([])
  expect(await getReplicaPreferenceConflicts(owner)).toEqual([{ origin: config.origin, scopeId: config.scopeId }])
  expect(await getPrivateReplicaConflictSummaries(owner)).toEqual([{ origin: config.origin, scopeId: config.scopeId,
    workspaceIds: [config.workspaceId], identityState: false }])
  const wire = await exportPrivateReplicaState(owner)
  const variants = wire.entries[0]!.operations.map(operation => operation.config?.contentKey).sort()
  expect(variants).toEqual([config.contentKey, other.contentKey].sort())
  expect(await exportPrivateReplicaState(owner)).toEqual(wire)
  expect(await local.readLocal(legacyKey(owner))).toBe(settings)
  expect(await local.readLocal(`tincanban.device-replica-preferences.v1.${owner}`)).toBe(preferences)
})

it("Given repeated incompatible entries in one legacy source, when migrating, then retain all credential variants instead of last-entry precedence", async () => {
  const owner = crypto.randomUUID()
  await local.writeLocal(legacyKey(owner), JSON.stringify([config, { ...config, writeToken: testKey(32) }]))
  expect(await getReplicaConfigurations(owner)).toEqual([])
  expect((await exportPrivateReplicaState(owner)).entries[0]!.operations).toHaveLength(2)
  expect(await getReplicaPreferenceConflicts(owner)).toHaveLength(1)
})

it("Given identical legacy credentials have divergent local progress, when migrating, then use the earliest cursor and require a fresh acknowledgment", async () => {
  const owner = crypto.randomUUID()
  await local.writeLocal(legacyKey(owner), JSON.stringify([config, { ...config, cursor: 3, lastUploaded: testKey(33) }]))
  expect(await getReplicaPreferenceConflicts(owner)).toEqual([])
  expect((await getReplicaConfigurations(owner))[0]).toMatchObject({ cursor: 3, lastUploaded: "" })
})

it("Given a legacy store changes before migration commits, when reopening the repository, then retry against both current raw stores instead of publishing a stale snapshot", async () => {
  const owner = crypto.randomUUID()
  const replacement = { ...config, contentKey: testKey(34) }
  await local.writeLocal(legacyKey(owner), JSON.stringify([config]))
  const commit = local.compareAndSwapLocal
  const race = vi.spyOn(local, "compareAndSwapLocal").mockImplementationOnce(async (plan, guard) => {
    expect(plan.conditions).toEqual(expect.arrayContaining([
      { key: legacyKey(owner), value: JSON.stringify([config]) },
      { key: `tincanban.device-replica-preferences.v1.${owner}`, value: null },
    ]))
    await local.writeLocal(legacyKey(owner), JSON.stringify([replacement]))
    return commit(plan, guard)
  })
  try { expect((await getReplicaConfigurations(owner))[0]).toMatchObject({ contentKey: replacement.contentKey }) }
  finally { race.mockRestore() }
  expect((await exportPrivateReplicaState(owner)).entries[0]!.operations[0]!.config?.contentKey).toBe(replacement.contentKey)
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

it("Given legacy config and preference records, when planning import, then capture all migration inputs and return a write plan without writing", async () => {
  const owner = crypto.randomUUID()
  const stateKey = `tincanban.private-replica-state.v2.${owner}`
  const settings = legacyKey(owner)
  const preferences = `tincanban.device-replica-preferences.v1.${owner}`
  const snapshot = `tincanban.private-replica-legacy-snapshot.v1.${owner}`
  const legacyPreference = [{ origin: config.origin, scopeId: config.scopeId, changedAt: 10, config }]
  await local.writeLocal(settings, JSON.stringify([config]))
  await local.writeLocal(preferences, JSON.stringify(legacyPreference))
  const savedSettings = await local.readLocal(settings)
  const savedPreferences = await local.readLocal(preferences)
  const incoming = { version: 2 as const, personId: owner, clock: {}, entries: [] }

  const plan = await (await import("./privateReplicaRepository") as unknown as {
    planPrivateReplicaImport(owner: string, incoming: unknown): Promise<LocalStatePlan>
  }).planPrivateReplicaImport(owner, incoming)

  expect(plan.conditions).toEqual([
    { key: stateKey, value: null },
    { key: settings, value: savedSettings },
    { key: preferences, value: savedPreferences },
    { key: snapshot, value: null },
    { key: await (await import("./replicaCredentialFreezeState")).replicaCredentialFreezeKey(owner, config.origin), value: null },
  ])
  expect(plan.writes).toHaveLength(2)
  const migrated = JSON.parse(plan.writes[0].value!)
  expect(migrated.migrated).toBe(true)
  expect(migrated.progress[`${config.origin}/${config.scopeId}`]).toMatchObject({ cursor: 19, lastUploaded: token })
  expect(await local.readLocal(stateKey)).toBeNull()
  expect(await local.readLocal(settings)).toBe(savedSettings)
  expect(await local.readLocal(preferences)).toBe(savedPreferences)
  expect(await local.readLocal(snapshot)).toBeNull()
})

it("Given existing replica progress, when planning a same-person import, then retain its durable cursor and reject a stale legacy CAS", async () => {
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
  expect(plan.conditions).toHaveLength(5)
  expect(plan.conditions.find(value => value.key === stateKey)?.value).not.toBeNull()
  const next = JSON.parse(plan.writes[0].value!)
  expect(next.progress[`${config.origin}/${config.scopeId}`]).toMatchObject({ cursor: 31, lastUploaded: token })
  expect(before.entries).toHaveLength(1)

  const legacy = plan.conditions.find(value => value.key === legacyKey(owner))!
  await local.writeLocal(legacy.key, "changed-by-old-tab")
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
