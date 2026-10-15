import { createLocatedArchiveStore } from "@meta-uber/mesh-replication/history-archive-locators"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson, isCurrentIdentityProfile, toBase64Url } from "../domain/identity"
import { defaultStorage } from "../storage"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { exportPrivateReplicaState } from "./privateReplicaRepository"
import { workspaceHistoryRecoverySources } from "./workspaceHistoryRecoverySources"
import { workspacePeerHistoryRecoverySources } from "./workspacePeerHistoryRecoverySources"
import type { StoredReceivedHistoryBaseline } from "../storageJournal"
import type { PeerHistoryDocumentRequest } from "./peerHistoryTransport"
import type { PeerHistoryBaselineDescriptor } from "./workspaceSet"

type Inputs = { getProfile(): LocalProfile | null | undefined }

/** Data ports for an already authenticated and currently authorized device channel. Keys never leave these sender-side ports. */
export function createWorkspacePeerHistorySource(input: Inputs) {
  const active = new Map<string, StoredReceivedHistoryBaseline>()
  function identity() {
    const profile = input.getProfile()
    if (!profile) throw new Error("Identity unavailable while serving workspace history")
    return { profile, guard: () => {
      if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed while serving workspace history")
    } }
  }
  async function current(workspaceId: string) {
    const { profile, guard } = identity()
    guard()
    const progress = await defaultStorage.ensureHistoryProgress(workspaceId)
    guard()
    if (!progress.baselineId) return undefined
    const key = `${profile.identity.personId}:${profile.device.deviceId}:${workspaceId}:${progress.baselineId}`
    const cached = active.get(key)
    if (cached) return cached
    const row = await createReceivedHistoryBaselineRepository(workspaceId, guard).readActive()
    guard()
    if (!row || row.workspaceId !== workspaceId || row.baselineId !== progress.baselineId) throw new Error("Active history source changed during read")
    active.set(key, row)
    if (active.size > 3) active.delete(active.keys().next().value!)
    return row
  }
  async function retained(workspaceId: string, requestedBaselineId: string) {
    const activeRow = await current(workspaceId)
    if (activeRow && baselineIdFromRow(activeRow, workspaceId) === requestedBaselineId) return activeRow
    const { profile, guard } = identity()
    guard()
    const rows = await createReceivedHistoryBaselineRepository(workspaceId, guard).readArchiveRecords()
    guard()
    const matches = rows.filter(candidate => baselineIdFromRow(candidate, workspaceId) === requestedBaselineId)
    if (matches.length > 1) throw new Error("Peer history contains duplicate retained baseline sources")
    const row = matches[0]
    guard()
    if (row && (row.workspaceId !== workspaceId || !isCurrentIdentityProfile(profile))) {
      throw new Error("Retained peer history source changed during read")
    }
    return row
  }
  function descriptor(row: StoredReceivedHistoryBaseline): PeerHistoryBaselineDescriptor {
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.signedJson)) as {
      payload: { workspaceId: string; baselineId: string; documentDigest: string }
    }
    if (envelope.payload?.workspaceId !== row.workspaceId ||
        row.baselineId !== undefined && envelope.payload.baselineId !== row.baselineId ||
        typeof envelope.payload.baselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(envelope.payload.baselineId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(envelope.payload.documentDigest) || row.document.length > 256 * 1024 * 1024) {
      throw new Error("Saved history descriptor differs from its original source")
    }
    return { version: 1, sourceKind: "authenticated-peer-plaintext", signedJson: toBase64Url(row.signedJson),
      baselineId: envelope.payload.baselineId, documentDigest: envelope.payload.documentDigest, documentLength: row.document.length }
  }
  return {
    async readHistoryBaseline(workspaceId: string, requestedBaselineId?: string): Promise<PeerHistoryBaselineDescriptor | undefined> {
      if (requestedBaselineId !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(requestedBaselineId)) return undefined
      const row = requestedBaselineId ? await retained(workspaceId, requestedBaselineId) : await current(workspaceId)
      if (requestedBaselineId && (!row || baselineIdFromRow(row, workspaceId) !== requestedBaselineId)) return undefined
      return row ? descriptor(row) : undefined
    },
    async readHistoryBaselineDocument(request: PeerHistoryDocumentRequest, remoteDeviceId?: string): Promise<Uint8Array | undefined> {
      if (!remoteDeviceId || !Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.length) ||
          request.length < 1 || request.length > 256 * 1024) return undefined
      const row = await retained(request.workspaceId, request.baselineId)
      if (!row || baselineIdFromRow(row, request.workspaceId) !== request.baselineId) return undefined
      const expected = descriptor(row)
      if (expected.documentDigest !== request.documentDigest || request.offset + request.length > row.document.length) return undefined
      // Receiver authenticates final bytes against the signed digest. Do not rehash the full document for each slice.
      return row.document.slice(request.offset, request.offset + request.length)
    },
    async readHistoryArchiveObject(workspaceId: string, baselineId: string, objectId: string, binding: ArchiveObjectReadBinding,
      remoteDeviceId?: string): Promise<Uint8Array | undefined> {
      if (!remoteDeviceId || !/^[A-Za-z0-9_-]{43}$/.test(baselineId) || binding.workspaceId !== workspaceId) return undefined
      const { profile, guard } = identity()
      guard()
      const wire = await exportPrivateReplicaState(profile.identity.personId), fingerprint = canonicalizeJson(wire)
      const ensureCurrent = async () => {
        guard()
        if (canonicalizeJson(await exportPrivateReplicaState(profile.identity.personId)) !== fingerprint) {
          throw new Error("Private workspace access changed during peer history read")
        }
        guard()
      }
      const peerSources = await workspacePeerHistoryRecoverySources(profile.identity.personId, workspaceId, ensureCurrent)
      for (const source of peerSources) {
        const payload = (JSON.parse(new TextDecoder().decode(source.signedJson)) as { payload: { baselineId: string; historyEpoch: number } }).payload
        if (payload.baselineId !== baselineId || payload.historyEpoch !== binding.historyEpoch) continue
        const bytes = await source.read(objectId, binding)
        await ensureCurrent()
        if (bytes) return bytes
      }
      const archive = await workspaceHistoryRecoverySources(workspaceId, wire, ensureCurrent)
      try {
        for (const source of archive.sources) {
          const payload = (JSON.parse(new TextDecoder().decode(source.signedJson)) as {
            payload: { baselineId: string; historyEpoch: number; locatorRoot: Parameters<typeof createLocatedArchiveStore>[1] }
          }).payload
          if (payload.baselineId !== baselineId || payload.historyEpoch !== binding.historyEpoch) continue
          const store = createLocatedArchiveStore(source.scope, payload.locatorRoot, { ensureCurrent,
            download: async id => {
              const object = await archive.download(source, id)
              if (!object) throw new Error("Requested workspace archive object is unavailable")
              return object
            } })
          const bytes = await store.read(objectId, binding.objectKind === "part" ? 256 * 1024 : 64 * 1024, binding)
          await ensureCurrent()
          if (bytes) return bytes
        }
        return undefined
      } finally { for (const source of archive.sources) source.scope.key.fill(0) }
    },
  }
}

function baselineIdFromRow(row: StoredReceivedHistoryBaseline | undefined, workspaceId: string): string | undefined {
  if (!row || row.workspaceId !== workspaceId) return undefined
  try {
    const payload = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.signedJson)) as {
      payload?: { workspaceId?: unknown; baselineId?: unknown }
    }).payload
    if (payload?.workspaceId !== workspaceId || typeof payload.baselineId !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.baselineId) || row.baselineId !== undefined && row.baselineId !== payload.baselineId) return undefined
    return payload.baselineId
  } catch { return undefined }
}
