import { expect, test } from "vitest"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { encryptBlindObject, encodeBlindBytes } from "./blindEnvelope"
import { type BlindReceipt, blindObjectId } from "./blindClient"

test("Given a durable remote snapshot, when a fresh client admits it unchanged, then it does not upload another encrypted copy", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([1])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(snapshot)))
  const id = await blindObjectId(object)
  let bytes = new Uint8Array([1])
  let uploads = 0
  const replica = new BlindReplica(config, {
    read: async () => bytes, authorization: async () => snapshot.authorization, readChat: async () => null,
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async () => ({ objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }),
    download: async () => object, upload: async () => { uploads++; return {} as BlindReceipt } })
  await replica.sync()
  expect(uploads).toBe(0)
  expect(config.lastUploaded).not.toBe("")
  bytes = new Uint8Array([2])
  await replica.push()
  expect(uploads).toBe(1)
  await replica.push()
  expect(uploads).toBe(1)
})

test("Given unchanged document heads, when binary encoding differs, diagnostics distinguish encoding churn from chat or authority changes", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  let bytes = new Uint8Array([1]); let chat: unknown = null
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const replica = new BlindReplica(config, {
    read: async () => bytes, authorization: async () => ({ signed: true }), readChat: async () => chat,
    documentRevision: async () => "same-logical-heads", diagnostic: (event, detail) => events.push({ event, detail }),
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async () => ({ objects: [], cursor: 0, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload: async () => ({} as BlindReceipt) })
  await replica.push(); bytes = new Uint8Array([2]); await replica.push()
  expect(events.filter(value => value.event.endsWith("completed")).at(-1)?.detail.changedFields).toEqual(["encoding"])
  chat = { message: "private chat content" }; await replica.push()
  expect(events.filter(value => value.event.endsWith("completed")).at(-1)?.detail.changedFields).toEqual(["chat"])
  expect(JSON.stringify(events)).not.toContain("private chat content")
  expect(JSON.stringify(events)).not.toContain(config.contentKey)
})

test("Given encrypted signed history, when admission fails, replication never advances its durable cursor", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const payload = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([1, 2, 3])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(payload)))
  const id = await blindObjectId(object)
  let persisted = 0
  let admitted = false
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1, 2, 3]), authorization: async () => payload.authorization,
    readChat: async () => null, mergeChat: async () => {},
    merge: async (_id, bytes, proof) => { expect([...bytes]).toEqual([1, 2, 3]); expect(proof).toEqual(payload.authorization); if (!admitted) throw new Error("Unsigned change rejected") },
    persist: async () => { persisted++ },
  }, { inventory: async () => ({ objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }), download: async () => object, upload: async () => { throw new Error("Unexpected upload") } })
  await expect(replica.pull()).rejects.toThrow("Unsigned change rejected")
  expect(config.cursor).toBe(0)
  expect(persisted).toBe(0)
  admitted = true
  await replica.pull()
  expect(config.cursor).toBe(1)
  expect(persisted).toBe(1)
})

test("Given an uncertain durable receipt, when uploading retries, the same immutable ciphertext is reused", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const uploaded: string[] = []
  let attempts = 0
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1, 2, 3]), authorization: async () => ({ signed: true }),
    readChat: async () => null, mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async () => ({ objects: [], cursor: 0, hasMore: false }), download: async () => { throw new Error("Unexpected download") },
    upload: async (_access, object) => { uploaded.push(await blindObjectId(object)); if (++attempts === 1) throw new Error("Response lost after durable save"); return {} as BlindReceipt } })
  await expect(replica.push()).rejects.toThrow("Response lost")
  expect(config.lastUploaded).toBe("")
  await replica.push()
  expect(config.lastUploaded).not.toBe("")
  expect(uploaded[0]).toBe(uploaded[1])
  await replica.push()
  expect(uploaded).toHaveLength(2)
})


test("Given an inventory exceeding one bounded pass, when syncing, then completion is not reported until backlog drains", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([1])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(snapshot)))
  const id = await blindObjectId(object)
  let calls = 0
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1]), authorization: async () => snapshot.authorization,
    readChat: async () => null, mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async () => { calls++; return { objects: [{ objectId: id, sequence: calls }], cursor: calls, hasMore: calls < 9 } },
    download: async () => object, upload: async () => ({} as BlindReceipt) })
  expect(await replica.sync()).toBe(false)
  expect(config.cursor).toBe(8)
  expect(await replica.sync()).toBe(true)
  expect(config.cursor).toBe(9)
})
