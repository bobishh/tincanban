import { IDBFactory } from "fake-indexeddb"
import { afterEach, expect, it, vi } from "vitest"
import { BLOB_CHUNK_BYTES, MeshBlobStore } from "@meta-uber/mesh-blob"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { AttachmentTransfer } from "./attachmentTransfer"
import { fixture } from "./attachmentTransfer.testSupport"

afterEach(() => vi.unstubAllGlobals())

async function setup(size = BLOB_CHUNK_BYTES * 2) {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const local = await import("../localDb")
  const f = await fixture(size)
  const reopen = () => createAttachmentRepository("streaming-attachment", () => {})
  const repository = reopen()
  const engine = (port = repository) => new AttachmentTransfer(f.scope, f.access, port, async () => {}, f)
  async function* source() {
    for (let offset = 0; offset < f.bytes.length; offset += BLOB_CHUNK_BYTES) {
      yield f.bytes.slice(offset, offset + BLOB_CHUNK_BYTES)
    }
  }
  return { ...f, repository, reopen, engine, source, local }
}

it("Given bounded source chunks, when preparation is interrupted after every chunk is durable, then restart verifies and uploads exact ciphertext without source bytes", async () => {
  const f = await setup()
  async function* interrupted() {
    yield f.bytes.slice(0, BLOB_CHUNK_BYTES)
    const staged = await f.repository.preparation!.read()
    expect(staged?.chunks).toHaveLength(1)
    expect(await f.repository.object(staged!.chunks[0]!.objectId)).not.toBeNull()
    expect(await f.repository.read()).toBeNull()
    expect(f.upload).not.toHaveBeenCalled()
    yield f.bytes.slice(BLOB_CHUNK_BYTES)
    throw new Error("Source disconnected before completion")
  }
  await expect(f.engine().uploadStream(f.descriptor, interrupted())).rejects.toThrow("Source disconnected")
  const staged = await f.reopen().preparation!.read()
  expect(staged?.chunks).toHaveLength(2)
  const saved = await Promise.all(staged!.chunks.map(chunk => f.repository.object(chunk.objectId)))
  const locator = await f.engine(f.reopen()).uploadStream(f.descriptor)
  expect(f.upload.mock.calls.slice(0, 2).map(call => call[1])).toEqual(saved)
  expect(f.upload.mock.calls.slice(0, 2).map(call => call[2])).toEqual(staged!.chunks.map(chunk => chunk.requestId))
  expect(locator.transferId).toBe(staged!.transferId)
  expect(await f.reopen().preparation!.read()).toBeNull()
  expect(await f.engine(f.reopen()).download(f.descriptor, locator)).toEqual(f.bytes)
})

it("Given an interrupted prefix, when a replacement source differs, then preserve the old encrypted prefix and require the original file", async () => {
  const f = await setup()
  async function* prefix() { yield f.bytes.slice(0, BLOB_CHUNK_BYTES); throw new Error("Offline") }
  await expect(f.engine().uploadStream(f.descriptor, prefix())).rejects.toThrow("Offline")
  const staged = await f.reopen().preparation!.read()
  await expect(f.engine(f.reopen()).uploadStream(f.descriptor)).rejects.toThrow(/source|file/i)
  async function* different() { yield new Uint8Array(BLOB_CHUNK_BYTES).fill(99) }
  await expect(f.engine(f.reopen()).uploadStream(f.descriptor, different())).rejects.toThrow(/source|chunk/i)
  expect(await f.reopen().preparation!.read()).toEqual(staged)
  expect(f.upload).not.toHaveBeenCalled()
  await f.engine(f.reopen()).uploadStream(f.descriptor, f.source())
  expect(f.upload.mock.calls[0]![2]).toBe(staged!.chunks[0]!.requestId)
})

it("Given a source with the right length and wrong digest, when staged completely, then publish nothing and allow the original file to retry after restart", async () => {
  const f = await setup()
  async function* corrupt() {
    yield new Uint8Array(BLOB_CHUNK_BYTES).fill(55)
    yield new Uint8Array(BLOB_CHUNK_BYTES).fill(55)
  }
  await expect(f.engine().uploadStream(f.descriptor, corrupt())).rejects.toThrow(/digest/i)
  expect(await f.repository.read()).toBeNull()
  await expect(f.engine(f.reopen()).uploadStream(f.descriptor)).rejects.toThrow(/source|file/i)
  expect(f.upload).not.toHaveBeenCalled()
  expect(await f.repository.preparation.read()).toBeNull()
  expect((await f.local.listLocalKeys()).filter(key => key.startsWith("tincanban.attachment-object.v1."))).toEqual([])
  const locator = await f.engine(f.reopen()).uploadStream(f.descriptor, f.source())
  expect(await f.engine(f.reopen()).download(f.descriptor, locator)).toEqual(f.bytes)
})

it("Given final journal publication succeeds but its response is lost, when restarted, then reuse the completed journal without reading the source", async () => {
  const f = await setup()
  const finish = f.repository.preparation!.finish
  const uncertain = { ...f.repository, preparation: { ...f.repository.preparation!, finish: async (...args: Parameters<typeof finish>) => {
    await finish(...args)
    throw new Error("Publication response lost")
  } } }
  await expect(f.engine(uncertain).uploadStream(f.descriptor, f.source())).rejects.toThrow("Publication response lost")
  const journal = await f.reopen().read()
  expect(journal?.objects).toHaveLength(3)
  await f.engine(f.reopen()).uploadStream(f.descriptor)
  expect(f.upload.mock.calls.map(call => call[2])).toEqual(journal!.objects.map(object => object.requestId))
})

it("Given a streamed download fails on its last chunk, when writing the local sink, then publish no partial file and resume from retained encrypted chunks", async () => {
  const f = await setup()
  const locator = await f.engine().uploadStream(f.descriptor, f.source())
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const recipient = createAttachmentRepository("streaming-recipient", () => {})
  const store = new MeshBlobStore(new BrowserMeshStore("streaming-recipient-files", ["blobs"]))
  let downloads = 0
  const transport = { upload: f.upload, download: async (...args: Parameters<typeof f.download>) => {
    if (++downloads === 3) {
      expect(await store.getVerified(f.descriptor)).toBeUndefined()
      throw new Error("Last chunk unavailable")
    }
    return f.download(...args)
  } }
  const failed = new AttachmentTransfer(f.scope, f.access, recipient, async () => {}, transport)
  await expect(store.putStream(f.descriptor, failed.downloadStream(f.descriptor, locator))).rejects.toThrow("Last chunk unavailable")
  expect(await store.getVerified(f.descriptor)).toBeUndefined()
  f.download.mockClear()
  const retry = new AttachmentTransfer(f.scope, f.access, recipient, async () => {}, f)
  await store.putStream(f.descriptor, retry.downloadStream(f.descriptor, locator))
  expect(await store.getVerified(f.descriptor)).toEqual(f.bytes)
  expect(f.download).toHaveBeenCalledOnce()
})

it("Given a download iterator is created before caller mutation, when consumed later, then retain the original descriptor and locator", async () => {
  const f = await setup()
  const locator = await f.engine().uploadStream(f.descriptor, f.source())
  const descriptor = { ...f.descriptor }
  const iterator = f.engine().downloadStream(descriptor, locator)
  descriptor.name = "changed.txt"
  locator.transferId = "changed-transfer"
  const chunks: Uint8Array[] = []
  for await (const chunk of iterator) chunks.push(chunk)
  expect(chunks.map(chunk => chunk.length)).toEqual([BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES])
  expect(chunks[0]).toEqual(f.bytes.slice(0, BLOB_CHUNK_BYTES))
})
