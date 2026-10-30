import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ChatStore, type StoredChatMessage, type StoredChatProfile } from "./store"

const workspaceId = "ws_store_contract"
function message(index: number, record: unknown = null): StoredChatMessage {
  return {
    id: `msg_${String(index).padStart(4, "0")}`, workspaceId, personId: "p_author",
    createdAt: new Date(Date.parse("2026-09-10T00:00:00.000Z") + index * 1000).toISOString(),
    body: `Message ${index}`, record,
  }
}

function profile(revision: number, name = `Person ${revision}`): StoredChatProfile {
  return { workspaceId, personId: "p_profile", name, revision, record: { revision } }
}

async function removeContentRevision(dbName: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite")
    const store = tx.objectStore("meta")
    const request = store.get(workspaceId)
    request.onsuccess = () => {
      const meta = request.result
      delete meta.contentRevision
      delete meta.contentGeneration
      store.put(meta)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

async function deleteWorkspaceMeta(dbName: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite")
    tx.objectStore("meta").delete(workspaceId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

function revisionCounter(revision: string): number {
  return Number(revision.slice(revision.lastIndexOf(":") + 1))
}

describe("ChatStore transaction rules", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory())
    vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("Given a stored message, when the same message is appended again from one store or two, then the duplicate is suppressed and distinct messages remain", async () => {
    const store = new ChatStore("duplicate-append")
    const shared = message(0)
    expect(await store.append(shared)).toBe(true)
    expect(await store.append(shared)).toBe(false)
    expect((await store.load(workspaceId)).messages).toEqual([shared])

    const name = "concurrent-tabs"
    const first = new ChatStore(name)
    const second = new ChatStore(name)
    const left = message(1)
    const right = message(2)
    const [firstResult, secondResult] = await Promise.all([
      first.append(shared).then(async saved => ({ saved, unique: await first.append(left) })),
      second.append(shared).then(async saved => ({ saved, unique: await second.append(right) })),
    ])
    expect([firstResult.saved, secondResult.saved].filter(Boolean)).toHaveLength(1)
    expect(firstResult.unique).toBe(true)
    expect(secondResult.unique).toBe(true)
    expect((await first.load(workspaceId)).messages.map(item => item.id).sort()).toEqual([shared.id, left.id, right.id].sort())
  })

  it("Given an immutable stored message, when its ID is reused with different content, then append rejects without changing it", async () => {
    const store = new ChatStore("conflict")
    const original = message(0, { version: 1 })
    expect(await store.append(original)).toBe(true)
    await expect(store.append({ ...original, body: "Conflicting content", record: { version: 2 } })).rejects.toThrow(/conflict|immutable/i)
    expect((await store.load(workspaceId)).messages).toEqual([original])
  })

  it("Given 2001 chronological messages, when merged, then only the latest 2000 persist and the pruned cutoff prevents reimport", async () => {
    const store = new ChatStore("count-cap")
    const messages = Array.from({ length: 2001 }, (_, index) => message(index))
    expect((await store.merge(workspaceId, messages, [])).added).toHaveLength(2000)
    const snapshot = await store.load(workspaceId)
    expect(snapshot.messages).toHaveLength(2000)
    expect(snapshot.messages[0]?.id).toBe("msg_0001")
    expect(snapshot.messages.at(-1)?.id).toBe("msg_2000")
    expect(await store.append(messages[0]!)).toBe(false)
    expect((await store.merge(workspaceId, [messages[0]!], [])).added).toHaveLength(0)
    expect((await store.load(workspaceId)).messages).toEqual(snapshot.messages)
  })

  it("Given two batches exceeding 4 MiB, when merged, then older messages are pruned and cannot return", async () => {
    const store = new ChatStore("byte-cap")
    const messages = Array.from({ length: 280 }, (_, index) => message(index, { data: "x".repeat(15 * 1024) }))
    await store.merge(workspaceId, messages.slice(0, 140), [])
    await store.merge(workspaceId, messages.slice(140), [])
    const snapshot = await store.load(workspaceId)
    expect(snapshot.messages.length).toBeLessThan(280)
    expect(snapshot.messages.length).toBeGreaterThan(200)
    expect(snapshot.messages.at(-1)?.id).toBe("msg_0279")
    expect(snapshot.messages[0]?.id).not.toBe("msg_0000")
    expect(await store.append(messages[0]!)).toBe(false)
    expect((await store.merge(workspaceId, [messages[0]!], [])).added).toHaveLength(0)
    expect((await store.load(workspaceId)).messages).toEqual(snapshot.messages)
  })

  it("Given a read cursor, when older and newer cursors arrive, then stored progress only advances", async () => {
    const store = new ChatStore("read-cursor")
    const first = "2026-09-10T12:00:00.000Z|msg_02"
    const older = "2026-09-10T11:00:00.000Z|msg_01"
    const newer = "2026-09-10T13:00:00.000Z|msg_03"
    expect(await store.readCursor(workspaceId)).toBeNull()
    await store.markRead(workspaceId, first)
    expect(await store.readCursor(workspaceId)).toBe(first)
    await store.markRead(workspaceId, older)
    expect(await store.readCursor(workspaceId)).toBe(first)
    await store.markRead(workspaceId, newer)
    expect(await store.readCursor(workspaceId)).toBe(newer)
  })

  it("Given new or replaced chat content, when a message or profile commits, then content revision advances", async () => {
    const store = new ChatStore("content-revision-changes")
    const initial = await store.readContentRevision(workspaceId)
    expect(revisionCounter(initial)).toBe(0)
    expect(await store.append(message(1))).toBe(true)
    const afterMessage = await store.readContentRevision(workspaceId)
    expect(afterMessage.split(":")[0]).toBe(initial.split(":")[0])
    expect(revisionCounter(afterMessage)).toBe(1)
    expect(await store.putProfile(profile(1))).toBe(true)
    expect(revisionCounter(await store.readContentRevision(workspaceId))).toBe(2)
    expect(await store.putProfile(profile(2))).toBe(true)
    expect(revisionCounter(await store.readContentRevision(workspaceId))).toBe(3)
  })

  it("Given identical merges and read-cursor changes, when only metadata moves, then content revision stays fixed", async () => {
    const store = new ChatStore("content-revision-noop")
    const original = message(2)
    expect((await store.merge(workspaceId, [original], [profile(1)])).changed).toBe(true)
    const revision = await store.readContentRevision(workspaceId)
    expect((await store.merge(workspaceId, [original], [profile(1)])).changed).toBe(false)
    await store.markRead(workspaceId, "2026-09-10T12:00:00.000Z|msg_02")
    expect(await store.readContentRevision(workspaceId)).toBe(revision)
  })

  it("Given retained messages at the count limit, when a newer message evicts the oldest, then content revision advances", async () => {
    const store = new ChatStore("content-revision-eviction")
    const firstBatch = Array.from({ length: 2000 }, (_, index) => message(index))
    await store.merge(workspaceId, firstBatch, [])
    const before = await store.readContentRevision(workspaceId)
    await store.append(message(2000))

    expect(revisionCounter(await store.readContentRevision(workspaceId))).toBe(revisionCounter(before) + 1)
    const snapshot = await store.load(workspaceId)
    expect(snapshot.messages).toHaveLength(2000)
    expect(snapshot.messages[0]?.id).toBe("msg_0001")
  })

  it("Given a failed merge after profile writes are queued, when the transaction aborts, then revision and content stay unchanged", async () => {
    const store = new ChatStore("content-revision-abort")
    const original = message(3)
    await store.append(original)
    const before = await store.readContentRevision(workspaceId)
    const sibling = message(4)
    await expect(store.merge(workspaceId, [sibling, { ...original, body: "conflicting content" }], [profile(1)])).rejects.toThrow(/conflict|immutable/i)
    expect(await store.readContentRevision(workspaceId)).toBe(before)
    const snapshot = await store.load(workspaceId)
    expect(snapshot.profiles).toEqual([])
    expect(snapshot.messages).toEqual([original])
  })

  it("Given saved content revision, when another store instance opens the database, then revision persists", async () => {
    const store = new ChatStore("content-revision-reopen")
    await store.append(message(4))
    const reopened = new ChatStore("content-revision-reopen")
    expect(await reopened.readContentRevision(workspaceId)).toBe(await store.readContentRevision(workspaceId))
  })

  it("Given legacy chat content and cursor without a revision, when revision initializes, then both remain intact", async () => {
    const store = new ChatStore("content-revision-legacy")
    const original = message(5)
    await store.append(original)
    await store.markRead(workspaceId, "2026-09-10T12:00:00.000Z|msg_05")
    await removeContentRevision("content-revision-legacy")

    expect(revisionCounter(await store.readContentRevision(workspaceId))).toBe(0)
    expect(await store.readCursor(workspaceId)).toBe("2026-09-10T12:00:00.000Z|msg_05")
    expect((await store.load(workspaceId)).messages).toEqual([original])
  })

  it("Given content whose metadata row is deleted, when metadata is recreated, then generation prevents revision ABA", async () => {
    const store = new ChatStore("content-revision-generation")
    await store.append(message(6))
    const previous = await store.readContentRevision(workspaceId)
    await deleteWorkspaceMeta("content-revision-generation")

    const recreated = await store.readContentRevision(workspaceId)
    expect(recreated).not.toBe(previous)
    expect(revisionCounter(recreated)).toBe(0)
    expect((await store.load(workspaceId)).messages).toEqual([message(6)])
    expect(await store.append(message(7))).toBe(true)
    expect(revisionCounter(await store.readContentRevision(workspaceId))).toBe(1)
  })
})
