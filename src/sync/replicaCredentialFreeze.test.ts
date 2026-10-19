import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import type { BlindReplicaConfig } from "./blindReplication"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const local = await import("../localDb")
  const identity = await import("../domain/identity")
  const profile = await identity.bootstrapIdentity("owner")
  await local.writeLocal("tincanban.local_profile.v1", JSON.stringify(profile))
  const repository = await import("./privateReplicaRepository")
  const freeze = await import("./replicaCredentialFreeze")
  const key = (byte: number) => identity.toBase64Url(new Uint8Array(32).fill(byte))
  const config: BlindReplicaConfig = { purpose: "workspace", workspaceId: "board", scopeId: "scope", origin: "https://rusty.example",
    servicePublicKey: key(1), contentKey: key(2), readToken: key(3), writeToken: key(4), keyEpoch: 1, policyRevision: 1,
    cursor: 0, lastUploaded: "", minimumWriterVersion: 2 }
  await repository.setReplicaPreference(profile.identity.personId, config)
  const selected = (await repository.getReplicaConfigurations(profile.identity.personId))[0]!
  return { local, profile, repository, freeze, config: selected }
}

it("Given device revocation begins, When preparing a transition, Then durably freeze every scope on that pinned service and generate future credentials once", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  const first = await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  expect(first.resources).toHaveLength(1)
  expect(first.resources[0]!.next).toMatchObject({ keyEpoch: 2, historicalContentKeys: { "1": f.config.contentKey } })
  expect(first.resources[0]!.next.readToken).not.toBe(f.config.readToken)
  expect(first.resources[0]!.next.writeToken).not.toBe(f.config.writeToken)
  await expect(f.freeze.assertReplicaCredentialsUnfrozen(owner, f.config)).rejects.toThrow(/transition|frozen/i)
  expect(await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})).toEqual(first)
  await expect(f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "another-device", () => {})).rejects.toThrow(/pending|transition/i)
})

it("Given another service or person, When checking its writer, Then a scoped transition does not freeze unrelated data", async () => {
  const f = await fixture()
  await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  await expect(f.freeze.assertReplicaCredentialsUnfrozen("another-person", f.config)).resolves.toBeUndefined()
  await expect(f.freeze.assertReplicaCredentialsUnfrozen(f.profile.identity.personId, { ...f.config, origin: "https://other.example" })).resolves.toBeUndefined()
})

it("Given durable storage refuses the freeze, When preparing, Then leave original credentials and no apparent transition", async () => {
  const f = await fixture()
  vi.spyOn(f.local, "compareAndSwapLocal").mockResolvedValueOnce(false)
  await expect(f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})).rejects.toThrow(/changed|retry/i)
  await expect(f.freeze.assertReplicaCredentialsUnfrozen(f.profile.identity.personId, f.config)).resolves.toBeUndefined()
  expect((await f.repository.getReplicaConfigurations(f.profile.identity.personId))[0]).toEqual(f.config)
})

it("Given a profile change during preparation, When storage would commit, Then preserve old state and refuse the freeze", async () => {
  const f = await fixture()
  await f.local.writeLocal("tincanban.local_profile.v1", JSON.stringify({ ...f.profile, device: { ...f.profile.device, deviceId: "different-device" } }))
  await expect(f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})).rejects.toThrow(/identity|profile/i)
})

it("Given current-device removal, When preparing, Then require another authorized device rather than locking out the signer mid-transition", async () => {
  const f = await fixture()
  await expect(f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, f.profile.device.deviceId, () => {})).rejects.toThrow(/another|current/i)
})

it("Given frozen credentials, When ordinary progress is accessed or updated, Then refuse it while the retained original queue stays readable to exact maintenance", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  const original = await f.repository.getPrivateReplicaProgress(owner, f.config)
  const pending = await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  await expect(f.repository.getPrivateReplicaProgress(owner, f.config)).rejects.toThrow(/frozen/)
  await expect(f.repository.persistPrivateReplicaState(owner, f.config, original.generation,
    { ...original, generation: original.generation + 1 })).rejects.toThrow(/frozen/)
  expect(await f.repository.getPrivateReplicaProgress(owner, f.config, pending)).toEqual(original)
  await expect(f.repository.getPrivateReplicaProgress(owner, f.config, { ...pending, id: crypto.randomUUID() })).rejects.toThrow(/changed/)
})

it("Given an empty frozen queue, When draining for transition, Then perform no capture, inventory, upload or digest work", async () => {
  const f = await fixture()
  const pending = await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  const { drainFrozenReplica } = await import("./replicaCredentialDrain")
  const client = await import("./blindClient")
  const upload = vi.spyOn(client, "uploadBlindObject")
  const digest = vi.spyOn(crypto.subtle, "digest")
  await drainFrozenReplica(pending, f.config, async () => {})
  expect(upload).not.toHaveBeenCalled()
  expect(digest).not.toHaveBeenCalled()
})

it("Given pending ciphertext at freeze, When a transition loses upload confirmation, Then retain exact object, request and acknowledgment state for retry", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  const envelope = await import("@meta-uber/mesh-replication/rusty-replica")
  const object = await envelope.encryptBlindObject(f.config.scopeId, f.config.keyEpoch,
    envelope.decodeBlindBytes(f.config.contentKey), new Uint8Array([1, 2, 3]))
  const original = await f.repository.getPrivateReplicaProgress(owner, f.config)
  const saved = { ...original, cursor: 7, generation: original.generation + 1,
    pending: { hash: "A".repeat(43), requestId: "saved-request", observedSequence: 7, bytes: 3, object } }
  await f.repository.persistPrivateReplicaState(owner, f.config, original.generation, saved)
  const pending = await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  const { drainFrozenReplica } = await import("./replicaCredentialDrain")
  const client = await import("./blindClient")
  const upload = vi.spyOn(client, "uploadBlindObject").mockRejectedValue(new Error("Reply lost"))
  await expect(drainFrozenReplica(pending, f.config, async () => {})).rejects.toThrow("Reply lost")
  expect(upload).toHaveBeenCalledWith(f.config, object, "saved-request", 7)
  expect(await f.repository.getPrivateReplicaProgress(owner, f.config, pending)).toEqual(saved)
})

it("Given a frozen origin, When a peer changes its credentials or removes its scope, Then retain the freeze and original authoritative preferences", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  const preferences = await import("./privateReplicaPreferences")
  const wire = await f.repository.exportPrivateReplicaState(owner)
  const peer = { ...wire, actorId: "peer", progress: {} }
  const changed = preferences.portableReplicaState(preferences.changeReplicaPreference(peer, { ...f.config, readToken: "B".repeat(42) + "A" }))
  const removed = preferences.portableReplicaState(preferences.changeReplicaPreference(peer, f.config, true))
  await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  await expect(f.repository.receivePrivateReplicaState(owner, changed)).rejects.toThrow(/frozen/)
  await expect(f.repository.receivePrivateReplicaState(owner, removed)).rejects.toThrow(/frozen/)
  expect(await f.repository.exportPrivateReplicaState(owner)).toEqual(wire)
  // An exact no-op transfer does not hold up unrelated private identity data.
  await expect(f.repository.receivePrivateReplicaState(owner, wire)).resolves.toBe(false)
})

it("Given an import planned before freeze, When its transaction runs after freeze, Then its absent-freeze condition prevents publication", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  const preferences = await import("./privateReplicaPreferences")
  const wire = await f.repository.exportPrivateReplicaState(owner)
  const changed = preferences.portableReplicaState(preferences.changeReplicaPreference({ ...wire, actorId: "peer", progress: {} }, f.config, true))
  const plan = await f.repository.planPrivateReplicaImport(owner, changed)
  await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  expect(await f.local.compareAndSwapLocal(plan)).toBe(false)
  expect(await f.repository.exportPrivateReplicaState(owner)).toEqual(wire)
})

it("Given an obsolete writer changes retired storage during a freeze, When reading the current scope, Then ignore those bytes and retain the frozen authoritative source", async () => {
  const f = await fixture(), owner = f.profile.identity.personId
  const stateKey = f.repository.privateReplicaStateStorageKey(owner)
  await f.freeze.prepareReplicaCredentialFreeze(f.profile, f.config.origin, f.config.servicePublicKey, "removed-device", () => {})
  const before = await f.local.readLocal(stateKey)
  const legacyKey = `tincanban.device-replica-preferences.v1.${owner}`
  const legacy = JSON.stringify([{ origin: f.config.origin, scopeId: f.config.scopeId, changedAt: 1, config: null }])
  await f.local.writeLocal(legacyKey, legacy)
  expect(await f.repository.getPrivateReplicaConfigurations(owner)).toEqual([f.config])
  expect(await f.local.readLocal(legacyKey)).toBe(legacy)
  expect(await f.local.readLocal(stateKey)).toBe(before)
})
