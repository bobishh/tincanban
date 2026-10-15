import { expect, it, vi } from "vitest"
import * as local from "../localDb"
import type { LocalStatePlan } from "../localDb"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { exportPrivateReplicaState, getIdentityReplicaConfigurations, getPrivateReplicaProgress, getReplicaConfigurations, persistPrivateReplicaProgress,
  receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const config: BlindReplicaConfig = { origin: "https://rusty.example", workspaceId: "board", scopeId: token,
  readToken: token, writeToken: token, contentKey: token, servicePublicKey: token, policyRevision: 1,
  keyEpoch: 1, cursor: 19, lastUploaded: token }
const identityConfig = (personId: string): IdentityReplicaConfig => ({ purpose: "identity", personId,
  origin: "https://rusty.example", scopeId: "B".repeat(43), readToken: token, writeToken: token, contentKey: token,
  servicePublicKey: token, policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "" })
const legacyKey = (owner: string) => `tincanban.blind-replicas.v1.${owner}`

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

it("Given a tombstone in the old registry but a stale effective config, when migrating, then do not resurrect the removed connection", async () => {
  const owner = crypto.randomUUID()
  await local.writeLocal(legacyKey(owner), JSON.stringify([config]))
  await local.writeLocal(`tincanban.device-replica-preferences.v1.${owner}`,
    JSON.stringify([{ origin: config.origin, scopeId: config.scopeId, changedAt: 9999999999999, config: null }]))
  expect(await getReplicaConfigurations(owner)).toEqual([])
})

it("Given a failed atomic preference transaction, when reconnecting the repository, then retain the previous complete state", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const before = await exportPrivateReplicaState(owner)
  const failure = vi.spyOn(local, "updateLocal").mockRejectedValueOnce(new Error("Private-state transaction aborted"))
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

it("Given legacy config and preference records, when planning import, then capture all three raw inputs, retain progress, and perform no writes", async () => {
  const owner = crypto.randomUUID()
  const stateKey = `tincanban.private-replica-state.v2.${owner}`
  const settings = legacyKey(owner)
  const preferences = `tincanban.device-replica-preferences.v1.${owner}`
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
  ])
  expect(plan.writes).toHaveLength(1)
  const migrated = JSON.parse(plan.writes[0].value!)
  expect(migrated.migrated).toBe(true)
  expect(migrated.progress[`${config.origin}/${config.scopeId}`]).toMatchObject({ cursor: 19, lastUploaded: token })
  expect(await local.readLocal(stateKey)).toBeNull()
  expect(await local.readLocal(settings)).toBe(savedSettings)
  expect(await local.readLocal(preferences)).toBe(savedPreferences)
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
  expect(plan.conditions).toHaveLength(3)
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
