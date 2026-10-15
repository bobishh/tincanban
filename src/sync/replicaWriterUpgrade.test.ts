import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import type { BlindReplicaConfig } from "./blindReplication"
import type { BlindObject } from "./blindEnvelope"
import type { ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import type * as ReplicaRepository from "./privateReplicaRepository"
import type * as LocalDb from "../localDb"

let repository: typeof ReplicaRepository
let local: typeof LocalDb
beforeAll(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  local = await import("../localDb")
  repository = await import("./privateReplicaRepository")
})
afterAll(() => vi.unstubAllGlobals())

const token = "A".repeat(43)
const config: BlindReplicaConfig = { origin: "https://rusty.example", scopeId: "scope-upgrade", workspaceId: "board",
  servicePublicKey: token, readToken: token, writeToken: token, contentKey: token, keyEpoch: 1,
  policyRevision: 3, cursor: 0, lastUploaded: "" }
const stateKey = (owner: string) => `tincanban.private-replica-state.v2.${owner}`
const scopeKey = `${config.origin}/${config.scopeId}`
const upgrades = () => repository

async function fixture(withPending = false, servicePublicKey = token) {
  const owner = crypto.randomUUID()
  await repository.setReplicaPreference(owner, { ...config, servicePublicKey })
  const [selected] = await repository.getReplicaConfigurations(owner)
  const before = await repository.getPrivateReplicaProgress(owner, selected!)
  const progress: ReplicaState<BlindObject> = { ...before, generation: 1, cursor: 17, lastUploaded: token,
    uploadedRevision: "document-and-index:7", contentIdentity: "content:7",
    ...(withPending ? { pending: { requestId: crypto.randomUUID(), hash: token, bytes: 1,
      object: { version: 1 as const, scopeId: config.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } } } : {}) }
  await repository.persistPrivateReplicaState(owner, selected!, 0, progress)
  return { owner, selected: (await repository.getReplicaConfigurations(owner))[0]!, progress }
}

test("Given confirmed document progress, when writer upgrade is prepared and resumed after restart, then freeze the old writer and atomically preserve its cursor and acknowledgment", async () => {
  const { owner, selected, progress } = await fixture()
  const portable = await repository.exportPrivateReplicaState(owner)
  const revision = await local.readLocal("tincanban.identity-state-revision.v1")
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  expect(await repository.exportPrivateReplicaState(owner)).toEqual(portable)
  expect(await local.readLocal("tincanban.identity-state-revision.v1")).toBe(revision)
  await expect(repository.getPrivateReplicaProgress(owner, selected)).rejects.toThrow(/writer.*upgrade|policy.*pending/i)
  await expect(repository.persistPrivateReplicaState(owner, selected, progress.generation,
    { ...progress, generation: progress.generation + 1, cursor: 18 })).rejects.toThrow(/writer.*upgrade|policy.*pending/i)
  await expect(repository.persistPrivateReplicaProgress(owner, { ...selected, cursor: 18 })).rejects.toThrow(/writer.*upgrade|policy.*pending/i)
  vi.resetModules()
  local = await import("../localDb")
  repository = await import("./privateReplicaRepository")
  expect(await upgrades().readReplicaWriterUpgrade(owner, selected)).toEqual(upgrade)
  const next = await upgrades().completeReplicaWriterUpgrade(owner, upgrade, 4)
  expect(next).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4, cursor: 17, lastUploaded: token })
  expect(next.preferenceRevision).not.toBe(selected.preferenceRevision)
  expect(await repository.getPrivateReplicaProgress(owner, next)).toEqual({ ...progress,
    binding: repository.privateReplicaBinding(owner, next), generation: progress.generation + 1 })
  expect(await upgrades().readReplicaWriterUpgrade(owner, next)).toBeUndefined()
  await expect(repository.getPrivateReplicaProgress(owner, selected)).rejects.toThrow(/revision changed/i)
  const exported = JSON.stringify(await repository.exportPrivateReplicaState(owner))
  expect(exported).toContain('"minimumWriterVersion":2')
  expect(exported).not.toContain(upgrade.id)
  expect(exported).not.toContain("uploadedRevision")
  expect((await indexedDB.databases()).some(database => database.name === "tincanban-local-state-v1")).toBe(true)
})

test("Given pending exact ciphertext, when preparing writer migration, then require its acknowledgment and preserve the complete raw record", async () => {
  const { owner, selected } = await fixture(true)
  const raw = await local.readLocal(stateKey(owner))
  await expect(upgrades().prepareReplicaWriterUpgrade(owner, selected)).rejects.toThrow(/pending.*upload|outbox/i)
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
})

test("Given two tabs preparing the same upgrade, when they race, then both observe one durable intent", async () => {
  const { owner, selected } = await fixture()
  const [left, right] = await Promise.all([
    upgrades().prepareReplicaWriterUpgrade(owner, selected), upgrades().prepareReplicaWriterUpgrade(owner, selected),
  ])
  expect(left).toEqual(right)
})

test("Given a confirmed remote policy and a failed local transaction, when completing then retrying, then retain the intent and publish the same progress only once", async () => {
  const { owner, selected } = await fixture()
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const raw = await local.readLocal(stateKey(owner))
  const failure = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("Disk transaction aborted"))
  try { await expect(upgrades().completeReplicaWriterUpgrade(owner, upgrade, 4)).rejects.toThrow("Disk transaction aborted") }
  finally { failure.mockRestore() }
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
  const next = await upgrades().completeReplicaWriterUpgrade(owner, upgrade, 5)
  expect(next).toMatchObject({ minimumWriterVersion: 2, policyRevision: 5, cursor: 17 })
  const committed = await local.readLocal(stateKey(owner))
  await expect(upgrades().completeReplicaWriterUpgrade(owner, upgrade, 5)).rejects.toThrow(/pending|intent/i)
  expect(await local.readLocal(stateKey(owner))).toBe(committed)
})

test("Given an upgrade intent, when another tab changes the same scope, then reject local replacement while allowing unrelated connections", async () => {
  const { owner, selected } = await fixture()
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const raw = await local.readLocal(stateKey(owner))
  await expect(repository.setReplicaPreference(owner, { ...selected, readToken: "B".repeat(43) })).rejects.toThrow(/writer.*upgrade|policy.*pending/i)
  await expect(repository.setReplicaPreference(owner, selected, true)).rejects.toThrow(/writer.*upgrade|policy.*pending/i)
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
  await repository.setReplicaPreference(owner, { ...config, scopeId: "unrelated-scope" })
  expect(await upgrades().readReplicaWriterUpgrade(owner, selected)).toEqual(upgrade)
  expect((await upgrades().completeReplicaWriterUpgrade(owner, upgrade, 4)).cursor).toBe(17)
})

test("Given a durable upgrade, when confirmation is stale, substituted or the identity changes, then retain its exact intent and progress", async () => {
  const { owner, selected } = await fixture()
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const raw = await local.readLocal(stateKey(owner))
  for (const revision of [0, 3, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(upgrades().completeReplicaWriterUpgrade(owner, upgrade, revision)).rejects.toThrow(/revision/i)
  }
  await expect(upgrades().completeReplicaWriterUpgrade(owner, { ...upgrade, id: crypto.randomUUID() }, 4)).rejects.toThrow(/intent/i)
  await expect(upgrades().completeReplicaWriterUpgrade(owner, upgrade, 4, () => { throw new Error("Identity changed") })).rejects.toThrow("Identity changed")
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
})

test("Given concurrent portable credentials during an interrupted upgrade, when importing then completing, then preserve the intent and refuse to overwrite the conflict", async () => {
  const { owner, selected } = await fixture()
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const peer = crypto.randomUUID()
  await repository.setReplicaPreference(peer, { ...config, readToken: "B".repeat(43) })
  const incoming = { ...await repository.exportPrivateReplicaState(peer), personId: owner }
  await repository.receivePrivateReplicaState(owner, incoming)
  const raw = await local.readLocal(stateKey(owner))
  expect(JSON.parse(raw!).writerUpgrades[scopeKey]).toEqual(upgrade)
  await expect(upgrades().completeReplicaWriterUpgrade(owner, upgrade, 4)).rejects.toThrow(/revision|conflict/i)
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
})

test("Given a damaged persisted writer intent, when reading the repository, then reject rather than silently remove the migration barrier", async () => {
  const { owner, selected } = await fixture()
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  for (const damaged of [{ ...upgrade, id: "invalid" }, { ...upgrade, config: { ...selected, scopeId: "other" } }, null]) {
    const saved = JSON.parse((await local.readLocal(stateKey(owner)))!)
    saved.writerUpgrades = { [scopeKey]: damaged }
    const raw = JSON.stringify(saved)
    await local.writeLocal(stateKey(owner), raw)
    await expect(repository.getReplicaConfigurations(owner)).rejects.toThrow(/upgrade|intent/i)
    expect(await local.readLocal(stateKey(owner))).toBe(raw)
  }
})

test("Given a same-person device confirms a policy-only upgrade, when its preference is admitted, then rebind the exact local pending ciphertext without losing its cursor", async () => {
  const { owner, selected, progress } = await fixture(true)
  const preferences = await import("./privateReplicaPreferences")
  const wire = await repository.exportPrivateReplicaState(owner)
  const peerState = { ...wire, actorId: "peer-writer", progress: {}, migrated: true }
  const incoming = preferences.portableReplicaState(preferences.changeReplicaPreference(peerState,
    { ...selected, policyRevision: 4, minimumWriterVersion: 2 }))

  await repository.receivePrivateReplicaState(owner, incoming)

  const [updated] = await repository.getReplicaConfigurations(owner)
  expect(updated).toMatchObject({ policyRevision: 4, minimumWriterVersion: 2, cursor: 17, lastUploaded: token })
  expect(await repository.getPrivateReplicaProgress(owner, updated!)).toEqual({ ...progress,
    binding: repository.privateReplicaBinding(owner, updated!), generation: progress.generation + 1 })
})

test("Given pending ciphertext under a content key, when a portable update changes that key, then refuse activation and retain the exact outbox for explicit migration", async () => {
  const { owner, selected } = await fixture(true)
  const preferences = await import("./privateReplicaPreferences")
  const wire = await repository.exportPrivateReplicaState(owner)
  const peerState = { ...wire, actorId: "peer-key-rotation", progress: {}, migrated: true }
  const incoming = preferences.portableReplicaState(preferences.changeReplicaPreference(peerState,
    { ...selected, contentKey: "B".repeat(42) + "A", keyEpoch: 2, historicalContentKeys: { "1": selected.contentKey }, policyRevision: 4 }))
  const raw = await local.readLocal(stateKey(owner))

  await expect(repository.receivePrivateReplicaState(owner, incoming)).rejects.toThrow(/pending.*migration|outbox/i)

  expect(await local.readLocal(stateKey(owner))).toBe(raw)
})

test("Given an old device index and a peer policy update, when planning admission, then atomically migrate file discovery with preferences and the exact pending outbox", async () => {
  const { owner, selected, progress } = await fixture(true)
  const { createAttachmentIndexRepository } = await import("./attachmentIndexRepository")
  const { attachmentIndexBinding } = await import("./attachmentIndexScope")
  const { blindHash } = await import("./blindClient")
  const preferences = await import("./privateReplicaPreferences")
  const legacy = repository.privateReplicaBinding(owner, selected)
  const oldIndex = createAttachmentIndexRepository(legacy, () => {})
  const locator = { version: 1 as const, blobId: `sha256:${token}`, transferId: "old-device-file", manifestId: token }
  await oldIndex.merge([locator])
  const wire = await repository.exportPrivateReplicaState(owner)
  const incoming = preferences.portableReplicaState(preferences.changeReplicaPreference(
    { ...wire, actorId: "peer-policy-index", progress: {}, migrated: true }, { ...selected, policyRevision: 4, minimumWriterVersion: 2 }))
  const oldKey = `tincanban.attachment-index.v1.${await blindHash(new TextEncoder().encode(legacy))}`
  const targetKey = `tincanban.attachment-index.v1.${await blindHash(new TextEncoder().encode(attachmentIndexBinding(owner, selected)))}`
  const raw = await local.readLocal(stateKey(owner))
  const originalIndex = await local.readLocal(oldKey)
  const plan = await repository.planPrivateReplicaImport(owner, incoming)
  expect(plan.conditions).toContainEqual({ key: oldKey, value: originalIndex })
  expect(plan.conditions).toContainEqual({ key: targetKey, value: null })
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
  expect(await local.readLocal(targetKey)).toBeNull()
  expect(await local.compareAndSwapLocal(plan)).toBe(true)
  const [updated] = await repository.getReplicaConfigurations(owner)
  expect(await repository.getPrivateReplicaProgress(owner, updated!)).toMatchObject({ cursor: 17, pending: progress.pending })
  expect(await createAttachmentIndexRepository(attachmentIndexBinding(owner, updated!), () => {}).read()).toEqual([locator])
  expect(await local.readLocal(oldKey)).toBe(originalIndex)
})

test("Given a legacy index changes during peer policy planning, when publishing the captured plan, then reject the stale transaction and preserve the original preference", async () => {
  const { owner, selected } = await fixture()
  const { createAttachmentIndexRepository } = await import("./attachmentIndexRepository")
  const preferences = await import("./privateReplicaPreferences")
  const oldIndex = createAttachmentIndexRepository(repository.privateReplicaBinding(owner, selected), () => {})
  const locator = { version: 1 as const, blobId: `sha256:${token}`, transferId: "before-plan", manifestId: token }
  await oldIndex.merge([locator])
  const wire = await repository.exportPrivateReplicaState(owner)
  const incoming = preferences.portableReplicaState(preferences.changeReplicaPreference(
    { ...wire, actorId: "peer-policy-race", progress: {}, migrated: true }, { ...selected, policyRevision: 4, minimumWriterVersion: 2 }))
  const raw = await local.readLocal(stateKey(owner))
  const plan = await repository.planPrivateReplicaImport(owner, incoming)
  await oldIndex.merge([{ ...locator, transferId: "after-plan" }])
  expect(await local.compareAndSwapLocal(plan)).toBe(false)
  expect(await local.readLocal(stateKey(owner))).toBe(raw)
  await repository.receivePrivateReplicaState(owner, incoming)
  const [updated] = await repository.getReplicaConfigurations(owner)
  const { createWorkspaceAttachmentIndex } = await import("./attachmentIndexScope")
  expect(await createWorkspaceAttachmentIndex(owner, updated!, () => {}).read()).toHaveLength(2)
})

test("Given a local upgrade reply was lost, when another own device publishes the confirmed policy, then retain the barrier until a fresh receipt completes the same intent", async () => {
  const { owner, selected } = await fixture()
  const upgrade = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const preferences = await import("./privateReplicaPreferences")
  const wire = await repository.exportPrivateReplicaState(owner)
  const incoming = preferences.portableReplicaState(preferences.changeReplicaPreference(
    { ...wire, actorId: "peer-confirmed-floor", progress: {}, migrated: true }, { ...selected, policyRevision: 4, minimumWriterVersion: 2 }))
  await repository.receivePrivateReplicaState(owner, incoming)
  const [peerConfirmed] = await repository.getReplicaConfigurations(owner)
  await expect(repository.getPrivateReplicaProgress(owner, peerConfirmed!)).rejects.toThrow(/upgrade.*pending/i)
  expect(await upgrades().readReplicaWriterUpgrade(owner, peerConfirmed!)).toEqual(upgrade)
  const updated = await upgrades().completeReplicaWriterUpgrade(owner, upgrade, 5)
  expect(updated).toMatchObject({ minimumWriterVersion: 2, policyRevision: 5, cursor: 17 })
  expect(await upgrades().readReplicaWriterUpgrade(owner, updated)).toBeUndefined()
})

test("Given Rusty confirmed a floor upgrade before Worker maintenance fails, when restarting, then retain its verified receipt privately for exact revision reuse", async () => {
  const identity = await import("../domain/identity")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = identity.toBase64Url(rawKey), serviceId = await identity.sha256Base64Url(rawKey)
  const { owner, selected } = await fixture(false, servicePublicKey)
  const intent = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const receipt = await identity.signEnvelope(service.privateKey, { kind: "rusty-scope-policy-receipt" as const, version: 1 as const,
    serviceId, scopeId: selected.scopeId, personId: owner, revision: 4, revoked: false, challengeId: "writer-challenge",
    authorizationHash: token, minimumWriterVersion: 2 as const }, serviceId, "RUSTY/2")
  const confirmed = await repository.confirmReplicaWriterUpgrade(owner, intent, receipt)
  expect(confirmed.confirmed).toEqual(receipt)
  expect(await upgrades().readReplicaWriterUpgrade(owner, selected)).toEqual(confirmed)
  expect(JSON.stringify(await repository.exportPrivateReplicaState(owner))).not.toContain("writer-challenge")
  const updated = await upgrades().completeReplicaWriterUpgrade(owner, confirmed, 4)
  expect(updated).toMatchObject({ policyRevision: 4, minimumWriterVersion: 2, cursor: 17 })
})

test("Given a legacy saved config whose current Rusty scope already has floor 2, when migrating it, then accept and publish the exact no-op revision", async () => {
  const identity = await import("../domain/identity")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = identity.toBase64Url(rawKey), serviceId = await identity.sha256Base64Url(rawKey)
  const { owner, selected } = await fixture(false, servicePublicKey)
  const intent = await upgrades().prepareReplicaWriterUpgrade(owner, selected)
  const receipt = await identity.signEnvelope(service.privateKey, { kind: "rusty-scope-policy-receipt" as const, version: 1 as const,
    serviceId, scopeId: selected.scopeId, personId: owner, revision: selected.policyRevision, revoked: false,
    challengeId: "already-floor-two", authorizationHash: token, minimumWriterVersion: 2 as const }, serviceId, "RUSTY/2")

  await expect(upgrades().completeReplicaWriterUpgrade(owner, intent, selected.policyRevision)).rejects.toThrow(/confirmed|revision/i)
  const confirmed = await repository.confirmReplicaWriterUpgrade(owner, intent, receipt)
  expect(confirmed.confirmed).toEqual(receipt)
  const updated = await upgrades().completeReplicaWriterUpgrade(owner, confirmed, selected.policyRevision)
  expect(updated).toMatchObject({ policyRevision: selected.policyRevision, minimumWriterVersion: 2, cursor: 17, lastUploaded: token })
  expect(await upgrades().readReplicaWriterUpgrade(owner, updated)).toBeUndefined()
})
