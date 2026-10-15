import type { StoredReceivedHistoryBaseline, StoredWorkspaceSnapshot } from "../storageJournal"
import type { WorkspaceRecoveryJournal } from "./workspaceHistoryRecoveryDecode"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

function retainedBasis(journal: WorkspaceRecoveryJournal, workspaceId: string, baselineId: string): StoredReceivedHistoryBaseline | undefined {
  const matches = journal.receivedBaselines.filter(row => row.value && typeof row.value === "object" &&
    (row.value as StoredReceivedHistoryBaseline).baselineId === baselineId)
  if (matches.length > 1) throw new Error("Recovery history basis has ambiguous duplicate evidence")
  const row = matches[0], stored = row?.value as StoredReceivedHistoryBaseline | undefined
  if (!stored) return undefined
  if (stored.id !== row!.id || stored.workspaceId !== workspaceId || !["active", "staged", "restored"].includes(stored.state) ||
      !(stored.signedJson instanceof Uint8Array) || !(stored.document instanceof Uint8Array) ||
      !stored.pinnedStorage || typeof stored.pinnedStorage !== "object" || Array.isArray(stored.pinnedStorage)) {
    throw new Error("Recovery compact baseline metadata is malformed")
  }
  return stored
}

export function recoverySnapshotHistoryBasis(journal: WorkspaceRecoveryJournal, snapshot: StoredWorkspaceSnapshot): StoredReceivedHistoryBaseline | undefined {
  if (!snapshot.receivedHistory) return undefined
  const baselineId = snapshot.receivedHistory.baselineId
  if (!/^[A-Za-z0-9_-]{43}$/.test(baselineId)) throw new Error("Recovery active basis pointer is malformed")
  const stored = retainedBasis(journal, snapshot.workspaceId, baselineId)
  if (!stored || stored.state !== "active") throw new Error("Recovery snapshot has no matching active history basis")
  return stored
}

/** Only signed Native predecessor edges make retained rows part of this snapshot's history. */
export async function verifyRecoveryHistoryLineage(journal: WorkspaceRecoveryJournal, workspaceId: string,
  active: WasmVerifiedReceivedHistoryBaseline, verify: (stored: StoredReceivedHistoryBaseline) => Promise<WasmVerifiedReceivedHistoryBaseline>,
  ensureCurrent: () => void): Promise<void> {
  let current = active
  const visited = new Set<string>()
  try {
    for (let depth = 0; depth < 256; depth++) {
      ensureCurrent()
      const payload = (current.envelope() as { payload: { previousBaselineId?: unknown } }).payload
      const id = payload.previousBaselineId
      if (id === undefined || id === null) return
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id) || visited.has(id)) throw new Error("Recovery history lineage is malformed")
      visited.add(id)
      const stored = retainedBasis(journal, workspaceId, id)
      // Missing historical rows stay missing coverage; they cannot authorize the active document.
      if (!stored) return
      const parent = await verify(stored)
      try { current.verifyPreviousBaseline(parent); ensureCurrent() }
      catch (error) { parent.free(); throw error }
      if (current !== active) current.free()
      current = parent
    }
    throw new Error("Recovery history lineage exceeds its bound")
  } finally { if (current !== active) current.free() }
}
