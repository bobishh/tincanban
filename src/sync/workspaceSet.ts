import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceChangeRejected } from "./changeAuthorization"
import { fromBase64Url, toBase64Url } from "../domain/identity"
import { clearProofPages } from "./proofPageCache"
import { workspaceProofTransfer, exportWorkspaceProofs } from "./workspaceProofTransfer"
import { safeDiagnostic } from "./safeDiagnostic"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import type { DuplexStream, SyncConnection } from "./transport"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { PeerHistoryDocumentRequest, PeerHistoryObjectBinding } from "./peerHistoryTransport"
import { capturePeerHistoryBaselineDescriptor, createPeerHistoryHandlers,
  type PeerHistoryBaselineDescriptor, type PeerHistoryObjectReader } from "./workspaceSetHistory"
export { createPeerHistoryObjectReader } from "./workspaceSetHistory"
export type { PeerHistoryBaselineDescriptor, PeerHistoryObjectReader } from "./workspaceSetHistory"
export { publishOwnerWorkspaceOffer } from "./ownerOfferProofs"

export type WorkspaceReplica = {
  subscribe?: (listener: () => void) => () => void
  /** Scope-aware updates for durable per-workspace sessions. */
  subscribeWorkspace?: (listener: (workspaceId?: string) => void) => () => void
}

export type LiveWorkspaceSync = {
  publish: () => Promise<void>
  readHistoryObject?: (baselineId: string, objectId: string, binding: PeerHistoryObjectBinding) => Promise<Uint8Array>
  readHistoryBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readHistoryDocument?: (descriptor: PeerHistoryBaselineDescriptor, workspaceId: string) => Promise<Uint8Array>
  reconcile?: () => Promise<void>
  heartbeat?: () => Promise<void>
  close: () => Promise<void>
  done: Promise<void>
}

export type OwnerWorkspaceOfferFrame = "mesh-owner-workspace-offer" | "mesh-owner-workspace-offer-page-v1"

export type WorkspaceSetStore = {
  read: (id: string) => Promise<Uint8Array>
  /** Heads from the admitted local document, excluding quarantined causal evidence. */
  readAuthorityHeads?: (id: string) => Promise<string[]>
  reclassify?: (id: string) => Promise<void>
  validate?: (id: string, bytes: Uint8Array, authorization?: unknown, receivedBasis?: WasmVerifiedReceivedHistoryBaseline) => Promise<void>
  merge: (id: string, bytes: Uint8Array, authorization?: unknown, receivedBasis?: WasmVerifiedReceivedHistoryBaseline) => Promise<void>
  /** Public owner-attested descriptor only. Never return private replica preferences or Rusty credentials here. */
  readHistoryBaseline?: (id: string, baselineId?: string) => Promise<unknown | undefined>
  readHistoryBaselineDocument?: (request: PeerHistoryDocumentRequest, remoteDeviceId: string) => Promise<Uint8Array | undefined>
  /** Produces and durably activates a Native-verified peer basis before merge. */
  receiveHistoryBaseline?: (id: string, workspaceBytes: Uint8Array, authorization: unknown, descriptor: PeerHistoryBaselineDescriptor,
    reader: PeerHistoryObjectReader, baselineDocument: Uint8Array) => Promise<WasmVerifiedReceivedHistoryBaseline>
  activateHistoryBaseline?: (id: string, candidate: WasmVerifiedReceivedHistoryBaseline) => Promise<void>
  /** Reads one plaintext content-addressed archive object for an already-authorized device. */
  readHistoryArchiveObject?: (id: string, baselineId: string, objectId: string, binding: PeerHistoryObjectBinding,
    remoteDeviceId: string) => Promise<Uint8Array | undefined>
  /** Records a verified same-person owner offer in this device's personal catalog. */
  recordVerifiedOwnerWorkspace?: (id: string) => Promise<void>
  activate: (id: string) => Promise<void>
  readAuthorization?: (bytes: Uint8Array, workspaceId?: string) => Promise<unknown>
  readChat?: (id: string, known?: Set<string>, remoteDeviceId?: string) => Promise<unknown>
  mergeChat?: (id: string, value: unknown, history: boolean, remoteDeviceId?: string) => Promise<void>
  readMesh?: (id: string) => Promise<unknown>
  mergeMesh?: (id: string, value: unknown) => Promise<void>
  blob?: {
    resolve: (workspaceId: string, blobId: string) => Promise<BlobDescriptor | undefined>
    read: (descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>
    write: (descriptor: BlobDescriptor, bytes: Uint8Array) => Promise<void>
  }
}

export type WorkspaceSetWorkspace = string | { id: string; title?: string }
type ReceiveStage = <T>(stage: string, id: string, action: () => Promise<T>) => Promise<T>
export type WorkspaceSetFactory = typeof workspaceSet
export type LiveWorkspaceOptions = {
  onHandoffRequest?: (stream: DuplexStream, frame: Uint8Array, acceptConfirmation: SyncConnection["acceptStream"]) => Promise<void>
  ownerWorkspaceOfferFrame?: OwnerWorkspaceOfferFrame
  onOwnerWorkspaceOffer?: (bytes: Uint8Array) => Promise<void>
  onGossipPacket?: (packet: Uint8Array) => Promise<void>
  onBlobRequest?: (stream: DuplexStream, frame: Uint8Array) => Promise<void>
  remoteDeviceId?: string
  ensureCurrent?: () => void | Promise<void>
}

export function workspaceSet(store: WorkspaceSetStore, workspaceEntries: WorkspaceSetWorkspace[]) {
  const titles = new Map(workspaceEntries.flatMap(entry => typeof entry === "string" || !entry.title ? [] : [[entry.id, entry.title] as const]))
  const ids = [...new Set(workspaceEntries.map(entry => typeof entry === "string" ? entry : entry.id))].sort()
  const proofs = workspaceProofTransfer(store, ids)
  const peerHistoryHandlers = createPeerHistoryHandlers(store, ids)
  const label = (id: string) => {
    const title = titles.get(id)
    return title ? `${id} (${title.length > 80 ? `${title.slice(0, 80)}…` : title})` : id
  }
  const receiveStage = async <T>(stage: string, id: string, action: () => Promise<T>): Promise<T> => {
    try { return await action() } catch (error) {
      if (stage === "Workspace") await clearProofPages(id).catch(() => {})
      throw new Error(`${stage} ${label(id)}: ${error instanceof Error ? error.message : String(error)}${safeDiagnostic(error)}`, { cause: error })
    }
  }
  return {
    async snapshot(knownChat?: Map<string, Set<string>>) {
      const entries = await Promise.all(ids.map(async id => {
        try {
          const bytes = await store.read(id)
          const authorization = await store.readAuthorization?.(bytes, id)
          const historyBaseline = await store.readHistoryBaseline?.(id)
          return { id, bytes: toBase64Url(bytes),
            ...(store.readAuthorization ? { authorization: exportWorkspaceProofs(bytes, authorization) } : {}),
            ...(store.readChat ? { chat: await store.readChat(id, knownChat ? (() => {
              const known = knownChat.get(id) ?? new Set<string>()
              knownChat.set(id, known)
              return known
            })() : undefined) } : {}),
            ...(store.readMesh ? { mesh: await store.readMesh(id) } : {}),
            ...(historyBaseline === undefined ? {} : { historyBaseline: capturePeerHistoryBaselineDescriptor(historyBaseline) }),
          }
        } catch (error) {
          throw new Error(`Workspace ${label(id)} snapshot failed: ${error instanceof Error ? error.message : String(error)}${safeDiagnostic(error)}`, { cause: error })
        }
      }))
      return meshRustRuntime().state.encodeWorkspaceSet(entries)
    },
    ...proofs,
    async validate(bytes: Uint8Array, peerHistory?: PeerHistoryObjectReader) {
      const entries = parseEntries(await this.resolveProofs(bytes), ids)
      const bases = new Map<string, WasmVerifiedReceivedHistoryBaseline>()
      try {
        for (const entry of entries) {
          if (entry.historyBaseline === undefined) continue
          if (!peerHistory || !store.receiveHistoryBaseline) throw new Error("Peer history archive transfer is unavailable; update or reconnect this device")
          const descriptor = capturePeerHistoryBaselineDescriptor(entry.historyBaseline)
          const baselineDocument = await peerHistory.readDocument(descriptor, entry.id)
          const candidate = await store.receiveHistoryBaseline(entry.id, fromBase64Url(entry.bytes), entry.authorization, descriptor, peerHistory, baselineDocument)
          if (!(candidate instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("Peer history basis was not Native-verified")
          bases.set(entry.id, candidate)
        }
        for (const entry of entries) {
          if (store.validate) await receiveStage("Workspace", entry.id, () =>
            store.validate!(entry.id, fromBase64Url(entry.bytes), entry.authorization, bases.get(entry.id)))
        }
      } finally {
        for (const candidate of bases.values()) candidate.free()
      }
    },
    async receive(bytes: Uint8Array, history = true, peerHistory?: PeerHistoryObjectReader) {
      const entries = parseEntries(await this.resolveProofs(bytes), ids)
      await receiveWorkspaceSetEntries(entries, store, peerHistory, history, receiveStage)
    },
    servePeerHistoryObjectRead: peerHistoryHandlers.serveObject,
    servePeerHistoryBaselineRead: peerHistoryHandlers.serveBaseline,
    servePeerHistoryDocumentRead: peerHistoryHandlers.serveDocument,
  }
}

async function receiveWorkspaceSetEntries(
  entries: ReturnType<typeof parseEntries>, store: WorkspaceSetStore, peerHistory: PeerHistoryObjectReader | undefined,
  history: boolean, receiveStage: ReceiveStage,
): Promise<void> {
  const bases = await receivePeerHistoryBases(entries, store, peerHistory, receiveStage)
  const activated = new Set<string>()
  try {
    for (const entry of entries) {
      if (store.validate) await receiveStage("Workspace", entry.id, () =>
        store.validate!(entry.id, fromBase64Url(entry.bytes), entry.authorization, bases.get(entry.id)))
    }
    for (const entry of entries) {
      const candidate = bases.get(entry.id)
      if (candidate) {
        if (!store.activateHistoryBaseline) throw new Error("Peer history activation is unavailable; update or reconnect this device")
        await receiveStage("History", entry.id, () => store.activateHistoryBaseline!(entry.id, candidate))
        activated.add(entry.id)
      }
    }
    for (const entry of entries) {
      await receiveStage("Workspace", entry.id, () => store.merge(entry.id, fromBase64Url(entry.bytes), entry.authorization, bases.get(entry.id)))
      if (entry.chat !== undefined && store.mergeChat) await receiveStage("Chat", entry.id, () => store.mergeChat!(entry.id, entry.chat, history))
      if (entry.mesh !== undefined && store.mergeMesh) await receiveStage("Mesh", entry.id, () => store.mergeMesh!(entry.id, entry.mesh))
    }
  } finally {
    for (const [id, candidate] of bases) if (!activated.has(id)) candidate.free()
  }
}

async function receivePeerHistoryBases(
  entries: ReturnType<typeof parseEntries>, store: WorkspaceSetStore, peerHistory: PeerHistoryObjectReader | undefined,
  receiveStage: ReceiveStage,
): Promise<Map<string, WasmVerifiedReceivedHistoryBaseline>> {
  const bases = new Map<string, WasmVerifiedReceivedHistoryBaseline>()
  try {
    for (const entry of entries) {
      if (entry.historyBaseline === undefined) continue
      if (!peerHistory || !store.receiveHistoryBaseline) throw new Error("Peer history archive transfer is unavailable; update or reconnect this device")
      const descriptor = capturePeerHistoryBaselineDescriptor(entry.historyBaseline)
      const baselineDocument = await receiveStage("History", entry.id, () => peerHistory.readDocument(descriptor, entry.id))
      const candidate = await receiveStage("History", entry.id, () => store.receiveHistoryBaseline!(entry.id,
        fromBase64Url(entry.bytes), entry.authorization, descriptor, peerHistory, baselineDocument))
      if (!(candidate instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("Peer history basis was not Native-verified")
      bases.set(entry.id, candidate)
    }
    return bases
  } catch (error) {
    for (const candidate of bases.values()) candidate.free()
    throw error
  }
}

function parseEntries(bytes: Uint8Array, ids: string[]) {
  return meshRustRuntime().state.decodeWorkspaceSet(bytes, ids)
}

export { publishConfirmedWorkspace, publishGossipPacket } from "./workspaceSetLive"
import { createLiveAutomergeWorkspaceSync, createLiveWorkspaceSetSync } from "./workspaceSetLive"

export function liveWorkspaceSetSync(connection: SyncConnection, secret: string, replica: ReturnType<typeof workspaceSet>,
  options: LiveWorkspaceOptions = {}): LiveWorkspaceSync {
  return createLiveWorkspaceSetSync(connection, secret, replica, options)
}

export function liveAutomergeWorkspaceSync(
  connection: SyncConnection, secret: string, store: WorkspaceSetStore, workspaceId: string, localDeviceId: string,
  remoteDeviceId: string, onDocumentRejected?: (error: WorkspaceChangeRejected | null) => void,
  options: LiveWorkspaceOptions = {},
): LiveWorkspaceSync {
  return createLiveAutomergeWorkspaceSync(connection, secret, store, workspaceId, localDeviceId, remoteDeviceId,
    workspaceSet, onDocumentRejected, options)
}
