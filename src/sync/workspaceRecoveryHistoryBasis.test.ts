import { expect, it, vi } from "vitest"
import type { StoredReceivedHistoryBaseline, StoredWorkspaceSnapshot } from "../storageJournal"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"
import { recoverySnapshotHistoryBasis, verifyRecoveryHistoryLineage } from "./workspaceRecoveryHistoryBasis"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

const firstId = "A".repeat(43), secondId = "B".repeat(43), siblingId = "C".repeat(43)
function source(baselineId: string, state: StoredReceivedHistoryBaseline["state"] = "active") {
  const id = `board:baseline:${baselineId}`
  return { id, value: { id, workspaceId: "board", state, baselineId,
    signedJson: new TextEncoder().encode(JSON.stringify({ payload: { baselineId } })), document: new Uint8Array([1]),
    pinnedStorage: {} } }
}
function journal(rows: ReturnType<typeof source>[]) { return { receivedBaselines: rows } as WorkspaceRecoveryJournal }
function snapshot(baselineId?: string) {
  return { workspaceId: "board", ...(baselineId ? { receivedHistory: { baselineId, excludedLocalChangeHashes: [] } } : {}) } as StoredWorkspaceSnapshot
}

it("Given two retained accepted generations, When recovering the newer snapshot, Then select its exact basis without dropping the parent", () => {
  const parent = source(firstId), active = source(secondId), rows = [parent, active]
  expect(recoverySnapshotHistoryBasis(journal(rows), snapshot(secondId))).toBe(active.value)
  expect(rows).toEqual([parent, active])
})
it("Given an abandoned signed sibling, When recovering the accepted snapshot, Then never select the sibling by state or position", () => {
  const active = source(secondId)
  expect(recoverySnapshotHistoryBasis(journal([source(siblingId, "restored"), source(firstId), active]), snapshot(secondId))).toBe(active.value)
})
it("Given a snapshot pointer naming only a different retained row, Then refuse its forged active marker", () => {
  expect(() => recoverySnapshotHistoryBasis(journal([source(firstId)]), snapshot(secondId))).toThrow(/matching|active.*basis/i)
})
it("Given duplicate candidates for the exact active ID, Then refuse ambiguous original evidence", () => {
  expect(() => recoverySnapshotHistoryBasis(journal([source(secondId), source(secondId)]), snapshot(secondId))).toThrow(/ambiguous|duplicate/i)
})
it("Given a raw snapshot with retained historical rows, Then never promote an archival row to its basis", () => {
  expect(recoverySnapshotHistoryBasis(journal([source(firstId)]), snapshot())).toBeUndefined()
})

function verifiedBasis(id: string, previousBaselineId: string | null) {
  const free = vi.fn(), verifyPreviousBaseline = vi.fn<(candidate: WasmVerifiedReceivedHistoryBaseline) => void>()
  const value = { envelope: () => ({ payload: { baselineId: id, previousBaselineId } }), free, verifyPreviousBaseline }
  return { value: value as unknown as WasmVerifiedReceivedHistoryBaseline, free, verifyPreviousBaseline }
}
it("Given two independently verified generations and an unrelated sibling, Then Native must verify their exact signed edge and the originals remain retained", async () => {
  const parent = source(firstId), sibling = source(siblingId, "restored"), active = source(secondId)
  const rows = [sibling, parent, active], childBasis = verifiedBasis(secondId, firstId), parentBasis = verifiedBasis(firstId, null)
  const verify = vi.fn(async () => parentBasis.value)
  await verifyRecoveryHistoryLineage(journal(rows), "board", childBasis.value, verify, () => {})
  expect(verify).toHaveBeenCalledExactlyOnceWith(parent.value)
  expect(childBasis.verifyPreviousBaseline).toHaveBeenCalledExactlyOnceWith(parentBasis.value)
  expect(parentBasis.free).toHaveBeenCalledOnce()
  expect(childBasis.free).not.toHaveBeenCalled()
  expect(rows).toEqual([sibling, parent, active])
})
it("Given a retained predecessor with forged original evidence, Then its verifier failure aborts recovery", async () => {
  const child = verifiedBasis(secondId, firstId)
  await expect(verifyRecoveryHistoryLineage(journal([source(firstId)]), "board", child.value,
    async () => { throw new Error("Native signature invalid") }, () => {})).rejects.toThrow("Native signature invalid")
  expect(child.verifyPreviousBaseline).not.toHaveBeenCalled()
})
it("Given two valid standalone bases with an incompatible control edge, Then propagate Native rejection and release the candidate parent", async () => {
  const child = verifiedBasis(secondId, firstId), parent = verifiedBasis(firstId, null)
  child.verifyPreviousBaseline.mockImplementation(() => { throw new Error("Native predecessor control mismatch") })
  await expect(verifyRecoveryHistoryLineage(journal([source(firstId)]), "board", child.value,
    async () => parent.value, () => {})).rejects.toThrow("Native predecessor control mismatch")
  expect(parent.free).toHaveBeenCalledOnce()
  expect(child.free).not.toHaveBeenCalled()
})
