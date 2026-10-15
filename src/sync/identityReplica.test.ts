import { expect, it, vi } from "vitest"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { createIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { createIdentityReplicaRecord, type readIdentityReplicaRecord } from "./identityReplicaProtocol"
import { encodeBlindBytes, type BlindObject } from "./blindEnvelope"
import { blindHash, blindObjectId, type BlindReceipt } from "./blindClient"
import { IdentityReplica } from "./identityReplica"
import type { IdentityReplicaConfig } from "./blindReplication"

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

it("Given an upload reply is lost, when the replica reopens, then retry exact persisted ciphertext before reading current content", async () => {
  const f = await fixture()
  const store = f.store("sender")
  f.loseReply()
  await expect(new IdentityReplica(f.config, "sender", store, f.transport).push()).rejects.toThrow("reply lost")
  expect(store.progress().pending).toBeDefined()
  store.capture.mockRejectedValue(new Error("must reuse outbox"))
  const reopened = new IdentityReplica(f.config, "sender", store, f.transport)
  await reopened.push()
  expect(f.attempts[1]).toEqual(f.attempts[0])
  expect(store.progress().pending).toBeUndefined()
  await reopened.push()
  expect(store.capture).toHaveBeenCalledTimes(1)
  expect(f.attempts).toHaveLength(2)
})
