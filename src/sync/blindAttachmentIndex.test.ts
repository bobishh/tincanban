import { expect, it, vi } from "vitest"
import { BlindReplica, type BlindReplicaConfig, type BlindReplicaStore } from "./blindReplication"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindReceipt } from "./blindClient"
import { decryptBlindObject, encryptBlindObject, decodeBlindBytes, encodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import type { AttachmentLocator } from "../product-replica"

const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
const serviceId = await blindHash(publicBytes)
function fixture() {
  const config: BlindReplicaConfig = { origin: "https://rusty.example", scopeId: "scope", servicePublicKey: encodeBlindBytes(publicBytes),
    readToken: "r".repeat(43), writeToken: "w".repeat(43), policyRevision: 1, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const uploaded: BlindObject[] = []
  const upload = async (_access: unknown, object: BlindObject, requestId: string): Promise<BlindReceipt> => {
    uploaded.push(object)
    const payload: BlindReceipt["payload"] = { kind: "blind-storage-receipt", version: 2, serviceId, scopeId: config.scopeId,
      keyEpoch: config.keyEpoch, objectId: await blindObjectId(object), sequence: uploaded.length, policyRevision: 1, requestId }
    return { payload, signerKeyId: serviceId, signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey,
      new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))) }
  }
  const merge = vi.fn(async () => {})
  const store = { read: async () => new Uint8Array([1]), authorization: async () => ({ signed: true }),
    merge, readChat: async () => null, mergeChat: async () => {}, persist: async () => {},
    readSnapshotRevision: async () => "unchanged-document" }
  const locator: AttachmentLocator = { version: 1, blobId: `sha256:${"B".repeat(43)}`, transferId: "transfer", manifestId: "A".repeat(43) }
  return { config, uploaded, upload, store, merge, locator }
}

it("Given unchanged document heads, when a confirmed attachment locator is added, then upload the encrypted index exactly once", async () => {
  const f = fixture()
  let attachments: AttachmentLocator[] = []
  const read = vi.fn(async () => structuredClone(attachments))
  const replica = new BlindReplica(f.config, { ...f.store, readAttachments: read,
    readAttachmentRevision: async () => attachments.length ? "attachment-generation-1" : undefined } as BlindReplicaStore,
  { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload: f.upload })
  await replica.push()
  attachments = [f.locator]
  await replica.push()
  await replica.push()
  expect(f.uploaded).toHaveLength(2)
  const plaintext = await decryptBlindObject(f.uploaded[1]!, f.config.scopeId, f.config.keyEpoch, decodeBlindBytes(f.config.contentKey))
  expect(JSON.parse(new TextDecoder().decode(plaintext)).attachments).toEqual([f.locator])
  expect(JSON.stringify(f.uploaded)).not.toContain(f.locator.blobId)
})

it("Given an encrypted snapshot with malformed attachment index, when pulled, then reject before document merge or cursor acknowledgment", async () => {
  const f = fixture()
  const object = await encryptBlindObject(f.config.scopeId, f.config.keyEpoch, decodeBlindBytes(f.config.contentKey),
    new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: "board", document: "AQ", authorization: { signed: true },
      chat: null, attachments: [{}] })))
  const id = await blindObjectId(object)
  const replica = new BlindReplica(f.config, f.store, {
    inventory: async () => ({ objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }),
    download: async () => object, upload: f.upload,
  })
  await expect(replica.pull()).rejects.toThrow(/attachment|locator/i)
  expect(f.merge).not.toHaveBeenCalled()
  expect(f.config.cursor).toBe(0)
})
