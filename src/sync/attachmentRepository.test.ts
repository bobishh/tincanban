import { IDBFactory } from "fake-indexeddb"
import { createBlobDescriptor } from "@meta-uber/mesh-blob"
import { afterEach, expect, test, vi } from "vitest"
import { blindHash, blindObjectId } from "./blindClient"
import { encodeBlindBytes, encryptBlindObject } from "./blindEnvelope"
import type { AttachmentProgress } from "./attachmentTransfer"

afterEach(() => vi.unstubAllGlobals())

async function setup() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const local = await import("../localDb")
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const descriptor = await createBlobDescriptor(new Uint8Array([1, 2, 3]), "resume.txt", "text/plain")
  const binding = await blindHash(new TextEncoder().encode("attachment binding"))
  const scopeId = "attachment-scope"
  const object = await encryptBlindObject(scopeId, 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([4, 5, 6]))
  const objectId = await blindObjectId(object)
  const progress: AttachmentProgress = { version: 1, generation: 0, binding, descriptor,
    locator: { version: 1, blobId: descriptor.blobId, transferId: crypto.randomUUID(), manifestId: "A".repeat(43) },
    objects: [{ objectId, requestId: "request-id-for-upload-0001" }], receipts: {}, received: [] }
  const ensureCurrent = vi.fn()
  const repository = createAttachmentRepository("storage://profile/scope/attachment", ensureCurrent)
  return { local, createAttachmentRepository, repository, ensureCurrent, progress, object, objectId }
}

function receiptFor(f: Awaited<ReturnType<typeof setup>>) {
  const serviceId = "B".repeat(43)
  const requestId = f.progress.objects[0]!.requestId
  return { payload: { kind: "blind-blob-storage-receipt" as const, version: 1 as const, serviceId,
    scopeId: f.object.scopeId, keyEpoch: f.object.keyEpoch, objectId: f.objectId, policyRevision: 4, requestId },
  signerKeyId: serviceId, signature: encodeBlindBytes(new Uint8Array(64)) }
}

function migrateBinding(repository: Awaited<ReturnType<typeof setup>>["repository"], expected: number,
  previousBinding: string, next: AttachmentProgress): Promise<void> {
  const migratable = repository as unknown as { migrateBinding: (generation: number, previous: string, state: AttachmentProgress) => Promise<void> }
  return migratable.migrateBinding(expected, previousBinding, next)
}

test("Given a new transfer, when progress and ciphertext commit together, then a fresh repository reads exact durable records", async () => {
  const f = await setup()
  await f.repository.commit(null, f.progress, [{ objectId: f.objectId, object: f.object }])
  expect(await f.repository.read()).toEqual(f.progress)
  expect(await f.repository.object(f.objectId)).toEqual(f.object)

  vi.resetModules()
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const reopened = createAttachmentRepository("storage://profile/scope/attachment", () => {})
  expect(await reopened.read()).toEqual(f.progress)
  expect(await reopened.object(f.objectId)).toEqual(f.object)
})

test("Given an acknowledged ciphertext, when only receipt metadata changes, then object bytes stay exact", async () => {
  const f = await setup()
  await f.repository.commit(null, f.progress, [{ objectId: f.objectId, object: f.object }])
  const committedReceipt = { payload: { kind: "blind-blob-storage-receipt" as const, version: 1 as const,
    serviceId: "B".repeat(43), scopeId: f.object.scopeId, keyEpoch: f.object.keyEpoch, objectId: f.objectId,
    policyRevision: 4, requestId: f.progress.objects[0]!.requestId }, signerKeyId: "B".repeat(43), signature: encodeBlindBytes(new Uint8Array(64)) }
  const next = { ...f.progress, generation: 1, receipts: { [f.objectId]: committedReceipt } }
  await f.repository.commit(0, next)
  expect(await f.repository.object(f.objectId)).toEqual(f.object)
  expect(await f.repository.read()).toEqual(next)
})

test("Given a competing writer or mismatched ciphertext ID, when commit runs, then no partial state or object is published", async () => {
  const f = await setup()
  const newer = { ...f.progress, generation: 1 }
  await f.repository.commit(null, f.progress)
  await expect(f.repository.commit(null, newer)).rejects.toThrow(/generation|changed|conflict/i)
  await expect(f.repository.commit(1, { ...newer, generation: 2 }, [{ objectId: "C".repeat(43), object: f.object }]))
    .rejects.toThrow(/object|identifier|hash/i)
  expect(await f.repository.read()).toEqual(f.progress)
  expect(await f.repository.object("C".repeat(43))).toBeNull()
})

test("Given a stale generation or a rejected currentness guard, when commit runs, then durable progress remains unchanged", async () => {
  const f = await setup()
  await f.repository.commit(null, f.progress)
  await expect(f.repository.commit(8, { ...f.progress, generation: 9 })).rejects.toThrow(/generation|changed|conflict/i)
  f.ensureCurrent.mockImplementation(() => { throw new Error("identity changed") })
  await expect(f.repository.commit(0, { ...f.progress, generation: 1 })).rejects.toThrow("identity changed")
  f.ensureCurrent.mockReset()
  const reopened = f.createAttachmentRepository("storage://profile/scope/attachment", () => {})
  expect(await reopened.read()).toEqual(f.progress)
})

test("Given two independent IndexedDB handles, when both publish the same generation, then one CAS wins without a lost update", async () => {
  const f = await setup()
  await f.repository.commit(null, f.progress)
  vi.resetModules()
  await import("../localDb")
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const otherHandle = createAttachmentRepository("storage://profile/scope/attachment", () => {})
  const left = { ...f.progress, generation: 1, received: [f.objectId] }
  const right = { ...f.progress, generation: 1, received: [] }
  const outcomes = await Promise.allSettled([f.repository.commit(0, left), otherHandle.commit(0, right)])
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1)
  const saved = await otherHandle.read()
  expect(saved?.generation).toBe(1)
  expect([left.received, right.received]).toContainEqual(saved?.received)
})

test("Given a durable transfer, when a later generation changes its identity or upload plan, then reject substitution", async () => {
  const candidates = [
    (progress: AttachmentProgress) => ({ ...progress, generation: 1, binding: "D".repeat(43) }),
    (progress: AttachmentProgress) => ({ ...progress, generation: 1, descriptor: { ...progress.descriptor, name: "substituted.txt" } }),
    (progress: AttachmentProgress) => ({ ...progress, generation: 1, locator: { ...progress.locator, transferId: crypto.randomUUID() } }),
    (progress: AttachmentProgress) => ({ ...progress, generation: 1,
      objects: [{ ...progress.objects[0]!, requestId: "different-request-id-00002" }] }),
  ]
  for (const makeCandidate of candidates) {
    const current = await setup()
    await current.repository.commit(null, current.progress)
    const candidate = makeCandidate(current.progress)
    await expect(current.repository.commit(0, candidate)).rejects.toThrow(/immutable|changed|substitut|transfer/i)
    expect(await current.repository.read()).toEqual(current.progress)
  }
})

test("Given an unchanged transfer under an old binding, when migrating binding, then preserve all evidence and ciphertext", async () => {
  const f = await setup()
  f.progress.descriptor.ticket = "expired-peer-session"
  await f.repository.commit(null, f.progress, [{ objectId: f.objectId, object: f.object }])
  const receipt = receiptFor(f)
  const acknowledged = { ...f.progress, generation: 1, receipts: { [f.objectId]: receipt }, received: [f.objectId] }
  await f.repository.commit(0, acknowledged)
  const objectKey = (await f.local.listLocalKeys()).find(key => key.endsWith(`.${f.objectId}`))!
  const objectRaw = await f.local.readLocal(objectKey)
  const next = { ...acknowledged, generation: 2, binding: "C".repeat(43) }

  await migrateBinding(f.repository, 1, f.progress.binding, next)

  expect(await f.repository.read()).toEqual(next)
  expect(await f.repository.object(f.objectId)).toEqual(f.object)
  expect(await f.local.readLocal(objectKey)).toBe(objectRaw)
})

test("Given stale or malformed migration input, when migrating binding, then preserve current state", async () => {
  const f = await setup()
  await f.repository.commit(null, f.progress)
  const next = { ...f.progress, generation: 1, binding: "C".repeat(43) }
  await expect(migrateBinding(f.repository, 1, f.progress.binding, next)).rejects.toThrow(/generation|conflict/i)
  await expect(migrateBinding(f.repository, 0, "D".repeat(43), next)).rejects.toThrow(/binding|conflict/i)
  await expect(migrateBinding(f.repository, 0, f.progress.binding, { ...next, binding: "bad" })).rejects.toThrow()
  const rewritten = { ...next, descriptor: { ...next.descriptor, name: "changed.txt" } }
  await expect(migrateBinding(f.repository, 0, f.progress.binding, rewritten)).rejects.toThrow(/immutable|migration/i)
  expect(await f.repository.read()).toEqual(f.progress)
})

test("Given two concurrent binding migrations, when both use the captured generation, then one CAS wins", async () => {
  const f = await setup()
  await f.repository.commit(null, f.progress)
  vi.resetModules()
  await import("../localDb")
  const { createAttachmentRepository } = await import("./attachmentRepository")
  const other = createAttachmentRepository("storage://profile/scope/attachment", () => {})
  const left = { ...f.progress, generation: 1, binding: "C".repeat(43) }
  const right = { ...f.progress, generation: 1, binding: "D".repeat(43) }
  const outcomes = await Promise.allSettled([
    migrateBinding(f.repository, 0, f.progress.binding, left),
    migrateBinding(other, 0, f.progress.binding, right),
  ])
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1)
  expect(await other.read()).toMatchObject({ generation: 1, descriptor: f.progress.descriptor, objects: f.progress.objects })
})

test("Given an identity change after migration reads state, when publishing, then the CAS does not change durable progress", async () => {
  let active = true
  const f = await setup()
  f.ensureCurrent.mockImplementation(() => { if (!active) throw new Error("identity changed") })
  await f.repository.commit(null, f.progress)
  const originalRead = f.local.readLocal.bind(f.local)
  const read = vi.spyOn(f.local, "readLocal").mockImplementation(async key => {
    const value = await originalRead(key)
    active = false
    return value
  })
  try {
    await expect(migrateBinding(f.repository, 0, f.progress.binding,
      { ...f.progress, generation: 1, binding: "C".repeat(43) })).rejects.toThrow("identity changed")
  } finally { read.mockRestore() }
  active = true
  const reopened = f.createAttachmentRepository("storage://profile/scope/attachment", () => {})
  expect(await reopened.read()).toEqual(f.progress)
})

test("Given acknowledged and received objects, when a later generation removes or rewrites them, then retain monotonic evidence", async () => {
  const f = await setup()
  const receipt = receiptFor(f)
  const acknowledged = { ...f.progress, generation: 1, receipts: { [f.objectId]: receipt }, received: [f.objectId] }
  await f.repository.commit(null, f.progress)
  await f.repository.commit(0, acknowledged)
  const removedEvidence = { ...acknowledged, generation: 2, receipts: {}, received: [] }
  await expect(f.repository.commit(1, removedEvidence)).rejects.toThrow(/receipt|received|retain|monotonic/i)
  const changedReceipt = { ...acknowledged, generation: 2,
    receipts: { [f.objectId]: { ...receipt, signature: encodeBlindBytes(new Uint8Array(64).fill(1)) } } }
  await expect(f.repository.commit(1, changedReceipt)).rejects.toThrow(/receipt|immutable|retain/i)
  expect(await f.repository.read()).toEqual(acknowledged)
})

test("Given a failure after the state write is queued, when a bundle commit aborts, then neither state nor ciphertext becomes visible", async () => {
  const f = await setup()
  const { IDBObjectStore } = await import("fake-indexeddb")
  const original = IDBObjectStore.prototype.put
  let calls = 0
  const injected = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    calls += 1
    if (calls === 2) throw new DOMException("Injected attachment write failure", "DataError")
    return original.call(this, value, key)
  })
  try {
    await expect(f.repository.commit(null, f.progress, [{ objectId: f.objectId, object: f.object }])).rejects.toThrow()
  } finally { injected.mockRestore() }
  const reopened = f.createAttachmentRepository("storage://profile/scope/attachment", () => {})
  expect(await reopened.read()).toBeNull()
  expect(await reopened.object(f.objectId)).toBeNull()
})
