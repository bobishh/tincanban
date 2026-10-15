import { expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { createHistoryPreparationStorage } from "../src/historyPreparationStorage"
import { createHistoryPreparationJournal } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyPreparationJournal"
import { canonicalizeJson, publicKeyId, sha256Base64Url, signEnvelope, toBase64Url } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index"
import { archiveCoverageBranch, verifyArchiveCoverageChild } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveCoverage"
import type { HistoryPreparationRemote } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyPreparationJournal"
import { prepareArchiveLocators } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveLocatorPreparation"
import { createLocatedArchiveStore } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveLocators"
import type { EncryptedArchiveObject } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveCrypto"

const namespace = (env as unknown as { AUTOMATION: { getByName(name: string): unknown } }).AUTOMATION
const secret = "history-preparation-storage-secret-with-32-bytes"
async function withStorage(run: (storage: DurableObjectStorage) => Promise<void>) {
  return runInDurableObject(namespace.getByName(`history-preparation-${crypto.randomUUID()}`) as never,
    async (_instance, state) => { await run(state.storage) })
}

it("Given private preparation values, when SQL storage is reopened, then retain exact bytes while key, context and secret substitution fail authentication", async () => {
  await withStorage(async storage => {
    const port = createHistoryPreparationStorage(storage, secret, "instance-one")
    expect(await port.compareAndSwap([{ key: "record-one", expected: undefined }], [{ key: "record-one", value: "PRIVATE-ORIGINAL-SOURCE" }], () => {})).toBe(true)
    const encrypted = storage.sql.exec<{ encrypted_value: string }>("SELECT encrypted_value FROM history_preparation_records WHERE record_key = 'record-one'").one().encrypted_value
    expect(encrypted).not.toContain("PRIVATE-ORIGINAL-SOURCE")
    expect(await createHistoryPreparationStorage(storage, secret, "instance-one").read("record-one")).toBe("PRIVATE-ORIGINAL-SOURCE")
    await expect(createHistoryPreparationStorage(storage, secret, "instance-two").read("record-one")).rejects.toThrow()
    await expect(createHistoryPreparationStorage(storage, secret + "wrong", "instance-one").read("record-one")).rejects.toThrow()
    storage.sql.exec("INSERT INTO history_preparation_records (record_key, encrypted_value) VALUES (?, ?)", "record-two", encrypted)
    await expect(port.read("record-two")).rejects.toThrow()
    expect(storage.sql.exec<{ encrypted_value: string }>("SELECT encrypted_value FROM history_preparation_records WHERE record_key = 'record-two'").one().encrypted_value).toBe(encrypted)
  })
})

it("Given overlapping compare-and-swap attempts and a failing multi-record transaction, when committed, then preserve the winner and roll back every partial write", async () => {
  await withStorage(async storage => {
    const left = createHistoryPreparationStorage(storage, secret, "instance-one")
    const right = createHistoryPreparationStorage(storage, secret, "instance-one")
    const results = await Promise.all([
      left.compareAndSwap([{ key: "winner", expected: undefined }], [{ key: "winner", value: "left" }], () => {}),
      right.compareAndSwap([{ key: "winner", expected: undefined }], [{ key: "winner", value: "right" }], () => {}),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await left.read("winner")).toBe(results[0] ? "left" : "right")
    storage.sql.exec(`CREATE TRIGGER fail_second_preparation BEFORE INSERT ON history_preparation_records
      WHEN NEW.record_key = 'transaction-b' BEGIN SELECT RAISE(ABORT, 'injected quota failure'); END`)
    await expect(left.compareAndSwap([{ key: "transaction-a", expected: undefined }, { key: "transaction-b", expected: undefined }],
      [{ key: "transaction-a", value: "must roll back" }, { key: "transaction-b", value: "fails" }], () => {})).rejects.toThrow(/quota/)
    expect(await left.read("transaction-a")).toBeUndefined()
    expect(await left.read("transaction-b")).toBeUndefined()
    await expect(left.compareAndSwap([{ key: "guarded", expected: undefined }], [{ key: "guarded", value: "must roll back" }],
      () => { throw new Error("Authority changed") })).rejects.toThrow(/Authority changed/)
    expect(await left.read("guarded")).toBeUndefined()
    await expect(left.compareAndSwap([{ key: "async-guarded", expected: undefined }], [{ key: "async-guarded", value: "must not write" }],
      async () => {})).rejects.toThrow(/synchronous/)
    expect(await left.read("async-guarded")).toBeUndefined()
  })
})

it("Given encrypted SQL preparation storage, when data and locator journals reopen after a lost reply, then cold-read exact original bytes through the shared SDK without sender storage", async () => {
  await withStorage(async storage => {
    const port = createHistoryPreparationStorage(storage, secret, "instance-one")
    for (let i = 9; i >= 0; i--) await port.compareAndSwap([{ key: `page-${i}`, expected: undefined }], [{ key: `page-${i}`, value: `value-${i}` }], () => {})
    expect(await port.scan("page-", undefined, 2)).toEqual({ entries: [{ key: "page-0", value: "value-0" }, { key: "page-1", value: "value-1" }], nextAfter: "page-1" })
    expect(await port.scan("page-", "page-8", 2)).toEqual({ entries: [{ key: "page-9", value: "value-9" }], nextAfter: null })
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
    const servicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
    const scope = { scopeId: "opaque-scope", keyEpoch: 1, key: crypto.getRandomValues(new Uint8Array(32)) }
    const identity = { transitionId: crypto.randomUUID(), personId: await publicKeyId(servicePublicKey), workspaceId: "workspace",
      historyEpoch: 1, sourceRevision: "A".repeat(43), authorityRevision: "A".repeat(43), privateBinding: "A".repeat(43), previousBaselineId: null,
      storage: { origin: "https://rusty.example", scopeId: scope.scopeId, keyEpoch: 1, policyRevision: 1, servicePublicKey, keyDigest: await sha256Base64Url(scope.key) } }
    const journal = createHistoryPreparationJournal(identity, port, () => {})
    const bytes = new TextEncoder().encode("exact original retained proof bytes")
    await journal.capture([bytes])
    const binding = { workspaceId: "workspace", historyEpoch: 1, indexId: "originals", objectId: await sha256Base64Url(bytes),
      objectKind: "part" as const, partIndex: 0, partCount: 1 }
    const staged = await journal.stage(scope, binding, bytes)
    const root = { ...binding, objectKind: "page" as const }
    await journal.stage(scope, root, bytes)
    expect((await journal.archive(root)).phase).toBe("archived")
    const reopened = createHistoryPreparationJournal(identity, createHistoryPreparationStorage(storage, secret, "instance-one"), () => {})
    expect(await reopened.stage(scope, binding, bytes)).toEqual(staged)
    const restored: Uint8Array[] = []; for await (const part of await reopened.readSource()) restored.push(part)
    expect(restored).toEqual([bytes])
    const serviceId = await publicKeyId(servicePublicKey), common = { version: 1 as const, serviceId, scopeId: scope.scopeId, policyRevision: 1 }
    const objects = new Map<string, EncryptedArchiveObject>()
    let loseDirectoryReply = false
    const remote: HistoryPreparationRemote = {
      upload: async (object, requestId) => {
        const objectId = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(object)))
        objects.set(objectId, structuredClone(object))
        const receipt = await signEnvelope(keys.privateKey, { ...common, kind: "blind-archive-storage-receipt", requestId,
          objectId, keyEpoch: object.keyEpoch }, serviceId, "RUSTY/2")
        if (loseDirectoryReply) { loseDirectoryReply = false; throw new Error("Directory reply lost") }
        return receipt
      },
      coverage: async (objects, requestId) => signEnvelope(keys.privateKey, { ...common, kind: "blind-archive-coverage-batch-receipt", requestId, objects }, serviceId, "RUSTY/2"),
      aggregate: async (archiveRootId, children, requestId) => {
        const summaries = []
        for (const child of children) summaries.push(await verifyArchiveCoverageChild(child, identity.storage, archiveRootId))
        return signEnvelope(keys.privateKey, { ...common, kind: "blind-archive-coverage-aggregate-receipt", requestId, archiveRootId,
          ...await archiveCoverageBranch(archiveRootId, summaries) }, serviceId, "RUSTY/2")
      },
    }
    expect((await reopened.cover(remote)).phase).toBe("covered")
    expect((await createHistoryPreparationJournal(identity, createHistoryPreparationStorage(storage, secret, "instance-one"), () => {}).read())?.phase).toBe("covered")
    const directoryIdentity = { ...identity, transitionId: crypto.randomUUID() }
    const directory = () => createHistoryPreparationJournal(directoryIdentity, createHistoryPreparationStorage(storage, secret, "instance-one"), () => {})
    loseDirectoryReply = true
    await expect(prepareArchiveLocators({ data: reopened, directory: directory(), scope, remote, ensureCurrent: () => {} })).rejects.toThrow("Directory reply lost")
    const pending = await directory().read()
    expect(pending?.phase).toBe("archived")
    const prepared = await prepareArchiveLocators({ data: reopened, directory: directory(), scope, remote, ensureCurrent: () => {} })
    expect(prepared.directory.phase).toBe("covered")
    expect(prepared.root.root.ciphertextId).toBe(pending!.root!.ciphertextId)
    for (const method of ["read", "readSource", "objects", "locators"] as const) {
      reopened[method] = () => { throw new Error("Sender storage unavailable") }
    }
    const cold = createLocatedArchiveStore(scope, prepared.root, { ensureCurrent: () => {}, download: async id => {
      const object = objects.get(id); if (!object) throw new Error("Remote object missing"); return object
    } })
    const { objectId, ...readBinding } = binding
    expect(await cold.read(objectId, 256 * 1024, readBinding)).toEqual(bytes)
    for (const row of storage.sql.exec<{ encrypted_value: string }>("SELECT encrypted_value FROM history_preparation_records").toArray()) {
      expect(row.encrypted_value).not.toContain("exact original")
      expect(row.encrypted_value).not.toContain(identity.workspaceId)
      expect(row.encrypted_value).not.toContain(toBase64Url(scope.key))
    }
  })
})
