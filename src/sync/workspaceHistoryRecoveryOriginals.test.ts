import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { restoreWorkspaceRecoveryOriginals } from "./workspaceHistoryRecoveryOriginals"
import { WORKSPACE_RECOVERY_STORES } from "../workspaceRecoveryStores"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
function fixture() {
  const workspaceId = "originals-workspace", baselineId = "A".repeat(43)
  const document = Automerge.from({ id: workspaceId, title: "Original" })
  const changeBytes = Automerge.getAllChanges(document)[0]!, changeHash = Automerge.decodeChange(changeBytes).hash
  const proof = { payload: { kind: "change-proof", version: 1, documentId: workspaceId, changeHash }, signature: "original-signature" }
  const receipt = { transactionId: "original-transaction", beforeHeads: [], afterHeads: [changeHash], changeHash, changedEntityIds: [], saved: true }
  const journal = {} as WorkspaceRecoveryJournal
  for (const store of WORKSPACE_RECOVERY_STORES) journal[store] = []
  journal.deltas.push({ id: "old-delta", value: { id: "old-delta", workspaceId, generation: "old-generation", savedAt: "original-time",
    command: { changeBytes, proof, receipt } } })
  return { workspaceId, baselineId, document, journal, changeBytes, changeHash, proof, receipt }
}

it("Given deltas from an archived generation, when recovering a compact workspace, then retain originals and retry receipts without rebuilding an unbounded active tail", () => {
  const f = fixture(), original = structuredClone(f.journal)
  f.journal.frontiers.push({ id: f.workspaceId, value: { id: f.workspaceId, workspaceId: f.workspaceId, generation: "current-generation" } })
  const restored = restoreWorkspaceRecoveryOriginals(f.journal, f.workspaceId, f.baselineId)
  expect(restored.changes).toEqual([])
  expect(restored.archivedChanges).toEqual([{ id: `${f.workspaceId}:${f.changeHash}`, value: {
    id: `${f.workspaceId}:${f.changeHash}`, workspaceId: f.workspaceId, changeHash: f.changeHash,
    bytes: f.changeBytes, addedAt: "original-time", archivedUnderBaselineId: f.baselineId,
  } }])
  expect(restored.proofs[0]!.value).toMatchObject({ proof: f.proof })
  expect(restored.receipts[0]!.value).toMatchObject({ receipt: f.receipt })
  expect(f.journal.deltas).toEqual(original.deltas)
  Automerge.free(f.document)
})

it("Given current delta originals and archived authorization evidence, when recovering, then keep each in its intended partition", () => {
  const f = fixture()
  f.journal.frontiers.push({ id: f.workspaceId, value: { id: f.workspaceId, workspaceId: f.workspaceId, generation: "old-generation" } })
  const row = { id: `${f.workspaceId}:baseline:${f.baselineId}`, value: { id: `${f.workspaceId}:baseline:${f.baselineId}`,
    workspaceId: f.workspaceId, baselineId: f.baselineId, records: [{ signature: "unchanged-original-proof" }] } }
  f.journal.archivedAuthorizations.push(row)
  const restored = restoreWorkspaceRecoveryOriginals(f.journal, f.workspaceId, f.baselineId)
  expect(restored.changes).toHaveLength(1)
  expect(restored.archivedChanges).toEqual([])
  expect(restored.archivedAuthorizations).toEqual([row])
  expect(restored.archivedAuthorizations[0]!.value).not.toBe(row.value)
  Automerge.free(f.document)
})

it("Given substituted archive bytes or another workspace, when recovering originals, then reject without producing candidate rows", () => {
  const f = fixture(), id = `${f.workspaceId}:${f.changeHash}`
  f.journal.archivedChanges.push({ id, value: { id, workspaceId: f.workspaceId, changeHash: "0".repeat(64),
    bytes: f.changeBytes, archivedUnderBaselineId: f.baselineId } })
  expect(() => restoreWorkspaceRecoveryOriginals(f.journal, f.workspaceId, f.baselineId)).toThrow(/hash|binding/i)
  f.journal.archivedChanges = []
  expect(() => restoreWorkspaceRecoveryOriginals(f.journal, "another-workspace", f.baselineId)).toThrow(/workspace/i)
  Automerge.free(f.document)
})
