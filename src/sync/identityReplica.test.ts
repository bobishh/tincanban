import { expect, it, vi } from "vitest"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { createAuthorizedIdentityDeviceTransferFixture as createIdentityDeviceTransfer } from "./identityAuthority.testSupport"
import { createIdentityReplicaRecord, type readIdentityReplicaRecord } from "./identityReplicaProtocol"
import { decodeBlindBytes, encodeBlindBytes, encryptPurposeBoundObject, RustyResponseError, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindReceipt } from "./blindClient"
import { IdentityReplica } from "./identityReplica"
import type { IdentityReplicaConfig } from "./blindReplication"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  root.photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-10-14T12:00:00.000Z" }
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  const config: IdentityReplicaConfig = { purpose: "identity", personId: profile.identity.personId, origin: "https://rusty.example",
    scopeId: "private-identity", servicePublicKey: encodeBlindBytes(pub), readToken: "A".repeat(43), writeToken: "B".repeat(42) + "A",
    contentKey: "A".repeat(43), keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" }
  const context = await resolveSigningContext({ profile, certificates: [profile.certificate], purpose: "identity-replica-state",
    binding: { personId: config.personId, scopeId: config.scopeId, keyEpoch: 1 }, authorityRevision: "1",
    current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "1" }) })
  const record = await createIdentityReplicaRecord(context, config, await createIdentityDeviceTransfer(root, [profile.certificate]), 1)
  const objects: { objectId: string; sequence: number; object: BlindObject }[] = []
  const attempts: { object: BlindObject; requestId: string }[] = []
  let failReply = false
  const transport = {
    inventory: async (_access: unknown, after: number) => ({ objects: objects.filter(value => value.sequence > after)
      .map(({ objectId, sequence }) => ({ objectId, sequence })), cursor: objects.at(-1)?.sequence ?? after, hasMore: false }),
    download: async (_access: unknown, id: string) => structuredClone(objects.find(value => value.objectId === id)!.object),
    upload: async (_access: unknown, object: BlindObject, requestId: string): Promise<BlindReceipt> => {
      attempts.push({ object: structuredClone(object), requestId })
      const id = await blindObjectId(object)
      let stored = objects.find(value => value.objectId === id)
      if (!stored) { stored = { objectId: id, sequence: Math.max(0, ...objects.map(value => value.sequence)) + 1, object: structuredClone(object) }; objects.push(stored) }
      if (failReply) { failReply = false; throw new Error("reply lost") }
      const serviceId = await blindHash(pub)
      return signEnvelope(keys.privateKey, { kind: "blind-storage-receipt", version: 2, serviceId, scopeId: config.scopeId,
        keyEpoch: 1, objectId: id, sequence: stored.sequence, policyRevision: 1, requestId } satisfies BlindReceipt["payload"], serviceId, "RUSTY/2")
    },
  }
  function store(binding: string) {
    let progress = emptyReplicaState<BlindObject>(binding)
    const capture = vi.fn(async () => structuredClone(record))
    const merge = vi.fn(async (transfer: Awaited<ReturnType<typeof readIdentityReplicaRecord>>["transfer"]) => { void transfer })
    return { capture, merge, revision: async () => "local-1", guard: async () => {}, authorize: async () => {},
      repository: { read: async () => structuredClone(progress), commit: async (expected: number, next: ReplicaState<BlindObject>) => {
        expect(progress.generation).toBe(expected); progress = structuredClone(next)
      } }, progress: () => structuredClone(progress) }
  }
  return { config, record, root, objects, attempts, transport, store, loseReply: () => { failReply = true } }
}

it("Given an identity catalog compacted after inventory with a durable local outbox, when the next pull follows its failed old download, then admit the replacement without changing the original outbox", async () => {
  const f = await fixture(), store = f.store("phone")
  f.loseReply()
  await expect(new IdentityReplica(f.config, "phone", store, f.transport).push()).rejects.toThrow("reply lost")
  const original = store.progress()
  const replacement = await encryptPurposeBoundObject({ purpose: "identity-state", subjectId: f.config.personId,
    scopeId: f.config.scopeId, keyEpoch: 1 }, decodeBlindBytes(f.config.contentKey),
  new TextEncoder().encode(canonicalBlindJson(f.record)))
  const inventory = vi.fn(async (access: unknown, after: number) => {
    const result = await f.transport.inventory(access, after)
    if (inventory.mock.calls.length === 1) f.objects.splice(0, f.objects.length,
      { objectId: await blindObjectId(replacement), sequence: 7, object: replacement })
    return result
  })
  const download = vi.fn(async (access: unknown, id: string) => {
    if (!f.objects.some(value => value.objectId === id)) throw new RustyResponseError("Object unavailable", { status: 403 })
    return f.transport.download(access, id)
  })
  const replica = new IdentityReplica(f.config, "phone", store, { ...f.transport, inventory, download })
  await expect(replica.pull()).rejects.toThrow("Object unavailable")
  expect(store.progress()).toEqual(original)
  expect(store.merge).not.toHaveBeenCalled()
  await expect(replica.pull()).resolves.toBe(true)
  expect(store.progress()).toMatchObject({ cursor: 7, pending: original.pending, lastUploaded: original.lastUploaded })
  expect(store.merge).toHaveBeenCalledOnce()
  expect(store.merge.mock.calls[0]![0].personalRoot.photo).toEqual(f.root.photo)
  expect(inventory.mock.calls.map(call => call[1])).toEqual([0, 0])
  expect(f.attempts).toHaveLength(1)
})

it("Given identity recovery at an old storage cursor, when a checkpoint rejects the fresh upload, then automatically admit it and confirm a fresh upload with the observed sequence", async () => {
  const f = await fixture(), source = f.store("source")
  await new IdentityReplica(f.config, "source", source, f.transport).push()
  f.objects[0]!.sequence = 7
  const target = f.store("target")
  const upload = vi.fn(async (access: Parameters<typeof f.transport.upload>[0], object: BlindObject, requestId: string, observedSequence = 0) => {
    if (observedSequence < 7) throw Object.assign(new Error("checkpoint generation required; refresh storage inventory before uploading new objects"),
      { code: "checkpoint_generation_required", status: 409 })
    return f.transport.upload(access, object, requestId)
  })
  await expect(new IdentityReplica(f.config, "target", target, { ...f.transport, upload }).push()).resolves.toBe(true)
  expect(upload.mock.calls.map(call => call[3])).toEqual([0, 7])
  expect(target.merge).toHaveBeenCalledOnce()
  expect(target.progress()).toMatchObject({ cursor: 7, lastUploaded: expect.any(String) })
  expect(target.progress().pending).toBeUndefined()
})

it("Given Rusty retained an encrypted identity package, when its source closes, then another replica receives it without contacting the source", async () => {
  const f = await fixture()
  const sender = f.store("sender")
  await new IdentityReplica(f.config, "sender", sender, f.transport).push()
  sender.capture.mockRejectedValue(new Error("source closed"))
  const receiver = f.store("receiver")
  expect(await new IdentityReplica(f.config, "receiver", receiver, f.transport).pull()).toBe(true)
  expect(receiver.merge.mock.calls[0][0].personalRoot.photo).toEqual(f.root.photo)
  expect(sender.capture).toHaveBeenCalledTimes(1)
  expect(receiver.progress().cursor).toBe(1)
  expect(JSON.stringify(f.objects)).not.toContain("avatarData")
})

it.each([0, 8])("Given eight Identity snapshots including one corrupt object and saved cursor %i, when maintenance cannot admit every state, then preserve every stored object without preparing a checkpoint", async cursor => {
  const f = await fixture()
  for (let index = 0; index < 8; index++) {
    const object = await encryptPurposeBoundObject({ purpose: "identity-state", subjectId: f.config.personId,
      scopeId: f.config.scopeId, keyEpoch: 1 }, decodeBlindBytes(f.config.contentKey),
    new TextEncoder().encode(canonicalBlindJson(f.record)))
    if (index === 7) object.ciphertext = encodeBlindBytes(new Uint8Array(32))
    f.objects.push({ objectId: await blindObjectId(object), sequence: index + 1, object })
  }
  const prepareCheckpoint = vi.fn(async () => { throw new Error("Unsafe checkpoint") })
  const checkpoint = vi.fn(async () => { throw new Error("Unsafe replacement") })
  const store = f.store("reader")
  await store.repository.commit(0, { ...store.progress(), generation: 1, cursor })
  const transport = { ...f.transport, checkpoint, inventory: async (access: unknown, after: number) => ({
    ...await f.transport.inventory(access, after), objectCount: f.objects.length, maxSequence: 8,
  }) }
  await expect(new IdentityReplica(f.config, "reader", { ...store, prepareCheckpoint }, transport).sync()).rejects.toThrow()
  expect(prepareCheckpoint).not.toHaveBeenCalled()
  expect(checkpoint).not.toHaveBeenCalled()
  expect(f.objects).toHaveLength(8)
})

it("Given a cold identity replica retains the epoch-one key, when it reads the epoch-one signed package under active epoch two, then admit without source capture", async () => {
  const f = await fixture()
  const sender = f.store("sender")
  await new IdentityReplica(f.config, "sender", sender, f.transport).push()
  sender.capture.mockRejectedValue(new Error("source closed"))
  const receiver = f.store("receiver")
  const activeConfig = { ...f.config, keyEpoch: 2, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
    historicalContentKeys: { "1": f.config.contentKey } } as IdentityReplicaConfig

  expect(await new IdentityReplica(activeConfig, "receiver", receiver, f.transport).pull()).toBe(true)
  expect(receiver.merge).toHaveBeenCalledOnce()
  expect(receiver.capture).not.toHaveBeenCalled()
  expect(receiver.progress().cursor).toBe(1)
  expect(sender.capture).toHaveBeenCalledTimes(1)
})

it.each(["missing-history", "future-epoch", "wrong-history-key"] as const)(
  "Given an identity reader has %s, when the old or unknown-epoch package arrives, then reject before merge or cursor acknowledgement", async scenario => {
    const f = await fixture()
    const sender = f.store("sender")
    await new IdentityReplica(f.config, "sender", sender, f.transport).push()
    const receiver = f.store("receiver")
    const activeConfig = { ...f.config, keyEpoch: 2, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
      ...(scenario === "missing-history" ? {} : { historicalContentKeys: {
        "1": encodeBlindBytes(scenario === "wrong-history-key" ? crypto.getRandomValues(new Uint8Array(32))
          : new Uint8Array(32).fill(1)),
      } }) } as IdentityReplicaConfig
    if (scenario === "future-epoch") {
      const futureKey = crypto.getRandomValues(new Uint8Array(32))
      const futureObject = await encryptPurposeBoundObject({ purpose: "identity-state", subjectId: f.config.personId,
        scopeId: f.config.scopeId, keyEpoch: 3 }, futureKey, new TextEncoder().encode(canonicalBlindJson(f.record)))
      const id = await blindObjectId(futureObject)
      f.objects.splice(0, f.objects.length, { objectId: id, sequence: 1, object: futureObject })
    }
    const replica = new IdentityReplica(activeConfig, "receiver", receiver, f.transport)

    const outcome = replica.pull()
    if (scenario === "wrong-history-key") await expect(outcome).rejects.toThrow()
    else await expect(outcome).rejects.toThrow(/update required/i)
    expect(receiver.merge).not.toHaveBeenCalled()
    expect(receiver.capture).not.toHaveBeenCalled()
    expect(receiver.progress().cursor).toBe(0)
  }
)

it("Given an upload reply is lost, when separate identity clients retry concurrently, then acknowledge the exact saved ciphertext once before reading current content", async () => {
  const f = await fixture()
  const store = { ...f.store("sender"), runExclusive: <T>(operation: () => Promise<T>) =>
    withPrivateReplicaOperation(f.config.personId, f.config, operation) }
  f.loseReply()
  await expect(new IdentityReplica(f.config, "sender", store, f.transport).push()).rejects.toThrow("reply lost")
  expect(store.progress().pending).toBeDefined()
  store.capture.mockRejectedValue(new Error("must reuse outbox"))
  const reopened = new IdentityReplica(f.config, "sender", store, f.transport)
  await Promise.all([reopened.push(), new IdentityReplica(f.config, "sender", store, f.transport).push()])
  expect(f.attempts[1]).toEqual(f.attempts[0])
  expect(store.progress().pending).toBeUndefined()
  await reopened.push()
  expect(store.capture).toHaveBeenCalledTimes(1)
  expect(f.attempts).toHaveLength(2)
})
