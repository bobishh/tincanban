import { beforeAll, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import { readPeerHistoryRecoveryObject, retainDecodedPeerHistoryRecovery } from "./workspacePeerHistoryRecoveryObjects"

const encoder = new TextEncoder()
type DecodedPeerHistory = { journal: { receivedBaselines: Array<{ id: string; value: unknown }> }; auxiliary: Map<string, unknown> }
beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})

async function fixture() {
  const personId = `person-${crypto.randomUUID()}`, workspaceId = `workspace-${crypto.randomUUID()}`
  const baselineId = await sha256Base64Url(encoder.encode(crypto.randomUUID()))
  const signedJson = encoder.encode(canonicalizeJson({ payload: { workspaceId, baselineId }, signerKeyId: "device", signature: "signed" }))
  const bytes = encoder.encode("exact opaque archive bytes")
  const objectId = await sha256Base64Url(bytes)
  const source = { version: 1 as const, workspaceId, baselineId, signedJson: toBase64Url(signedJson) }
  const decoded: DecodedPeerHistory = { journal: { receivedBaselines: [{ id: `${workspaceId}:baseline:${baselineId}`, value: {
    workspaceId, baselineId, signedJson,
  } }] }, auxiliary: new Map<string, unknown>([
    [`peer-history-source/${baselineId}`, source], [`peer-history-object/${baselineId}:${objectId}`, bytes],
  ]) }
  return { personId, workspaceId, baselineId, signedJson, bytes, objectId, decoded }
}

it("Given decoded peer archive evidence, when retaining and reading it, then preserve immutable bytes under identity, workspace, and baseline", async () => {
  const f = await fixture()
  await retainDecodedPeerHistoryRecovery(f.personId, f.workspaceId, f.decoded, () => {})
  const read = await readPeerHistoryRecoveryObject(f.personId, f.workspaceId, f.baselineId, f.objectId, () => {})
  expect(read).toEqual(f.bytes)
  expect(read).not.toBe(f.bytes)
  expect(await readPeerHistoryRecoveryObject("other-person", f.workspaceId, f.baselineId, f.objectId, () => {})).toBeUndefined()
  expect(await readPeerHistoryRecoveryObject(f.personId, "other-workspace", f.baselineId, f.objectId, () => {})).toBeUndefined()
  expect(await readPeerHistoryRecoveryObject(f.personId, f.workspaceId, "A".repeat(43), f.objectId, () => {})).toBeUndefined()
  const rows = await new BrowserMeshStore("tincanban-private-workspace-recovery-v1", ["records"]).list<unknown>("records")
  expect(JSON.stringify(rows.map(row => row.value))).not.toContain(toBase64Url(f.signedJson))
})

it("Given staged received-history evidence without cached baselineId, when retaining its peer objects, then exact signed routing binds the cache", async () => {
  const f = await fixture(), row = f.decoded.journal.receivedBaselines[0]!
  row.id = `${f.workspaceId}:staged:receive-1`
  row.value = { id: row.id, workspaceId: f.workspaceId, state: "staged", signedJson: f.signedJson }
  await retainDecodedPeerHistoryRecovery(f.personId, f.workspaceId, f.decoded, () => {})
  await expect(readPeerHistoryRecoveryObject(f.personId, f.workspaceId, f.baselineId, f.objectId, () => {})).resolves.toEqual(f.bytes)

  const mismatched = await fixture(), mismatchedRow = mismatched.decoded.journal.receivedBaselines[0]!
  mismatchedRow.id = `${mismatched.workspaceId}:staged:receive-2`
  mismatchedRow.value = { id: mismatchedRow.id, workspaceId: mismatched.workspaceId, state: "staged",
    baselineId: "C".repeat(43), signedJson: mismatched.signedJson }
  await expect(retainDecodedPeerHistoryRecovery(mismatched.personId, mismatched.workspaceId, mismatched.decoded, () => {}))
    .rejects.toThrow(/exact saved baseline signature/i)
})

it("Given mutable decoded bytes, when retention awaits hashing, then persist the captured original object", async () => {
  const f = await fixture()
  const promise = retainDecodedPeerHistoryRecovery(f.personId, f.workspaceId, f.decoded, () => {})
  f.bytes.fill(0)
  await promise
  expect(await readPeerHistoryRecoveryObject(f.personId, f.workspaceId, f.baselineId, f.objectId, () => {})).toEqual(
    encoder.encode("exact opaque archive bytes"))
})

it("Given a source that differs from the original received baseline or an object without source, when retaining, then reject before caching", async () => {
  const f = await fixture()
  const badSource = { ...f.decoded, auxiliary: new Map<string, unknown>(f.decoded.auxiliary) }
  badSource.auxiliary.set(`peer-history-source/${f.baselineId}`, { ...badSource.auxiliary.get(`peer-history-source/${f.baselineId}`) as object,
    signedJson: toBase64Url(encoder.encode("different signature")) })
  await expect(retainDecodedPeerHistoryRecovery(f.personId, f.workspaceId, badSource, () => {})).rejects.toThrow(/signature|source/i)
  const orphan = { ...f.decoded, auxiliary: new Map<string, unknown>([[`peer-history-object/${f.baselineId}:${f.objectId}`, f.bytes]]) }
  await expect(retainDecodedPeerHistoryRecovery(f.personId, f.workspaceId, orphan, () => {})).rejects.toThrow(/source/i)
  expect(await readPeerHistoryRecoveryObject(f.personId, f.workspaceId, f.baselineId, f.objectId, () => {})).toBeUndefined()
})

it("Given an empty peer-object set, when retaining a peer-only recovery, then perform no record writes", async () => {
  const f = await fixture(), store = new BrowserMeshStore("tincanban-private-workspace-recovery-v1", ["records"])
  const before = (await store.list<unknown>("records")).length
  await retainDecodedPeerHistoryRecovery(f.personId, f.workspaceId, { journal: { receivedBaselines: [] }, auxiliary: new Map() }, () => {})
  expect((await store.list<unknown>("records")).length).toBe(before)
})
