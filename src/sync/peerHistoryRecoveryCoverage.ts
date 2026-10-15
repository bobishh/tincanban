import { canonicalizeJson, fromBase64Url, toBase64Url } from "../domain/identity"
import { createPeerHistoryRecoveryEvidence, type PeerHistoryRecoverySource } from "./peerHistoryRecovery"
import type { HistoryRecoveryManifest, HistoryRecoveryRecord } from "./historyRecoveryArchive"

type Decoded = { journal: { receivedBaselines: Array<{ id: string; value: unknown }> }; auxiliary: Map<string, unknown> }

function readSources(decoded: Decoded, manifest: HistoryRecoveryManifest, ensureCurrent: () => void): PeerHistoryRecoverySource[] {
  const sources: PeerHistoryRecoverySource[] = []
  for (const [key, input] of decoded.auxiliary) {
    if (!key.startsWith("peer-history-source/")) continue
    const source = input as { workspaceId: string; baselineId: string; signedJson: string }
    if (!source || source.workspaceId !== manifest.workspaceId || key !== `peer-history-source/${source.baselineId}`) {
      throw new Error("Recovery peer source belongs to another workspace")
    }
    sources.push({ workspaceId: source.workspaceId, baselineId: source.baselineId, signedJson: fromBase64Url(source.signedJson),
      read: async objectId => {
        ensureCurrent()
        const value = decoded.auxiliary.get(`peer-history-object/${source.baselineId}:${objectId}`)
        if (value === undefined) return undefined
        if (!(value instanceof Uint8Array)) throw new Error("Recovery peer history object has invalid bytes")
        return value.slice()
      } })
  }
  return sources
}

function validateBaselineSources(decoded: Decoded, manifest: HistoryRecoveryManifest, sources: PeerHistoryRecoverySource[]): void {
  for (const entry of decoded.journal.receivedBaselines) {
    const row = entry.value as { signedJson?: unknown; peerProofs?: unknown }
    if (!row?.peerProofs) continue
    if (!(row.signedJson instanceof Uint8Array)) throw new Error("Recovery peer source signature is missing")
    const payload = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.signedJson)) as {
      payload: { baselineId: string; workspaceId: string }
    }).payload
    if (payload?.workspaceId !== manifest.workspaceId || !sources.some(source => source.baselineId === payload.baselineId)) {
      throw new Error("Recovery peer history has no original archive source")
    }
  }
}

function missingBaselineParents(decoded: Decoded, manifest: HistoryRecoveryManifest, records: HistoryRecoveryRecord[],
  peerSources: PeerHistoryRecoverySource[]): Array<{ baselineId: string; objectId: string }> {
  const baselines = new Map<string, { signedJson: string; epoch: number; parent?: string | null }>()
  const add = (workspaceId: unknown, baselineId: unknown, signedJson: Uint8Array) => addBaseline(baselines, manifest.workspaceId, workspaceId, baselineId, signedJson)
  for (const source of peerSources) add(source.workspaceId, source.baselineId, source.signedJson)
  for (const record of records) {
    if (record.kind !== "archive-source" || !record.signedJson) continue
    add(record.workspaceId, undefinedBaselineId(record.signedJson, manifest.workspaceId), fromBase64Url(record.signedJson))
  }
  for (const entry of decoded.journal.receivedBaselines) {
    const row = entry.value as { workspaceId?: unknown; baselineId?: unknown; signedJson?: unknown }
    if (!(row?.signedJson instanceof Uint8Array) || row.workspaceId !== manifest.workspaceId || !row.baselineId) continue
    add(row.workspaceId, row.baselineId, row.signedJson)
  }
  const missing = findMissingBaselineParents(baselines)
  const declared = new Set((manifest.missingPeerObjects ?? []).map(item => `${item.baselineId}:${item.objectId}`))
  if ([...missing.keys()].some(key => !declared.has(key))) throw new Error("Recovery history coverage omits a required signed parent baseline")
  return [...missing.values()]
}

function addBaseline(baselines: Map<string, { signedJson: string; epoch: number; parent?: string | null }>, expectedWorkspace: string,
  workspaceId: unknown, baselineId: unknown, signedJson: Uint8Array): void {
  if (workspaceId !== expectedWorkspace || typeof baselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(baselineId)) {
    throw new Error("Recovery history source routing is invalid")
  }
  const payload = readBaselinePayload(signedJson)
  if (payload.workspaceId !== expectedWorkspace || payload.baselineId !== baselineId ||
      !Number.isSafeInteger(payload.historyEpoch) || invalidParentId(payload.previousBaselineId)) {
    throw new Error("Recovery history source lineage is malformed")
  }
  const value = { signedJson: toBase64Url(signedJson), epoch: payload.historyEpoch as number,
    parent: payload.previousBaselineId as string | null | undefined }
  const prior = baselines.get(baselineId)
  if (prior && (prior.signedJson !== value.signedJson || prior.epoch !== value.epoch || prior.parent !== value.parent)) {
    throw new Error("Recovery contains conflicting sources for one history baseline")
  }
  baselines.set(baselineId, value)
}

function readBaselinePayload(signedJson: Uint8Array) {
  return (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signedJson)) as {
    payload?: { workspaceId?: unknown; baselineId?: unknown; historyEpoch?: unknown; previousBaselineId?: unknown }
  }).payload ?? {}
}
function invalidParentId(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
}

function findMissingBaselineParents(baselines: Map<string, { epoch: number; parent?: string | null }>) {
  const missing = new Map<string, { baselineId: string; objectId: string }>()
  for (const [baselineId, source] of baselines) addMissingParent(missing, baselines, baselineId, source)
  return missing
}
function addMissingParent(missing: Map<string, { baselineId: string; objectId: string }>,
  baselines: Map<string, { epoch: number; parent?: string | null }>, baselineId: string, source: { epoch: number; parent?: string | null }) {
  if (!source.parent) return
  const parent = baselines.get(source.parent)
  if (parent && parent.epoch !== source.epoch - 1) throw new Error("Recovery history lineage skips a signed baseline epoch")
  if (!parent) missing.set(`${baselineId}:${source.parent}`, { baselineId, objectId: source.parent })
}

function undefinedBaselineId(signedJson: string, workspaceId: string): unknown {
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(signedJson))) as {
    payload?: { workspaceId?: unknown; baselineId?: unknown }
  }
  if (envelope.payload?.workspaceId !== workspaceId) throw new Error("Recovery archive source belongs to another workspace")
  return envelope.payload.baselineId
}

/** File authentication proves intact bytes, not archive completeness. Recompute coverage using only retained file objects. */
export async function verifyDecodedPeerHistoryRecoveryCoverage(decoded: Decoded, manifest: HistoryRecoveryManifest,
  ensureCurrent: () => void, records: HistoryRecoveryRecord[] = []): Promise<void> {
  ensureCurrent()
  const sources = readSources(decoded, manifest, ensureCurrent)
  validateBaselineSources(decoded, manifest, sources)
  const missingParents = missingBaselineParents(decoded, manifest, records, sources)
  const archive = createPeerHistoryRecoveryEvidence(sources, ensureCurrent, missingParents)
  for await (const part of archive.evidence) {
    if (!part.data) throw new Error("Invalid peer history recovery evidence record")
    ensureCurrent()
  }
  if (canonicalizeJson(archive.missingObjects()) !== canonicalizeJson(manifest.missingPeerObjects ?? [])) {
    throw new Error("Recovery peer history coverage differs from its retained archive objects")
  }
  ensureCurrent()
}
