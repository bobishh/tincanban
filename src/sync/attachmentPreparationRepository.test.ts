import { IDBFactory, IDBObjectStore } from "fake-indexeddb"
import { BLOB_CHUNK_BYTES, createBlobDescriptor } from "@meta-uber/mesh-blob"
import { afterEach, expect, test, vi } from "vitest"
import { blindHash, blindObjectId } from "./blindClient"
import { AttachmentPreparationCodec } from "./attachmentCodec"
import type { AttachmentPreparation } from "./attachmentPreparationData"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { AttachmentProgress } from "./attachmentTransfer"

afterEach(() => vi.unstubAllGlobals())

async function setup(size = 7) {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const local = await import("../localDb")
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const source = new Uint8Array(size).fill(47)
  const descriptor = await createBlobDescriptor(source, "prepared.txt", "text/plain")
  const binding = await blindHash(new TextEncoder().encode("preparation binding"))
  const scope = { workspaceId: "board", scopeId: "attachment-scope", keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))) }
  const transferId = crypto.randomUUID()
  const codec = new AttachmentPreparationCodec(scope, descriptor, transferId)
  const state: AttachmentPreparation = { version: 1, generation: 0, binding, descriptor, transferId,
    manifestRequestId: crypto.randomUUID(), chunks: [] }
  const ensureCurrent = vi.fn()
  const repository = createAttachmentRepository("storage://profile/scope/preparation", ensureCurrent)
  return { local, createAttachmentRepository, repository, ensureCurrent, source, descriptor, binding, scope, codec, state }
}

async function stageFirstChunk(f: Awaited<ReturnType<typeof setup>>) {
  const chunk = f.source.slice(0, BLOB_CHUNK_BYTES)
  const object = await f.codec.sealChunk(0, chunk)
  const objectId = await blindObjectId(object)
  const next: AttachmentPreparation = { ...f.state, generation: 1,
    chunks: [{ index: 0, bytes: chunk.byteLength, objectId, requestId: crypto.randomUUID() }] }
  return { object, objectId, next }
}

test("Given two concurrent preparation starts, when both claim an empty slot, then one CAS wins without detached ciphertext", async () => {
  const f = await setup()
  const left = { ...f.state, transferId: crypto.randomUUID(), manifestRequestId: crypto.randomUUID() }
  const right = { ...f.state, transferId: crypto.randomUUID(), manifestRequestId: crypto.randomUUID() }

  const outcomes = await Promise.allSettled([
    f.repository.preparation.commit(null, left),
    f.repository.preparation.commit(null, right),
  ])

  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1)
  const saved = await f.repository.preparation.read()
  expect([left, right]).toContainEqual(saved)
  expect((await f.local.listLocalKeys()).filter(key => key.startsWith("tincanban.attachment-object.v1."))).toEqual([])
})

test("Given a saved preparation prefix, when identity, descriptor, prefix or request IDs are replaced, then reject each candidate", async () => {
  const f = await setup(BLOB_CHUNK_BYTES + 1)
  await f.repository.preparation.commit(null, f.state)
  const staged = await stageFirstChunk(f)
  await f.repository.preparation.commit(0, staged.next, { objectId: staged.objectId, object: staged.object })
  const saved = await f.repository.preparation.read()
  expect(saved).toEqual(staged.next)

  const second = { index: 1, bytes: 1, objectId: "Z".repeat(43), requestId: crypto.randomUUID() }
  const append = (updates: Partial<AttachmentPreparation> = {}) => ({ ...staged.next, ...updates,
    generation: 2, chunks: updates.chunks ?? [...staged.next.chunks, second] })
  const candidates: AttachmentPreparation[] = [
    append({ binding: "Y".repeat(43) }),
    append({ descriptor: { ...f.descriptor, name: "substituted.txt" } }),
    append({ transferId: crypto.randomUUID() }),
    append({ manifestRequestId: crypto.randomUUID() }),
    append({ chunks: [{ ...staged.next.chunks[0]!, requestId: crypto.randomUUID() }, second] }),
    append({ chunks: [{ ...staged.next.chunks[0]!, objectId: "X".repeat(43) }, second] }),
  ]

  for (const candidate of candidates) {
    await expect(f.repository.preparation.commit(1, candidate)).rejects.toThrow(/immutable|changed|conflict/i)
    expect(await f.repository.preparation.read()).toEqual(saved)
  }
})

test("Given an empty preparation, when staging ciphertext, then prefix and object persist together", async () => {
  const f = await setup()
  await f.repository.preparation.commit(null, f.state)
  const staged = await stageFirstChunk(f)

  const originalPut = IDBObjectStore.prototype.put
  let puts = 0
  const failSecondPut = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore,
    value: unknown, key?: IDBValidKey) {
    puts += 1
    if (puts === 2) throw new DOMException("Injected preparation write failure", "DataError")
    return originalPut.call(this, value, key)
  })
  try {
    await expect(f.repository.preparation.commit(0, staged.next,
      { objectId: staged.objectId, object: staged.object })).rejects.toThrow()
  } finally {
    failSecondPut.mockRestore()
  }
  expect(await f.repository.preparation.read()).toEqual(f.state)
  expect(await f.repository.object(staged.objectId)).toBeNull()

  await f.repository.preparation.commit(0, staged.next, { objectId: staged.objectId, object: staged.object })
  vi.resetModules()
  await import("../localDb")
  const reopened = f.createAttachmentRepository("storage://profile/scope/preparation", () => {})
  expect(await reopened.preparation.read()).toEqual(staged.next)
  expect(await reopened.object(staged.objectId)).toEqual(staged.object)
})

test("Given identity is revoked before CAS, when staging a chunk, then publish neither chunk progress nor ciphertext", async () => {
  let active = true
  const f = await setup()
  f.ensureCurrent.mockImplementation(() => { if (!active) throw new Error("identity changed") })
  await f.repository.preparation.commit(null, f.state)
  active = true
  const originalRead = f.local.readLocal.bind(f.local)
  const read = vi.spyOn(f.local, "readLocal").mockImplementation(async key => {
    const value = await originalRead(key)
    if (key.startsWith("tincanban.attachment-preparation.v1.")) active = false
    return value
  })
  const staged = await stageFirstChunk(f)
  try {
    await expect(f.repository.preparation.commit(0, staged.next,
      { objectId: staged.objectId, object: staged.object })).rejects.toThrow("identity changed")
  } finally {
    read.mockRestore()
  }

  active = true
  expect(await f.repository.preparation.read()).toEqual(f.state)
  expect(await f.repository.object(staged.objectId)).toBeNull()
})

test("Given a saved prefix, when discarding with an older snapshot, then retain current preparation and ciphertext", async () => {
  const f = await setup()
  await f.repository.preparation.commit(null, f.state)
  const stale = await f.repository.preparation.read()
  expect(stale).toEqual(f.state)
  const staged = await stageFirstChunk(f)
  await f.repository.preparation.commit(0, staged.next, { objectId: staged.objectId, object: staged.object })

  await expect(f.repository.preparation.discard(stale!)).rejects.toThrow(/changed|discard/i)
  expect(await f.repository.preparation.read()).toEqual(staged.next)
  expect(await f.repository.object(staged.objectId)).toEqual(staged.object)
})

test("Given a complete prepared prefix, when final publication fails then retries, then publish journal and manifest atomically", async () => {
  const f = await setup()
  await f.repository.preparation.commit(null, f.state)
  const staged = await stageFirstChunk(f)
  await f.repository.preparation.commit(0, staged.next, { objectId: staged.objectId, object: staged.object })
  const sealed = await f.codec.sealManifest(staged.next.chunks.map(({ index, objectId, bytes }) => ({ index, objectId, bytes })))
  const manifestId = await blindObjectId(sealed.manifest)
  const progress: AttachmentProgress = { version: 1, generation: 0, binding: f.binding, descriptor: f.descriptor,
    locator: { ...sealed.locator, manifestId },
    objects: staged.next.chunks.map(({ objectId, requestId }) => ({ objectId, requestId }))
      .concat({ objectId: manifestId, requestId: f.state.manifestRequestId }), receipts: {}, received: [] }

  const originalPut = IDBObjectStore.prototype.put
  let puts = 0
  const failSecondPut = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore,
    value: unknown, key?: IDBValidKey) {
    puts += 1
    if (puts === 2) throw new DOMException("Injected publication write failure", "DataError")
    return originalPut.call(this, value, key)
  })
  try {
    await expect(f.repository.preparation.finish(1, progress, { objectId: manifestId, object: sealed.manifest })).rejects.toThrow()
  } finally {
    failSecondPut.mockRestore()
  }
  expect(await f.repository.read()).toBeNull()
  expect(await f.repository.preparation.read()).toEqual(staged.next)
  expect(await f.repository.object(manifestId)).toBeNull()
  expect(await f.repository.object(staged.objectId)).toEqual(staged.object)

  await f.repository.preparation.finish(1, progress, { objectId: manifestId, object: sealed.manifest })
  expect(await f.repository.read()).toEqual(progress)
  expect(await f.repository.preparation.read()).toBeNull()
  expect(await f.repository.object(manifestId)).toEqual(sealed.manifest)
  expect(await f.repository.object(staged.objectId)).toEqual(staged.object)
  await expect(f.repository.preparation.discard(staged.next)).rejects.toThrow(/changed|discard/i)
  expect(await f.repository.read()).toEqual(progress)
  expect(await f.repository.object(manifestId)).toEqual(sealed.manifest)
  expect(await f.repository.object(staged.objectId)).toEqual(staged.object)
})
