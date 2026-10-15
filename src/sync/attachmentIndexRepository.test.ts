import { IDBFactory } from "fake-indexeddb"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AttachmentLocator } from "./attachmentCodec"

afterEach(() => vi.unstubAllGlobals())

async function setup() {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const local = await import("../localDb")
  const { createAttachmentIndexRepository, planAttachmentIndexMigration } = await import("./attachmentIndexRepository")
  const ensureCurrent = vi.fn()
  const storageId = "owner-device/workspace/scope/epoch-1"
  return { local, createAttachmentIndexRepository, planAttachmentIndexMigration, ensureCurrent, storageId,
    repository: createAttachmentIndexRepository(storageId, ensureCurrent) }
}

const locator = (blob: string, transfer: string, manifest: string): AttachmentLocator => ({
  version: 1, blobId: `sha256:${blob.repeat(43)}`, transferId: transfer, manifestId: manifest.repeat(43),
})

describe("private attachment index repository", () => {
  it("rejects storage identifiers beyond the shared UTF-8 bound", async () => {
    const f = await setup()
    expect(() => f.createAttachmentIndexRepository("x".repeat(16 * 1024 + 1), f.ensureCurrent)).toThrow(/storage ID/i)
    await expect(f.planAttachmentIndexMigration("x".repeat(16 * 1024 + 1), "valid-target"))
      .rejects.toThrow(/storage ID/i)
  })

  it("reads as empty, then advances a stable revision only when union adds a locator", async () => {
    const f = await setup()
    const first = locator("A", "transfer-one", "C")
    expect(await f.repository.read()).toEqual([])
    expect(await f.repository.revision()).toBeUndefined()
    await f.repository.merge([])
    expect(await f.repository.revision()).toBeUndefined()

    await f.repository.merge([first])
    const revision = await f.repository.revision()
    expect(revision).toEqual(expect.any(String))
    expect(await f.repository.read()).toEqual([first])
    await f.repository.merge([first])
    expect(await f.repository.revision()).toBe(revision)

    await f.repository.merge([locator("B", "transfer-two", "D")])
    expect(await f.repository.revision()).not.toBe(revision)
    expect(f.ensureCurrent).toHaveBeenCalled()
  })

  it("reuses the exact durable record revision until another repository changes it", async () => {
    const f = await setup()
    const other = f.createAttachmentIndexRepository(f.storageId, f.ensureCurrent)
    const first = locator("A", "transfer-one", "C")
    const second = locator("B", "transfer-two", "D")
    await f.repository.merge([first])
    const firstRevision = await f.repository.revision()

    const digest = vi.spyOn(crypto.subtle, "digest")
    try {
      expect(await f.repository.revision()).toBe(firstRevision)
      expect(digest).not.toHaveBeenCalled()

      await other.merge([second])
      const persistedRevision = await other.revision()
      digest.mockClear()
      expect(await f.repository.revision()).toBe(persistedRevision)
      expect(digest).toHaveBeenCalledTimes(1)
      expect(await f.repository.read()).toEqual([first, second])
    } finally { digest.mockRestore() }
  })

  it("unions concurrent transfers atomically and reopens the same durable index", async () => {
    const f = await setup()
    const second = f.createAttachmentIndexRepository(f.storageId, f.ensureCurrent)
    const firstLocator = locator("A", "transfer-one", "C")
    const secondLocator = locator("B", "transfer-two", "D")
    await Promise.all([f.repository.merge([firstLocator]), second.merge([secondLocator])])
    expect(await f.repository.read()).toEqual([firstLocator, secondLocator])

    const reopened = f.createAttachmentIndexRepository(f.storageId, f.ensureCurrent)
    expect(await reopened.read()).toEqual([firstLocator, secondLocator])
  })

  it("rejects conflicts and malformed stored records without replacing valid state", async () => {
    const f = await setup()
    const first = locator("A", "transfer-one", "C")
    await f.repository.merge([first])
    const revision = await f.repository.revision()
    await expect(f.repository.merge([locator("A", "transfer-one", "D")])).rejects.toThrow()
    expect(await f.repository.read()).toEqual([first])
    expect(await f.repository.revision()).toBe(revision)

    const keys = await f.local.listLocalKeys()
    const key = keys.find(value => value.startsWith("tincanban.attachment-index.v1."))
    expect(key).toBeDefined()
    await f.local.writeLocal(key!, JSON.stringify({ version: 1, generation: -1, locators: [first] }))
    await expect(f.repository.read()).rejects.toThrow()
    await f.local.writeLocal(key!, JSON.stringify({ version: 1, generation: 1, locators: [first], owner: "hidden" }))
    await expect(f.repository.read()).rejects.toThrow()
  })

  it("guards read and transactional merge before touching durable data", async () => {
    const f = await setup()
    let active = true
    f.ensureCurrent.mockImplementation(() => { if (!active) throw new Error("Identity changed") })
    await f.repository.merge([locator("A", "transfer-one", "C")])
    active = false
    await expect(f.repository.read()).rejects.toThrow("Identity changed")
    await expect(f.repository.merge([locator("B", "transfer-two", "D")])).rejects.toThrow("Identity changed")
    active = true
    expect(await f.repository.read()).toEqual([locator("A", "transfer-one", "C")])
  })

  it("rechecks current identity inside the atomic update callback before publishing a union", async () => {
    let calls = 0
    let failAt = Number.POSITIVE_INFINITY
    const ensureCurrent = vi.fn(() => {
      calls += 1
      if (calls === failAt) throw new Error("Identity changed")
    })
    const f = await setup()
    const repository = f.createAttachmentIndexRepository("guarded-attachment-index", ensureCurrent)
    const original = locator("A", "transfer-one", "C")
    await repository.merge([original])
    const revision = await repository.revision()

    calls = 0
    failAt = 4
    await expect(repository.merge([locator("B", "transfer-two", "D")])).rejects.toThrow("Identity changed")
    failAt = Number.POSITIVE_INFINITY
    expect(await repository.read()).toEqual([original])
    expect(await repository.revision()).toBe(revision)
  })

  it("plans a legacy-index migration without writes, then CAS-publishes the additive union", async () => {
    const f = await setup()
    const legacy = f.createAttachmentIndexRepository("legacy-index", f.ensureCurrent)
    const target = f.createAttachmentIndexRepository("stable-crypto-index", f.ensureCurrent)
    const oldLocator = locator("A", "legacy-transfer", "C")
    const currentLocator = locator("B", "current-transfer", "D")
    await legacy.merge([oldLocator])
    await target.merge([currentLocator])
    const beforeLegacy = await legacy.read()
    const beforeTarget = await target.read()
    const keysBefore = await f.local.listLocalKeys()
    const plan = await f.planAttachmentIndexMigration("legacy-index", "stable-crypto-index")

    expect(plan.conditions).toHaveLength(2)
    expect(plan.writes).toHaveLength(1)
    expect(await legacy.read()).toEqual(beforeLegacy)
    expect(await target.read()).toEqual(beforeTarget)
    expect(await f.local.listLocalKeys()).toEqual(keysBefore)

    expect(await f.local.compareAndSwapLocal(plan)).toBe(true)
    expect(await target.read()).toEqual([oldLocator, currentLocator])
    expect(await legacy.read()).toEqual([oldLocator])
  })

  it.each(["source", "target"] as const)("rejects a stale %s record without partially publishing the migration", async changed => {
    const f = await setup()
    const legacy = f.createAttachmentIndexRepository("legacy-index", f.ensureCurrent)
    const target = f.createAttachmentIndexRepository("stable-crypto-index", f.ensureCurrent)
    const oldLocator = locator("A", "legacy-transfer", "C")
    const currentLocator = locator("B", "current-transfer", "D")
    const competingLocator = locator("E", "competing-transfer", "F")
    await legacy.merge([oldLocator])
    await target.merge([currentLocator])
    const plan = await f.planAttachmentIndexMigration("legacy-index", "stable-crypto-index")
    if (changed === "source") await legacy.merge([competingLocator])
    else await target.merge([competingLocator])
    const targetBeforeCommit = await target.read()

    expect(await f.local.compareAndSwapLocal(plan)).toBe(false)
    expect(await target.read()).toEqual(targetBeforeCommit)
  })

  it("refuses a corrupt legacy index before producing any target write", async () => {
    const f = await setup()
    const legacy = f.createAttachmentIndexRepository("legacy-index", f.ensureCurrent)
    const target = f.createAttachmentIndexRepository("stable-crypto-index", f.ensureCurrent)
    await legacy.merge([locator("A", "legacy-transfer", "C")])
    await target.merge([locator("B", "current-transfer", "D")])
    const indexKeys = (await f.local.listLocalKeys()).filter(key => key.startsWith("tincanban.attachment-index.v1."))
    const legacyKey = (await Promise.all(indexKeys.map(async key => [key, await f.local.readLocal(key)] as const)))
      .find(([, raw]) => raw?.includes("legacy-transfer"))?.[0]
    if (!legacyKey) throw new Error("Expected legacy index record")
    const targetBefore = await target.read()
    await f.local.writeLocal(legacyKey, "{corrupt")

    await expect(f.planAttachmentIndexMigration("legacy-index", "stable-crypto-index")).rejects.toThrow()
    expect(await target.read()).toEqual(targetBefore)
  })

  it("treats a same-key migration as a condition-only no-op", async () => {
    const f = await setup()
    await f.repository.merge([locator("A", "transfer-one", "C")])
    const before = await f.local.listLocalKeys()
    const plan = await f.planAttachmentIndexMigration(f.storageId, f.storageId)

    expect(plan.conditions).toHaveLength(1)
    expect(plan.writes).toEqual([])
    expect(await f.local.listLocalKeys()).toEqual(before)
    expect(await f.local.compareAndSwapLocal(plan)).toBe(true)
  })
})
