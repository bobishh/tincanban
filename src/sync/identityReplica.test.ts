import { expect, it, vi } from "vitest"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { createIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { createIdentityReplicaRecord, type readIdentityReplicaRecord } from "./identityReplicaProtocol"
import { encodeBlindBytes, encryptPurposeBoundObject, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
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
      if (!stored) { stored = { objectId: id, sequence: objects.length + 1, object: structuredClone(object) }; objects.push(stored) }
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
