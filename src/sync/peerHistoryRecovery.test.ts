import { expect, it } from "vitest"
import { writeArchiveBytes, buildArchiveIndex } from "@meta-uber/mesh-replication/history-archive"
import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import { createPeerHistoryRecoveryEvidence } from "./peerHistoryRecovery"

async function drain(evidence: AsyncIterable<{ data: string }>): Promise<number> {
  let records = 0
  for await (const part of evidence) { if (!part.data) throw new Error("Invalid peer recovery record"); records++ }
  return records
}

async function fixture() {
  const workspaceId = "workspace", baselineId = "A".repeat(43)
  const context = { workspaceId, historyEpoch: 1, indexId: "catalogue" }
  const objects = new Map<string, Uint8Array>()
  const store = { read: async (id: string) => objects.get(id)?.slice(), write: async (id: string, bytes: Uint8Array) => { objects.set(id, bytes.slice()) } }
  const original = new Uint8Array(300_000).fill(17)
  const reference = await writeArchiveBytes({ ...context, indexId: "source-document" }, [original.subarray(0, 256 * 1024), original.subarray(256 * 1024)], store)
  const bytes = new TextEncoder().encode(canonicalizeJson(reference)), objectId = await sha256Base64Url(bytes)
  objects.set(objectId, bytes)
  const root = await buildArchiveIndex(context, [{ key: "document", objectId }], store)
  const signedJson = new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId, baselineId, historyEpoch: 1, archive: { context, root } } }))
  return { workspaceId, baselineId, objects, signedJson, source: { workspaceId, baselineId, signedJson, read: store.read } }
}

async function completeFixture(wrongEntityVersion = false) {
  const workspaceId = "complete-peer-workspace", baselineId = "A".repeat(43), historyEpoch = 1, hash = "a".repeat(64)
  const context = { workspaceId, historyEpoch, indexId: "catalogue" }, objects = new Map<string, Uint8Array>()
  const bindings: string[] = []
  const store = { read: async (id: string) => objects.get(id)?.slice(), write: async (id: string, bytes: Uint8Array) => { objects.set(id, bytes.slice()) } }
  const child = (indexId: string) => ({ ...context, indexId })
  const bytes = (indexId: string, value: string) => writeArchiveBytes(child(indexId), [new TextEncoder().encode(value)], store)
  const record = async (value: unknown) => {
    const encoded = new TextEncoder().encode(canonicalizeJson(value)), id = await sha256Base64Url(encoded)
    objects.set(id, encoded)
    return id
  }
  const control = await record(await bytes("source-control", "original control"))
  const document = await record(await bytes("source-document", "original raw document"))
  const proof = await record(await bytes("source-proof/0000000000000000", "original proof"))
  const pending = await record(await bytes("source-pending/0000000000000000", "original pending"))
  const original = await bytes(`change/${hash}/bytes`, "exact original change")
  const dependencies = await bytes(`change/${hash}/dependencies`, "[]")
  const authorizations = await buildArchiveIndex(child(`change/${hash}/authorizations`), [{ key: "0000000000000000", objectId: proof }], store)
  const captured = await record({ kind: "workspace-history-archive-record", version: 1, workspaceId, historyEpoch, hash,
    bytes: original, dependencies, dependencyCount: 0, authorizations,
    observation: { type: "pending", reason: "preserved original classification" },
    captureRevision: "capture", admissionRevision: "admission", authorityRevision: "authority", admissionPolicy: "mesh-causal-admission@3",
    metadata: { time: 10, actor: "11", action: "change", entityIds: ["legacy-item"], imported: true,
      personId: null, deviceId: null, message: null } })
  const entityDigest = await sha256Base64Url(new TextEncoder().encode("legacy-item"))
  const entityContext = child(`entity/${entityDigest}/versions`)
  const reverseTime = (((1n << 64n) - 1n) - (10n ^ (1n << 63n))).toString(16).padStart(16, "0")
  const entityRoot = await buildArchiveIndex(entityContext, [{ key: `${reverseTime}/${hash}`,
    objectId: wrongEntityVersion ? proof : captured }], store)
  const entity = await record({ kind: "workspace-history-entity-index", version: 1, entityId: "legacy-item", context: entityContext, root: entityRoot })
  const entries = [{ key: `change/${hash}`, objectId: captured }, { key: "control", objectId: control }, { key: "document", objectId: document },
    { key: `entity/${entityDigest}`, objectId: entity }, { key: "pending/0000000000000000", objectId: pending }, { key: "proof/0000000000000000", objectId: proof }]
  const root = await buildArchiveIndex(context, entries, store)
  const signedJson = new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId, baselineId, historyEpoch,
    admissionPolicy: "mesh-causal-admission@3", archive: { context, root, captureRevision: "capture", admissionRevision: "admission", authorityRevision: "authority" } } }))
  return { baselineId, objects, bindings, source: { workspaceId, baselineId, signedJson,
    read: async (id: string, binding: { indexId: string }) => { bindings.push(binding.indexId); return objects.get(id)?.slice() } } }
}

it("Given an authorized peer archive, when making private recovery evidence, then retain its full content-addressed closure rather than only bootstrap proofs", async () => {
  const f = await fixture(), archive = createPeerHistoryRecoveryEvidence([f.source], () => {})
  const records = []
  for await (const part of archive.evidence) records.push(part)
  expect(archive.missingObjects()).toEqual([])
  expect(records.find(part => part.category === "peer-history-source")).toMatchObject({ id: f.baselineId })
  const retained = records.filter(part => part.category === "peer-history-object")
  expect(retained.map(part => part.id).sort()).toEqual([...f.objects.keys()].map(id => `${f.baselineId}:${id}`).sort())
  expect(retained.every(part => part.data === toBase64Url(f.objects.get(part.id.split(":")[1]!)!))).toBe(true)
})

it("Given every Native catalogue record kind, when exporting, then traverse control/document/change/dependency/proof/pending/authorization/entity trees with their exact contexts", async () => {
  const f = await completeFixture(), archive = createPeerHistoryRecoveryEvidence([f.source], () => {}), retained = []
  for await (const part of archive.evidence) retained.push(part)
  expect(archive.missingObjects()).toEqual([])
  expect(retained.filter(part => part.category === "peer-history-object").map(part => part.id).sort())
    .toEqual([...f.objects.keys()].map(id => `${f.baselineId}:${id}`).sort())
  for (const context of ["source-control", "source-document", "source-proof/0000000000000000", "source-pending/0000000000000000",
    `change/${"a".repeat(64)}/bytes`, `change/${"a".repeat(64)}/dependencies`, `change/${"a".repeat(64)}/authorizations`]) {
    expect(f.bindings).toContain(context)
  }
})

it("Given an entity version pointing outside its original catalogue change, when exporting, then refuse the corrupt reference", async () => {
  const f = await completeFixture(true), archive = createPeerHistoryRecoveryEvidence([f.source], () => {})
  await expect(drain(archive.evidence))
    .rejects.toThrow(/entity|original catalogue/i)
})

it("Given an offline peer and only its catalogue page cached, when exporting, then disclose the exact missing reference and finish remaining evidence", async () => {
  const f = await fixture(), envelope = JSON.parse(new TextDecoder().decode(f.signedJson))
  const root = envelope.payload.archive.root.objectId
  const missing = [...f.objects.keys()].filter(id => id !== root)
  for (const id of missing) f.objects.delete(id)
  const archive = createPeerHistoryRecoveryEvidence([f.source], () => {})
  expect(await drain(archive.evidence)).toBeGreaterThan(0)
  expect(archive.missingObjects()).toHaveLength(1)
  expect(missing).toContain(archive.missingObjects()[0]!.objectId)
})

it("Given substituted peer content or lost access, when exporting, then abort rather than label corrupted bytes missing", async () => {
  const f = await fixture()
  const bad = createPeerHistoryRecoveryEvidence([{ ...f.source, read: async () => new Uint8Array([1]) }], () => {})
  await expect(drain(bad.evidence)).rejects.toThrow(/hash|integrity/i)
  let current = true
  const revoked = createPeerHistoryRecoveryEvidence([{ ...f.source, read: async id => { current = false; return f.objects.get(id) } }], () => {
    if (!current) throw new Error("Access revoked")
  })
  await expect(drain(revoked.evidence)).rejects.toThrow("Access revoked")
})

it("Given a missing byte-index leaf, when exporting its siblings, then retain the available closure and name the missing parent page", async () => {
  const f = await fixture()
  const context = { workspaceId: f.workspaceId, historyEpoch: 1, indexId: "source-document" }
  const store = { read: f.source.read, write: async (id: string, bytes: Uint8Array) => { f.objects.set(id, bytes.slice()) } }
  const chunks = Array.from({ length: 66 }, (_, index) => new Uint8Array(256 * 1024).fill(index))
  const reference = await writeArchiveBytes(context, chunks, store)
  const page = JSON.parse(new TextDecoder().decode(f.objects.get(reference.root.objectId))) as { children: Array<{ objectId: string }> }
  const missing = page.children[0]!.objectId
  const available = page.children.at(-1)!.objectId
  f.objects.delete(missing)
  const raw = new TextEncoder().encode(canonicalizeJson(reference)), objectId = await sha256Base64Url(raw)
  f.objects.set(objectId, raw)
  const root = await buildArchiveIndex({ ...context, indexId: "catalogue" }, [{ key: "document", objectId }], store)
  const signedJson = new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId: f.workspaceId, baselineId: f.baselineId,
    historyEpoch: 1, archive: { context: { ...context, indexId: "catalogue" }, root } } }))
  const archive = createPeerHistoryRecoveryEvidence([{ ...f.source, signedJson }], () => {})
  const retained = []
  for await (const part of archive.evidence) retained.push(part)
  expect(archive.missingObjects()).toEqual([{ baselineId: f.baselineId, objectId: missing }])
  expect(retained.some(part => part.id === `${f.baselineId}:${available}`)).toBe(true)
})

it("Given a mutable read buffer changed during an asynchronous guard, when exporting, then retain the exact hash-verified snapshot", async () => {
  const f = await fixture()
  let returned: Uint8Array | undefined
  const archive = createPeerHistoryRecoveryEvidence([{ ...f.source, read: async id => {
    returned = f.objects.get(id)?.slice()
    return returned
  } }], async () => {
    if (returned) { returned.fill(0); returned = undefined }
  })
  const parts = []
  for await (const part of archive.evidence) parts.push(part)
  expect(archive.missingObjects()).toEqual([])
  expect(parts.filter(part => part.category === "peer-history-object").every(part =>
    part.data === toBase64Url(f.objects.get(part.id.split(":")[1]!)!))).toBe(true)
})
