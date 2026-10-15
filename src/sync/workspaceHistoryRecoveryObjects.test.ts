import { beforeAll, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import type { HistoryRecoveryRecord } from "./historyRecoveryArchive"
import { listWorkspaceRecoveryObjectIndex, listWorkspaceRecoveryObjectIndexes, readWorkspaceRecoveryObject, retainWorkspaceRecoveryObjects } from "./workspaceHistoryRecoveryObjects"

const encoder = new TextEncoder()
beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})

async function fixture() {
  const personId = `person-${crypto.randomUUID()}`, workspaceId = `workspace-${crypto.randomUUID()}`
  const recoveryId = crypto.randomUUID(), scopeId = `scope-${crypto.randomUUID()}`.slice(0, 128)
  const object = { version: 1 as const, scopeId, keyEpoch: 2, nonce: toBase64Url(new Uint8Array(12).fill(4)),
    ciphertext: toBase64Url(new Uint8Array(32).fill(7)) }
  const ciphertextId = await sha256Base64Url(encoder.encode(canonicalizeJson(object)))
  const records: HistoryRecoveryRecord[] = [
    { kind: "archive-source", id: "source-one", workspaceId, scopeId, keyEpoch: 2, key: toBase64Url(new Uint8Array(32).fill(9)),
      roots: [], signedJson: "e30", authorityEvidence: { signed: true } },
    { kind: "encrypted-object", scopeId, ciphertextId, object },
    { kind: "history-recovery-manifest", version: 1, workspaceId, coverage: "complete", sourceCount: 1,
      objectCount: 1, encryptedBytes: encoder.encode(canonicalizeJson(object)).length, transcriptDigest: "A".repeat(43),
      missingObjects: [], unresolvedDirectories: [] },
  ]
  return { personId, workspaceId, recoveryId, scopeId, ciphertextId, object, records }
}

it("Given matching archive source and opaque ciphertext, when retaining recovery objects, then store only immutable ciphertext and expose a bound index", async () => {
  const f = await fixture()
  await retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, f.records, () => {})
  await expect(readWorkspaceRecoveryObject(f.personId, f.scopeId, f.ciphertextId, () => {})).resolves.toEqual(f.object)
  await expect(listWorkspaceRecoveryObjectIndex(f.personId, f.workspaceId, f.recoveryId, () => {})).resolves.toEqual({
    personId: f.personId, workspaceId: f.workspaceId, recoveryId: f.recoveryId,
    objects: [{ scopeId: f.scopeId, ciphertextId: f.ciphertextId }],
  })
  await expect(listWorkspaceRecoveryObjectIndexes(f.personId, f.workspaceId, () => {})).resolves.toEqual([
    { personId: f.personId, workspaceId: f.workspaceId, recoveryId: f.recoveryId,
      objects: [{ scopeId: f.scopeId, ciphertextId: f.ciphertextId }] },
  ])
  const saved = await readWorkspaceRecoveryObject(f.personId, f.scopeId, f.ciphertextId, () => {})
  expect(saved).not.toHaveProperty("key")
  expect(saved).not.toHaveProperty("readToken")
  const records = await new BrowserMeshStore("tincanban-private-workspace-recovery-v1", ["records"]).list<unknown>("records")
  expect(JSON.stringify(records.map(entry => entry.value))).not.toContain((f.records[0] as Extract<HistoryRecoveryRecord, { kind: "archive-source" }>).key)
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, f.records, () => {})).resolves.toBeUndefined()
})

it("Given one scope archived at multiple key epochs, when retaining ciphertext, then accept each source-backed epoch", async () => {
  const f = await fixture()
  const source = f.records[0] as Extract<HistoryRecoveryRecord, { kind: "archive-source" }>
  const nextObject = { ...f.object, keyEpoch: 3, nonce: toBase64Url(new Uint8Array(12).fill(8)) }
  const nextId = await sha256Base64Url(encoder.encode(canonicalizeJson(nextObject)))
  const records: HistoryRecoveryRecord[] = [
    source,
    { ...source, id: "source-next-epoch", keyEpoch: 3, key: toBase64Url(new Uint8Array(32).fill(10)) },
    f.records[1]!,
    { kind: "encrypted-object", scopeId: f.scopeId, ciphertextId: nextId, object: nextObject },
  ]
  await retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, records, () => {})
  await expect(readWorkspaceRecoveryObject(f.personId, f.scopeId, nextId, () => {})).resolves.toEqual(nextObject)
})

it("Given ciphertext without a matching source scope and epoch, when retaining objects, then reject before publishing an index", async () => {
  const f = await fixture()
  const noSource = f.records.filter(record => record.kind !== "archive-source")
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, noSource, () => {})).rejects.toThrow(/source|scope/i)
  const wrongEpoch = f.records.map(record => record.kind === "archive-source" ? { ...record, keyEpoch: 1 } : record)
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, wrongEpoch, () => {})).rejects.toThrow(/epoch|scope/i)
  await expect(listWorkspaceRecoveryObjectIndex(f.personId, f.workspaceId, f.recoveryId, () => {})).resolves.toBeUndefined()
})

it("Given a backup with no archive sources or ciphertext, when retaining peer-only workspace evidence, then allow the empty object set", async () => {
  const f = await fixture()
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, [], () => {})).resolves.toBeUndefined()
  const orphan = f.records.filter(record => record.kind === "encrypted-object")
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, crypto.randomUUID(), orphan, () => {})).rejects.toThrow(/source|scope/i)
})

it("Given a ciphertext ID paired with changed envelope bytes, when retaining, then reject the hash mismatch without replacing the original", async () => {
  const f = await fixture()
  await retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, f.records, () => {})
  const changed = structuredClone(f.records).map(record => record.kind === "encrypted-object"
    ? { ...record, object: { ...record.object, nonce: toBase64Url(new Uint8Array(12).fill(5)) } } : record)
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, crypto.randomUUID(), changed, () => {})).rejects.toThrow(/ID|ciphertext|hash/i)
  await expect(readWorkspaceRecoveryObject(f.personId, f.scopeId, f.ciphertextId, () => {})).resolves.toEqual(f.object)
})

it("Given a guard that becomes stale during retention, when persisting, then leave no workspace index", async () => {
  const f = await fixture(); let calls = 0
  await expect(retainWorkspaceRecoveryObjects(f.personId, f.workspaceId, f.recoveryId, f.records, () => {
    if (++calls === 4) throw new Error("profile changed")
  })).rejects.toThrow(/profile changed/)
  await expect(listWorkspaceRecoveryObjectIndex(f.personId, f.workspaceId, f.recoveryId, () => {})).resolves.toBeUndefined()
})
