import { expect, it } from "vitest"
import { sha256Base64Url } from "../domain/identity"
import { buildArchiveLocators, archiveLocatorKey } from "@meta-uber/mesh-replication/history-archive-locators"
import { sealArchiveObject, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { exportHistoryRecoveryArchive, type HistoryRecoveryRecord } from "./historyRecoveryArchive"

async function fixture(scopeId = "scope") {
  const scope = { scopeId, keyEpoch: 3, key: new Uint8Array(32).fill(21) }, workspaceId = "workspace"
  const objects = new Map<string, EncryptedArchiveObject>(), entries = []
  for (let index = 0; index < 3; index++) {
    const bytes = new TextEncoder().encode(`original-${index}`), binding = { workspaceId, historyEpoch: 2, indexId: "originals",
      objectId: await sha256Base64Url(bytes), objectKind: "part" as const, partIndex: index, partCount: 3 }
    const sealed = await sealArchiveObject(scope, binding, bytes)
    objects.set(sealed.ciphertextId, sealed.object)
    entries.push({ key: await archiveLocatorKey(binding), ciphertextId: sealed.ciphertextId })
  }
  entries.sort((a, b) => a.key < b.key ? -1 : 1)
  const root = await buildArchiveLocators(scope, { workspaceId, historyEpoch: 2, indexId: "archive-locators" }, entries, {
    ensureCurrent: () => {}, write: async (binding, bytes) => {
      const sealed = await sealArchiveObject(scope, binding, bytes); objects.set(sealed.ciphertextId, sealed.object); return sealed
    },
  })
  return { workspaceId, scope, root, objects, entries, source: { id: `baseline-${scopeId}`, workspaceId, scope, roots: [root],
    signedJson: new TextEncoder().encode("EXACT-ORIGINAL-BASELINE-SIGNATURE"), authorityEvidence: { exact: "retained" } } }
}

it("Given a full source archive, when exporting privately, then retain every original ciphertext and key without changing remote storage", async () => {
  const f = await fixture(), records: HistoryRecoveryRecord[] = [], requested: string[] = []
  const manifest = await exportHistoryRecoveryArchive(f.workspaceId, [f.source], {
    ensureCurrent: () => {}, write: async record => { records.push(record) },
    download: async (_source, id) => { requested.push(id); return f.objects.get(id) },
  })
  expect(manifest.coverage).toBe("complete")
  expect(manifest.objectCount).toBe(f.objects.size)
  expect(new Set(requested).size).toBe(f.objects.size)
  expect(records.filter(record => record.kind === "encrypted-object").map(record => record.ciphertextId).sort()).toEqual([...f.objects.keys()].sort())
  expect(records.find(record => record.kind === "archive-source")).toMatchObject({ keyEpoch: 3, authorityEvidence: { exact: "retained" } })
  expect(records.at(-1)).toEqual(manifest)
})

it("Given a missing original object, when exporting, then list its exact ID and label coverage incomplete", async () => {
  const f = await fixture(), missing = f.entries[1]!.ciphertextId
  f.objects.delete(missing)
  const manifest = await exportHistoryRecoveryArchive(f.workspaceId, [f.source], {
    ensureCurrent: () => {}, write: async () => {}, download: async (_source, id) => f.objects.get(id),
  })
  expect(manifest.coverage).toBe("incomplete")
  expect(manifest.missingObjects).toEqual([{ scopeId: f.scope.scopeId, ciphertextId: missing }])
  expect(manifest.unresolvedDirectories).toEqual([])
})

it("Given a missing directory, when exporting, then disclose unresolved descendants and never label it a complete backup", async () => {
  const f = await fixture()
  f.objects.delete(f.root.root.ciphertextId)
  const manifest = await exportHistoryRecoveryArchive(f.workspaceId, [f.source], {
    ensureCurrent: () => {}, write: async () => {}, download: async (_source, id) => f.objects.get(id),
  })
  expect(manifest.coverage).toBe("incomplete")
  expect(manifest.unresolvedDirectories).toEqual([{ sourceId: f.source.id, ciphertextId: f.root.root.ciphertextId }])
})

it("Given substitution or revoked access, when reading export objects, then abort without a completion manifest", async () => {
  const f = await fixture(), records: HistoryRecoveryRecord[] = []
  await expect(exportHistoryRecoveryArchive(f.workspaceId, [f.source], {
    ensureCurrent: () => {}, write: async record => { records.push(record) },
    download: async () => [...f.objects.values()][0],
  })).rejects.toThrow(/hash|integrity|ciphertext/i)
  expect(records.some(record => record.kind === "history-recovery-manifest")).toBe(false)
  records.length = 0
  let current = true
  await expect(exportHistoryRecoveryArchive(f.workspaceId, [f.source], {
    ensureCurrent: () => { if (!current) throw new Error("Access revoked") }, write: async record => { records.push(record) },
    download: async (_source, id) => { current = false; return f.objects.get(id) },
  })).rejects.toThrow("Access revoked")
  expect(records.some(record => record.kind === "history-recovery-manifest")).toBe(false)
})

it("Given a missing attachment, when exporting history recovery, then use canonical blob IDs and disclose incomplete coverage", async () => {
  const f = await fixture(), id = `sha256:${"A".repeat(43)}`
  const ports = { ensureCurrent: () => {}, write: async () => {}, download: async (_source: unknown, id: string) => f.objects.get(id) }
  const result = await exportHistoryRecoveryArchive(f.workspaceId, [f.source], { ...ports, unavailableAttachments: () => [id, id] })
  expect(result).toMatchObject({ coverage: "incomplete", missingAttachmentIds: [id] })
  await expect(exportHistoryRecoveryArchive(f.workspaceId, [f.source], { ...ports, unavailableAttachments: () => ["invalid-blob-id"] })).rejects.toThrow(/attachment/i)
})

it("Given unavailable peer-only archive objects, when exporting private recovery evidence, then record canonical unique missing pairs and incomplete coverage", async () => {
  const baselineId = await sha256Base64Url(new TextEncoder().encode("peer-baseline"))
  const pairs = await Promise.all(["object-one", "object-two"].map(async label => ({ baselineId,
    objectId: await sha256Base64Url(new TextEncoder().encode(label)) })))
  const records: HistoryRecoveryRecord[] = []
  const result = await exportHistoryRecoveryArchive("peer-workspace", [], { ensureCurrent: () => {},
    write: async record => { records.push(record) }, download: async () => undefined,
    unavailablePeerObjects: () => [pairs[1]!, pairs[0]!, pairs[1]!] })
  const expected = pairs.sort((left, right) => left.objectId < right.objectId ? -1 : 1)
  expect(result).toMatchObject({ coverage: "incomplete", missingPeerObjects: expected, sourceCount: 0 })
  expect(records.at(-1)).toEqual(result)
  await expect(exportHistoryRecoveryArchive("peer-workspace", [], { ensureCurrent: () => {}, write: async () => {},
    download: async () => undefined, unavailablePeerObjects: () => [{ baselineId, objectId: "bad" }] })).rejects.toThrow(/peer|object|coverage/i)
})

it("Given missing ciphertext under case-distinct scopes, when writing coverage, then sort scope identifiers by ordinal order", async () => {
  const upper = await fixture("A"), lower = await fixture("a")
  const manifest = await exportHistoryRecoveryArchive(upper.workspaceId, [lower.source, upper.source], {
    ensureCurrent: () => {}, write: async () => {}, download: async () => undefined,
  })
  expect(manifest.missingObjects.map(entry => entry.scopeId)).toEqual(["A", "a"])
})
