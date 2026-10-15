import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import { sha256Base64Url, toBase64Url } from "../domain/identity"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { readPeerHistoryRecoveryObject } from "./workspacePeerHistoryRecoveryObjects"
import type { PeerHistoryRecoverySource } from "./peerHistoryRecovery"
import type { StoredReceivedHistoryBaseline } from "../storageJournal"

export type PeerHistoryRemoteRead = (workspaceId: string, baselineId: string, objectId: string, binding: ArchiveObjectReadBinding) => Promise<Uint8Array | undefined>
export type WorkspacePeerHistoryRecoverySource = PeerHistoryRecoverySource & { row: StoredReceivedHistoryBaseline }

/** Same authorized workspace reading scope as live sync. Public proof bytes convey no Rusty credentials. */
export async function workspacePeerHistoryRecoverySources(personId: string, workspaceId: string,
  ensureCurrent: () => void | Promise<void>, remote?: PeerHistoryRemoteRead): Promise<WorkspacePeerHistoryRecoverySource[]> {
  await ensureCurrent()
  const rows = await createReceivedHistoryBaselineRepository(workspaceId, () => {}).readArchiveRecords()
  await ensureCurrent()
  const sources = new Map<string, WorkspacePeerHistoryRecoverySource>()
  for (const row of rows) {
    if (!row.peerProofs) continue
    const source = await capturePeerSource(personId, workspaceId, row, ensureCurrent, remote)
    const previous = sources.get(source.baselineId)
    if (previous) { await assertSamePeerSource(previous, source); continue }
    sources.set(source.baselineId, source)
    if (sources.size > 256) throw new Error("Too many peer history recovery sources")
  }
  await ensureCurrent()
  return [...sources.values()]
}

async function capturePeerSource(personId: string, workspaceId: string, row: StoredReceivedHistoryBaseline,
  ensureCurrent: () => void | Promise<void>, remote?: PeerHistoryRemoteRead): Promise<WorkspacePeerHistoryRecoverySource> {
  const payload = peerPayload(row, workspaceId)
  const proofs = new Map(row.peerProofs!.objects.map(object => [object.objectId, object.bytes]))
  return { workspaceId, baselineId: payload.baselineId, signedJson: row.signedJson.slice(), row: structuredClone(row),
    read: async (objectId, binding) => {
      await ensureCurrent()
      if (binding.workspaceId !== workspaceId || binding.historyEpoch !== payload.historyEpoch) throw new Error("Peer history request belongs to another source")
      const local = proofs.get(objectId)?.slice() ?? await readPeerHistoryRecoveryObject(personId, workspaceId, payload.baselineId, objectId, () => {})
      await ensureCurrent()
      if (local || !remote) return local
      const bytes = (await remote(workspaceId, payload.baselineId, objectId, structuredClone(binding)))?.slice()
      await ensureCurrent()
      return bytes
    } }
}
function peerPayload(row: StoredReceivedHistoryBaseline, workspaceId: string): { baselineId: string; historyEpoch: number } {
  if (row.workspaceId !== workspaceId || row.peerProofs?.version !== 1 || !Array.isArray(row.peerProofs.objects)) {
    throw new Error("Saved peer history source is malformed")
  }
  const payload = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.signedJson)) as {
    payload: { workspaceId: string; baselineId: string; historyEpoch: number }
  }).payload
  const baselineId = payload?.baselineId
  if (payload?.workspaceId !== workspaceId || typeof baselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(baselineId) ||
      row.baselineId !== undefined && row.baselineId !== baselineId || !Number.isSafeInteger(payload.historyEpoch)) {
    throw new Error("Saved peer source differs from its signature routing")
  }
  return { baselineId, historyEpoch: payload.historyEpoch }
}
async function assertSamePeerSource(previous: WorkspacePeerHistoryRecoverySource, source: WorkspacePeerHistoryRecoverySource): Promise<void> {
  if (toBase64Url(previous.signedJson) !== toBase64Url(source.signedJson) ||
      await sha256Base64Url(previous.row.document) !== await sha256Base64Url(source.row.document)) {
    throw new Error("Saved peer baseline has conflicting original evidence")
  }
}
