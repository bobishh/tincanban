import { expect, it } from "vitest"
import { buildArchiveIndex } from "@meta-uber/mesh-replication/history-archive"
import { canonicalizeJson, toBase64Url } from "../domain/identity"
import { verifyDecodedPeerHistoryRecoveryCoverage } from "./peerHistoryRecoveryCoverage"
import type { HistoryRecoveryManifest } from "./historyRecoveryArchive"

async function fixture(previousBaselineId?: string) {
  const workspaceId = "workspace", baselineId = "A".repeat(43), objects = new Map<string, Uint8Array>()
  const context = { workspaceId, historyEpoch: previousBaselineId ? 2 : 1, indexId: "catalogue" }
  const root = await buildArchiveIndex(context, [], { read: async id => objects.get(id), write: async (id, bytes) => { objects.set(id, bytes) } })
  const signedJson = new TextEncoder().encode(canonicalizeJson({ payload: { workspaceId, baselineId, historyEpoch: previousBaselineId ? 2 : 1,
    ...(previousBaselineId ? { previousBaselineId } : {}), archive: { context, root } } }))
  const source = { version: 1, workspaceId, baselineId, signedJson: toBase64Url(signedJson) }
  const auxiliary = new Map<string, unknown>([[`peer-history-source/${baselineId}`, source]])
  for (const [id, bytes] of objects) auxiliary.set(`peer-history-object/${baselineId}:${id}`, bytes)
  const decoded = { journal: { receivedBaselines: [{ id: "original", value: { workspaceId, baselineId, signedJson, peerProofs: { version: 1, objects: [] } } }] }, auxiliary }
  const manifest: HistoryRecoveryManifest = { kind: "history-recovery-manifest", version: 1, workspaceId, coverage: "complete",
    sourceCount: 0, objectCount: 0, encryptedBytes: 0, transcriptDigest: "unused", missingObjects: [], unresolvedDirectories: [] }
  return { workspaceId, baselineId, root, decoded, manifest }
}

it("Given an encrypted file claiming complete peer history but missing its signed root, when inspecting coverage, then reject that claim", async () => {
  const f = await fixture()
  f.decoded.auxiliary.delete(`peer-history-object/${f.baselineId}:${f.root.objectId}`)
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, f.manifest, () => {})).rejects.toThrow(/coverage/i)
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, { ...f.manifest, coverage: "incomplete",
    missingPeerObjects: [{ baselineId: f.baselineId, objectId: f.root.objectId }] }, () => {})).resolves.toBeUndefined()
})

it("Given complete locally retained peer history, when inspecting coverage, then verify closure without any remote source", async () => {
  const f = await fixture()
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, f.manifest, () => {})).resolves.toBeUndefined()
  f.decoded.auxiliary.delete(`peer-history-source/${f.baselineId}`)
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, f.manifest, () => {})).rejects.toThrow(/source/i)
})

it("Given a compacted source with an omitted signed parent, when inspecting a complete backup, then reject completeness", async () => {
  const parentBaselineId = "E".repeat(43), f = await fixture(parentBaselineId)
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, f.manifest, () => {})).rejects.toThrow(/parent baseline/i)
})

it("Given a Rusty-only received baseline with an unavailable signed parent, when inspecting a complete backup, then reject completeness", async () => {
  const parentBaselineId = "E".repeat(43), f = await fixture(parentBaselineId)
  f.decoded.auxiliary.clear()
  const receivedRows = f.decoded.journal.receivedBaselines as Array<{ id: string; value: unknown }>
  receivedRows[0]!.value = {
    workspaceId: f.workspaceId,
    baselineId: f.baselineId,
    signedJson: (receivedRows[0]!.value as { signedJson: Uint8Array }).signedJson,
    wire: { version: 1 },
  }
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, f.manifest, () => {})).rejects.toThrow(/parent baseline/i)
})

it("Given an unavailable signed parent, when inspecting an explicitly incomplete backup, then retain that exact gap", async () => {
  const parentBaselineId = "E".repeat(43), f = await fixture(parentBaselineId)
  await expect(verifyDecodedPeerHistoryRecoveryCoverage(f.decoded, { ...f.manifest, coverage: "incomplete",
    missingPeerObjects: [{ baselineId: f.baselineId, objectId: parentBaselineId }] }, () => {})).resolves.toBeUndefined()
})
