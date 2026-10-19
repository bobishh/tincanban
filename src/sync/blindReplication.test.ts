import type { BlindCheckpointRequest, BlindCheckpointReceipt } from "./blindCheckpoint"
import { expect, test, vi } from "vitest"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { encryptBlindObject, encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash, canonicalBlindJson, type BlindAccess, type BlindReceipt, blindObjectId } from "./blindClient"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"

const signer = await createReceiptSigner()
let receiptSequence = 0
const receiptCache = new Map<string, BlindReceipt>()

async function checkpointRefreshFixture() {
  const oldKey = crypto.getRandomValues(new Uint8Array(32)), nextKey = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "https://rusty.example", scopeId: "checkpoint-refresh", workspaceId: "board",
    servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 2, keyEpoch: 2,
    contentKey: encodeBlindBytes(nextKey), historicalContentKeys: { "1": encodeBlindBytes(oldKey) }, cursor: 0, lastUploaded: "" }
  let progress = emptyReplicaState<BlindObject>("checkpoint-browser"), revision = "local", document = new Uint8Array([1])
  const checkpoint = await encryptBlindObject(config.scopeId, 1, oldKey, new TextEncoder().encode(JSON.stringify({
    version: 1, workspaceId: config.workspaceId, document: encodeBlindBytes(new Uint8Array([7])), authorization: { signed: true }, chat: null,
  })))
  const inventory = vi.fn(async (_access: BlindAccess, after: number) => after < 7
    ? { objects: [{ objectId: await blindObjectId(checkpoint), sequence: 7 }], cursor: 7, hasMore: false }
    : { objects: [], cursor: after, hasMore: false })
  const upload = vi.fn(async (access: BlindAccess, object: BlindObject, requestId: string, observedSequence = 0) => {
    if (upload.mock.calls.length === 1) throw new Error("Original reply lost")
    if (observedSequence < 7) throw Object.assign(new Error("checkpoint generation required; refresh storage inventory before uploading new objects"),
      { code: "checkpoint_generation_required", status: 409 })
    receiptSequence = Math.max(receiptSequence, 7)
    return signedReceipt(access, object, requestId)
  })
  const commits: ReplicaState<BlindObject>[] = []
  const store = {
    replicaBinding: "checkpoint-browser", read: async () => document, readSnapshotRevision: async () => revision,
    authorization: async () => ({ signed: true }), readChat: async () => null, mergeChat: async () => {},
    merge: vi.fn(async (_id: string, remote: Uint8Array) => { document = new Uint8Array([...document, ...remote]); revision = "merged" }),
    persist: async () => {}, readReplicaProgress: async () => structuredClone(progress),
    ensureCurrent: vi.fn(async () => {}),
    persistReplicaProgress: async (expected: number, next: ReplicaState<BlindObject>) => {
      expect(progress.generation).toBe(expected); progress = structuredClone(next); commits.push(structuredClone(next))
    },
  }
  const open = () => new BlindReplica({ ...config }, store, { inventory, download: async () => checkpoint, upload })
  return { open, inventory, upload, store, commits, progress: () => structuredClone(progress) }
}

test("Given a reopened outbox rejected by a newer checkpoint, when recovery flushes its snapshot, then admit the checkpoint before retiring that exact request and confirm a merged fresh-key upload", async () => {
  const f = await checkpointRefreshFixture()
  await expect(f.open().push()).rejects.toThrow("Original reply lost")
  const pending = f.progress().pending!
  await f.open().flushCurrentSnapshot()
  expect(f.upload.mock.calls.map(call => call[3])).toEqual([0, 0, 7])
  expect(f.upload.mock.calls[1]).toEqual(f.upload.mock.calls[0])
  expect(f.upload.mock.calls[2]![2]).not.toBe(pending.requestId)
  expect(f.upload.mock.calls[2]![1].keyEpoch).toBe(2)
  expect(f.store.merge).toHaveBeenCalledOnce()
  expect(f.progress()).toMatchObject({ cursor: 7, lastUploaded: expect.any(String) })
  expect(f.progress().lastUploaded).not.toBe("")
  expect(f.progress().pending).toBeUndefined()
  expect(f.commits.find(value => value.cursor === 7 && value.pending)?.pending).toEqual(pending)
})

test("Given a rejected request and unavailable checkpoint inventory, when recovery refreshes, then preserve the original ciphertext, request identity and acknowledgment", async () => {
  const f = await checkpointRefreshFixture()
  await expect(f.open().push()).rejects.toThrow("Original reply lost")
  const before = f.progress()
  f.inventory.mockRejectedValueOnce(new Error("Inventory unavailable"))
  await expect(f.open().flushCurrentSnapshot()).rejects.toThrow("Inventory unavailable")
  expect(f.progress()).toEqual(before)
  expect(f.upload).toHaveBeenCalledTimes(2)
  expect(f.store.merge).not.toHaveBeenCalled()
})

test("Given a stale outbox and a newer admitted checkpoint, when ordinary polling runs, then recover without a separate user action", async () => {
  const f = await checkpointRefreshFixture()
  await expect(f.open().push()).rejects.toThrow("Original reply lost")
  expect(await f.open().sync()).toBe(true)
  expect(f.progress().pending).toBeUndefined()
  expect(f.progress().cursor).toBe(7)
  expect(f.upload.mock.calls.map(call => call[3])).toEqual([0, 0, 7])
})

test("Given a rejected request but denied checkpoint admission, when refreshing, then preserve its exact ciphertext and never prepare another upload", async () => {
  const f = await checkpointRefreshFixture()
  await expect(f.open().push()).rejects.toThrow("Original reply lost")
  const before = f.progress()
  f.store.merge.mockRejectedValueOnce(new Error("Current authority denied checkpoint"))
  await expect(f.open().flushCurrentSnapshot()).rejects.toThrow("Current authority denied checkpoint")
  expect(f.progress()).toEqual(before)
  expect(f.upload).toHaveBeenCalledTimes(2)
})

test("Given admitted checkpoint history but refused outbox CAS, when refreshing, then retain the rejected request and resume it safely in a fresh instance", async () => {
  const f = await checkpointRefreshFixture()
  await expect(f.open().push()).rejects.toThrow("Original reply lost")
  const pending = f.progress().pending!
  const commit = f.store.persistReplicaProgress
  f.store.persistReplicaProgress = async (expected, next) => {
    if (!next.pending) throw new Error("Outbox CAS refused")
    return commit(expected, next)
  }
  await expect(f.open().flushCurrentSnapshot()).rejects.toThrow("Outbox CAS refused")
  expect(f.progress()).toMatchObject({ cursor: 7, pending })
  f.store.persistReplicaProgress = commit
  await f.open().flushCurrentSnapshot()
  expect(f.progress().pending).toBeUndefined()
  expect(f.upload.mock.calls.at(-1)![3]).toBe(7)
})

test.each([{ code: "checkpoint_generation_required", status: 503 }, { code: "checkpoint_conflict", status: 409 }])(
  "Given a different storage error %j, when delivery fails, then never retire the original request or refresh its evidence", async failure => {
    const f = await checkpointRefreshFixture()
    await expect(f.open().push()).rejects.toThrow("Original reply lost")
    const before = f.progress()
    f.upload.mockRejectedValueOnce(Object.assign(new Error("Different failure"), failure))
    await expect(f.open().flushCurrentSnapshot()).rejects.toThrow("Different failure")
    expect(f.progress()).toEqual(before)
    expect(f.inventory).not.toHaveBeenCalled()
  }
)

test("Given a first WASM snapshot failure, when replication catches it, then retain the original exception and exact phase before reporting UI failure", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey,
    readToken: "private-read", writeToken: "private-write", policyRevision: 1, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const failure = new WebAssembly.RuntimeError("unreachable during snapshot capture")
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const replica = new BlindReplica(config, { read: async () => { throw failure }, authorization: async () => ({}),
    readChat: async () => null, mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
    diagnostic: (event, detail) => events.push({ event, detail }) },
  { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload: signedReceipt })
  await expect(replica.push()).rejects.toBe(failure)
  expect(events).toContainEqual({ event: "mesh.rusty.snapshot.failed", detail: expect.objectContaining({ workspaceId: "board", phase: "snapshot", error: failure }) })
  expect(JSON.stringify(events)).not.toMatch(/private-read|private-write|contentKey/)
})

test("Given an older uncertain snapshot, when attachment discovery is flushed, then finish its exact retry and acknowledge the new index before returning", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey,
    readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  let attachmentRevision = "before", first = true
  const upload = vi.fn(async (access: BlindAccess, object: BlindObject, requestId: string) => {
    if (first) { first = false; throw new Error("Confirmation lost") }
    return signedReceipt(access, object, requestId)
  })
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1]), authorization: async () => ({ signed: true }),
    readSnapshotRevision: async () => "document", readAttachmentRevision: async () => attachmentRevision,
    readAttachments: async () => attachmentRevision === "before" ? [] : [{ version: 1, blobId: `sha256:${"A".repeat(43)}`,
      manifestId: "B".repeat(43), transferId: "prepared-file" }],
    readChat: async () => null, mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }),
    download: async () => { throw new Error("Unexpected download") }, upload })
  await expect(replica.push()).rejects.toThrow("Confirmation lost")
  attachmentRevision = "with-file-locator"
  await replica.flushCurrentSnapshot()
  expect(upload).toHaveBeenCalledTimes(3)
  expect(upload.mock.calls[0]!.at(3)).toBe(0)
  expect(upload.mock.calls[1]).toEqual(upload.mock.calls[0])
  expect(upload.mock.calls[2]![2]).not.toBe(upload.mock.calls[0]![2])
  await replica.push()
  expect(upload).toHaveBeenCalledTimes(3)
})

async function createReceiptSigner() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return { pair, publicKey: encodeBlindBytes(publicKey), serviceId: await blindHash(publicKey) }
}

async function signedReceipt(access: BlindAccess, object: BlindObject, requestId: string): Promise<BlindReceipt> {
  if (access.servicePublicKey !== signer.publicKey) throw new Error("Receipt signer must match the pinned service key")
  const cached = receiptCache.get(requestId)
  if (cached) return cached
  const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId: signer.serviceId,
    scopeId: access.scopeId, keyEpoch: object.keyEpoch, objectId: await blindObjectId(object),
    sequence: ++receiptSequence, policyRevision: access.policyRevision, requestId }
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.pair.privateKey,
    new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))
  const receipt = { payload, signerKeyId: signer.serviceId, signature: encodeBlindBytes(signature) }
  receiptCache.set(requestId, receipt)
  return receipt
}

test("Given a durably uploaded snapshot and unchanged document, proof, authority and chat revision, When polling repeats, Then no document read, proof export or historical hash runs", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  let revision = "document-proof-authority-chat-1", value = 1
  const read = vi.fn(async () => new Uint8Array([value]))
  const authorization = vi.fn(async () => ({ signed: value }))
  const digest = vi.spyOn(crypto.subtle, "digest")
  const upload = vi.fn(async (access: BlindAccess, object: BlindObject, requestId: string) => signedReceipt(access, object, requestId))
  const replica = new BlindReplica(config, {
    read, authorization, readSnapshotRevision: async () => revision, readChat: async () => null,
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload })
  try {
    await replica.push()
    read.mockClear(); authorization.mockClear(); digest.mockClear()
    for (let index = 0; index < 4; index++) await replica.push()
    expect(read).not.toHaveBeenCalled()
    expect(authorization).not.toHaveBeenCalled()
    expect(digest).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledTimes(1)
    revision = "document-proof-authority-chat-2"; value = 2
    await replica.push()
    expect(read).toHaveBeenCalledOnce()
    expect(authorization).toHaveBeenCalledOnce()
    expect(upload).toHaveBeenCalledTimes(2)
  } finally { digest.mockRestore() }
})

test("Given an already stored snapshot, when a periodic pass has no changes, diagnostics connect board and storage scope without another upload", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  let uploads = 0
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1]), authorization: async () => ({ signed: true }), readChat: async () => null,
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
    diagnostic: (event, detail) => events.push({ event, detail }),
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload: async (access, object, requestId) => { uploads++; return signedReceipt(access, object, requestId) } })
  await replica.push()
  await replica.push()
  expect(uploads).toBe(1)
  expect(events.at(-1)).toMatchObject({ event: "mesh.rusty.upload.skipped", detail: { phase: "unchanged", workspaceId: "board", entityType: "scope", entityId: "opaque" } })
  expect(JSON.stringify(events)).not.toContain(config.contentKey)
})

test.each(["during-read", "failed-save", "missing-revision", "failed-revision"])("Given %s, When a later poll runs, Then an unstable or unacknowledged revision cannot skip the snapshot", async scenario => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  let revision = "one", first = true
  const read = vi.fn(async () => {
    if (scenario === "during-read" && first) revision = "two"
    return new Uint8Array([revision === "one" ? 1 : 2])
  })
  const replica = new BlindReplica(config, {
    read, authorization: async () => ({ signed: true }), readChat: async () => null,
    readSnapshotRevision: async () => {
      if (scenario === "failed-revision") throw new Error("Revision unavailable")
      return scenario === "missing-revision" ? undefined : revision
    },
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {
      if (scenario === "failed-save" && first) throw new Error("Acknowledgement save failed")
    },
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload: async (access, object, requestId) => signedReceipt(access, object, requestId) })
  if (scenario === "failed-save") await expect(replica.push()).rejects.toThrow("Acknowledgement save failed")
  else await replica.push()
  first = false
  await replica.push()
  expect(read).toHaveBeenCalledTimes(2)
})

test("Given a durable remote snapshot, when a fresh client admits it unchanged, then it does not upload another encrypted copy", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([1])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(snapshot)))
  const id = await blindObjectId(object)
  let bytes = new Uint8Array([1])
  let uploads = 0
  const replica = new BlindReplica(config, {
    read: async () => bytes, authorization: async () => snapshot.authorization, readChat: async () => null,
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async (_access, cursor) => cursor < 1
      ? { objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }
      : { objects: [], cursor, hasMore: false },
    download: async () => object, upload: async (access, encrypted, requestId) => { uploads++; return signedReceipt(access, encrypted, requestId) } })
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
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  let bytes = new Uint8Array([1]); let chat: unknown = null
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  let uploads = 0
  const replica = new BlindReplica(config, {
    read: async () => bytes, authorization: async () => ({ signed: true }), readChat: async () => chat,
    documentRevision: async () => "same-logical-heads", diagnostic: (event, detail) => events.push({ event, detail }),
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") }, upload: async (access, object, requestId) => { uploads++; return signedReceipt(access, object, requestId) } })
  await replica.push(); bytes = new Uint8Array([2]); await replica.push()
  expect(uploads).toBe(1)
  expect(events.at(-1)?.detail.phase).toBe("encoding_unchanged_state")
  chat = { message: "private chat content" }; await replica.push()
  expect(events.filter(value => value.event.endsWith("completed")).at(-1)?.detail.changedFields).toEqual(["chat"])
  expect(JSON.stringify(events)).not.toContain("private chat content")
  expect(JSON.stringify(events)).not.toContain(config.contentKey)
})

test("Given encrypted signed history, when admission fails, replication never advances its durable cursor", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
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
  }, { inventory: async (_access, cursor) => cursor < 1
      ? { objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }
      : { objects: [], cursor, hasMore: false }, download: async () => object, upload: async () => { throw new Error("Unexpected upload") } })
  await expect(replica.pull()).rejects.toThrow("Unsigned change rejected")
  expect(config.cursor).toBe(0)
  expect(persisted).toBe(0)
  admitted = true
  await replica.pull()
  expect(config.cursor).toBe(1)
  expect(persisted).toBe(1)
})

test("Given a cold reader has the previous epoch key, when admitting an epoch-one snapshot under active epoch two, then merge before acknowledging it", async () => {
  const oldKey = crypto.getRandomValues(new Uint8Array(32))
  const activeKey = crypto.getRandomValues(new Uint8Array(32))
  const base: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey,
    readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 2, contentKey: encodeBlindBytes(activeKey),
    workspaceId: "board", cursor: 0, lastUploaded: "" }
  const config = { ...base, historicalContentKeys: { "1": encodeBlindBytes(oldKey) } } as BlindReplicaConfig
  const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([4, 5])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, oldKey, new TextEncoder().encode(JSON.stringify(snapshot)))
  const id = await blindObjectId(object)
  const merge = vi.fn(async () => {})
  const persist = vi.fn(async () => {})
  const replica = new BlindReplica(config, { read: async () => new Uint8Array([1]), authorization: async () => ({}),
    readChat: async () => null, mergeChat: async () => {}, merge, persist }, {
    inventory: async (_access, cursor) => cursor < 1 ? { objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }
      : { objects: [], cursor, hasMore: false }, download: async () => object,
    upload: async () => { throw new Error("Unexpected upload") },
  })

  expect(await replica.pull()).toBe(true)
  expect(merge).toHaveBeenCalledOnce()
  expect(merge).toHaveBeenCalledWith("board", new Uint8Array([4, 5]), snapshot.authorization)
  expect(config.cursor).toBe(1)
  expect(persist).toHaveBeenCalledOnce()
})

test.each(["missing-history", "future-epoch", "wrong-history-key"] as const)(
  "Given a cold reader has %s, when an old or unknown-epoch snapshot arrives, then reject before merge or cursor acknowledgement", async scenario => {
    const oldKey = crypto.getRandomValues(new Uint8Array(32))
    const activeKey = crypto.getRandomValues(new Uint8Array(32))
    const replacementKey = crypto.getRandomValues(new Uint8Array(32))
    const base: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey,
      readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 2, contentKey: encodeBlindBytes(activeKey),
      workspaceId: "board", cursor: 0, lastUploaded: "" }
    const config = { ...base, ...(scenario === "missing-history" ? {} : { historicalContentKeys: {
      "1": encodeBlindBytes(scenario === "wrong-history-key" ? replacementKey : oldKey),
    } }) } as BlindReplicaConfig
    const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([4, 5])), authorization: { signed: true }, chat: null }
    const objectEpoch = scenario === "future-epoch" ? 3 : 1
    const objectKey = scenario === "future-epoch" ? crypto.getRandomValues(new Uint8Array(32)) : oldKey
    const object = await encryptBlindObject(config.scopeId, objectEpoch, objectKey, new TextEncoder().encode(JSON.stringify(snapshot)))
    const id = await blindObjectId(object)
    const merge = vi.fn(async () => {})
    const persist = vi.fn(async () => {})
    const replica = new BlindReplica(config, { read: async () => new Uint8Array([1]), authorization: async () => ({}),
      readChat: async () => null, mergeChat: async () => {}, merge, persist }, {
      inventory: async (_access, cursor) => cursor < 1 ? { objects: [{ objectId: id, sequence: 1 }], cursor: 1, hasMore: false }
        : { objects: [], cursor, hasMore: false }, download: async () => object,
      upload: async () => { throw new Error("Unexpected upload") },
    })

    await expect(replica.pull()).rejects.toThrow()
    expect(merge).not.toHaveBeenCalled()
    expect(config.cursor).toBe(0)
    expect(persist).not.toHaveBeenCalled()
  }
)

test("Given an uncertain durable receipt, when uploading retries, the same immutable ciphertext is reused", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const uploaded: string[] = []
  let attempts = 0
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1, 2, 3]), authorization: async () => ({ signed: true }),
    readChat: async () => null, mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected download") },
    upload: async (access, object, requestId) => { uploaded.push(await blindObjectId(object)); if (++attempts === 1) { await signedReceipt(access, object, requestId); throw new Error("Response lost after durable save") }; return signedReceipt(access, object, requestId) } })
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
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([1])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(snapshot)))
  const id = await blindObjectId(object)
  let calls = 0
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1]), authorization: async () => snapshot.authorization,
    readChat: async () => null, mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }, { inventory: async () => { calls++; return { objects: [{ objectId: id, sequence: calls }], cursor: calls, hasMore: calls < 9 } },
    download: async () => object, upload: async (access, encrypted, requestId) => signedReceipt(access, encrypted, requestId) })
  expect(await replica.sync()).toBe(false)
  expect(config.cursor).toBe(8)
  expect(await replica.sync()).toBe(true)
  expect(config.cursor).toBe(9)
})

test("Given eight fully admitted retained snapshots, when the owner catches up, a fresh checkpoint replaces the old prefix and unchanged polling stays bounded", async () => {
  const fixture = await checkpointFixture()
  await fixture.replica.sync()
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.requests[0]!.authorization.payload.expectedSequence).toBe(8)
  expect(fixture.config.cursor).toBe(9)
  expect(fixture.uploads).toBe(0)
  await fixture.replica.sync()
  expect(fixture.requests).toHaveLength(1)
})

test("Given quarantined or pending raw history, when a pass catches up, the client preserves every remote object and does not checkpoint", async () => {
  const fixture = await checkpointFixture()
  fixture.allowed = false
  await fixture.replica.sync()
  expect(fixture.requests).toHaveLength(0)
  expect(fixture.config.cursor).toBe(8)
})

test("Given a checkpoint receipt lost after durable storage, retries preserve ciphertext and authorization while advancing the local cursor only after confirmation", async () => {
  const fixture = await checkpointFixture()
  fixture.failure = "lost"
  await expect(fixture.replica.sync()).rejects.toThrow("Response lost")
  expect(fixture.config.cursor).toBe(8)
  const first = fixture.requests[0]
  fixture.failure = ""
  await fixture.replica.sync()
  expect(fixture.requests[1]).toEqual(first)
  expect(fixture.config.cursor).toBe(9)
})

test("Given another writer after inventory, checkpoint conflict never acknowledges stale replacement and the next pass admits that writer", async () => {
  const fixture = await checkpointFixture()
  fixture.failure = "conflict"
  expect(await fixture.replica.sync()).toBe(false)
  expect(fixture.config.cursor).toBe(8)
  fixture.failure = ""
  await fixture.replica.sync()
  expect(fixture.requests).toHaveLength(2)
  expect(fixture.requests[1]!.authorization.payload.expectedSequence).toBe(9)
  expect(fixture.config.cursor).toBe(10)
})

test("Given identity or admission changes during checkpoint preparation, the owner request is never submitted", async () => {
  const fixture = await checkpointFixture()
  fixture.changedDuringPreparation = true
  await fixture.replica.sync()
  expect(fixture.requests).toHaveLength(0)
  expect(fixture.config.cursor).toBe(8)
})

test("Failed logical revision inspection emits a bounded diagnosis while preserving the durable upload fallback", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  let uploads = 0
  const replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1]), authorization: async () => ({ signed: true }), readChat: async () => null,
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
    documentRevision: async () => { throw new RangeError("private document/proof details") },
    diagnostic: (event, detail) => events.push({ event, detail }),
  }, { inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected read") }, upload: async (access, object, requestId) => { uploads++; return signedReceipt(access, object, requestId) } })
  await replica.push()
  expect(uploads).toBe(1)
  expect(config.lastUploaded).not.toBe("")
  expect(events.find(value => value.event === "mesh.rusty.revision.failed")).toMatchObject({ detail: { phase: "revision", errorCode: "revision_invalid_document", operation: "revision" } })
  expect(JSON.stringify(events)).not.toContain("private document/proof details")
  expect(JSON.stringify(events)).not.toContain(config.contentKey)
})

async function checkpointFixture() {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(key), workspaceId: "board", cursor: 0, lastUploaded: "" }
  const snapshot = { version: 1, workspaceId: "board", document: encodeBlindBytes(new Uint8Array([1])), authorization: { signed: true }, chat: null }
  const object = await encryptBlindObject(config.scopeId, 1, key, new TextEncoder().encode(JSON.stringify(snapshot)))
  const objectId = await blindObjectId(object)
  const requests: BlindCheckpointRequest[] = []
  const state = { allowed: true, changedDuringPreparation: false, failure: "", uploads: 0, retained: 8, maximum: 8, requests, config, replica: undefined as unknown as BlindReplica }
  state.replica = new BlindReplica(config, {
    read: async () => new Uint8Array([1]), authorization: async () => snapshot.authorization, readChat: async () => null,
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
    checkpointAllowed: async () => state.allowed,
    prepareCheckpoint: async (_bytes, replacement, expectedSequence) => {
      if (state.changedDuringPreparation) state.allowed = false
      return { object: replacement, identity: { personId: "owner", publicKey: "unused", displayName: "Owner" }, deviceId: "device", certificates: [],
      authorization: { payload: { kind: "rusty-snapshot-checkpoint", version: 1, serviceId: "unused", origin: config.origin, scopeId: config.scopeId, keyEpoch: 1, policyRevision: 1,
        expectedSequence, objectId: await blindObjectId(replacement), requestId: crypto.randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 120000 }, signerKeyId: "device", signature: "unused" } }
    },
  }, { inventory: async (_access, after) => ({ objects: Array.from({ length: Math.max(0, state.maximum - after) }, (_, index) => ({ objectId, sequence: after + index + 1 })), cursor: Math.max(after, state.maximum), hasMore: false, objectCount: state.retained, maxSequence: state.maximum }),
    download: async () => object, upload: async () => { state.uploads++; return {} as BlindReceipt },
    checkpoint: async (_access, request) => {
      requests.push(request)
      if (state.failure === "lost") throw new Error("Response lost after durable save")
      if (state.failure === "conflict") { state.maximum++; throw Object.assign(new Error("Checkpoint inventory changed"), { code: "checkpoint_conflict" }) }
      state.maximum = request.authorization.payload.expectedSequence + 1; state.retained = 1
      return { payload: { sequence: state.maximum } } as BlindCheckpointReceipt
    },
  })
  return state
}

test("Given a reloaded client with an unchanged durable snapshot, subsequent encoding churn skips upload while real document, authority and chat changes retain their diagnosis", async () => {
  const config: BlindReplicaConfig = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "board", cursor: 0, lastUploaded: "" }
  let bytes = new Uint8Array([1]), revision = "heads-1", authority = { signed: "authority-1" }
  let chat: unknown = null, uploads = 0, revisionReads = 0
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const store = {
    read: async () => bytes, authorization: async () => authority, readChat: async () => chat,
    documentRevision: async () => { revisionReads++; return revision }, diagnostic: (event: string, detail: Record<string, unknown>) => events.push({ event, detail }),
    mergeChat: async () => {}, merge: async () => {}, persist: async () => {},
  }
  const transport = { inventory: async (_access: BlindAccess, cursor: number) => ({ objects: [], cursor, hasMore: false }), download: async () => { throw new Error("Unexpected read") }, upload: async (access: BlindAccess, object: BlindObject, requestId: string) => { uploads++; return signedReceipt(access, object, requestId) } }
  await new BlindReplica(config, store, transport).push()
  events.length = 0
  const reloaded = new BlindReplica(config, store, transport)
  await reloaded.push()
  expect(uploads).toBe(1)
  expect(events.at(-1)?.detail.phase).toBe("unchanged")
  await reloaded.push()
  expect(revisionReads).toBe(2)
  bytes = new Uint8Array([2])
  await reloaded.push()
  expect(uploads).toBe(1)
  expect(events.at(-1)?.detail.phase).toBe("encoding_unchanged_state")
  bytes = new Uint8Array([3]); revision = "heads-2"
  await reloaded.push()
  authority = { signed: "authority-2" }
  await reloaded.push()
  chat = { messages: ["private chat content"] }
  await reloaded.push()
  const completed = events.filter(value => value.event === "mesh.rusty.upload.completed")
  expect(completed.map(value => value.detail.changedFields)).toEqual([["document"], ["authority"], ["chat"]])
  expect(completed.every(value => value.detail.phase === "changed")).toBe(true)
  expect(uploads).toBe(4)
  expect(JSON.stringify(events)).not.toContain("private chat content")
})
