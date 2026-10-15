import type { SyncConnection, DuplexStream } from "./transport"
import { readPeerHistoryBaseline, readPeerHistoryDocument, readPeerHistoryObject, parsePeerHistoryBaselineRead,
  parsePeerHistoryDocumentRead, parsePeerHistoryObjectRead, respondToPeerHistoryBaselineRead,
  respondToPeerHistoryDocumentRead, respondToPeerHistoryObjectRead, type PeerHistoryDocumentRequest,
  type PeerHistoryObjectBinding } from "./peerHistoryTransport"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

export type PeerHistoryBaselineDescriptor = { version: 1; sourceKind: "authenticated-peer-plaintext"; signedJson: string;
  baselineId: string; documentDigest: string; documentLength: number }

const MAX_PEER_BASELINE_DESCRIPTOR_BYTES = 384 * 1024
export function capturePeerHistoryBaselineDescriptor(value: unknown): PeerHistoryBaselineDescriptor {
  const item = structuredClone(value) as Record<string, unknown>
  if (!item || typeof item !== "object" || Array.isArray(item) || !hasExactKeys(item) ||
      !hasBaselineDescriptorFields(item)) throw new Error("Peer history baseline requires an update")
  return item as PeerHistoryBaselineDescriptor
}

function hasExactKeys(item: Record<string, unknown>): boolean { return Object.keys(item).length === 6 }
function hasBaselineDescriptorFields(item: Record<string, unknown>): boolean {
  return item.version === 1 && item.sourceKind === "authenticated-peer-plaintext" && typeof item.signedJson === "string" &&
    /^[A-Za-z0-9_-]+$/.test(item.signedJson) && item.signedJson.length <= MAX_PEER_BASELINE_DESCRIPTOR_BYTES &&
    typeof item.baselineId === "string" && /^[A-Za-z0-9_-]{43}$/.test(item.baselineId) &&
    typeof item.documentDigest === "string" && /^[A-Za-z0-9_-]{43}$/.test(item.documentDigest) &&
    Number.isSafeInteger(item.documentLength) && (item.documentLength as number) > 0 &&
    (item.documentLength as number) <= 256 * 1024 * 1024
}

export type PeerHistoryObjectReader = {
  ensureCurrent: () => void | Promise<void>
  readBaseline: (workspaceId: string, baselineId?: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  read: (objectId: string, binding: PeerHistoryObjectBinding, baselineId?: string) => Promise<Uint8Array>
  readDocument: (descriptor: PeerHistoryBaselineDescriptor, workspaceId: string) => Promise<Uint8Array>
  invitationScopeAuthority?: (workspaceId: string) => unknown
  authorizeHistoryAncestor?: (basis: WasmVerifiedReceivedHistoryBaseline) => Promise<void>
}

export function createPeerHistoryObjectReader(connection: SyncConnection, ensureCurrent: () => void | Promise<void>,
  admittedInvitationScopes?: ReadonlyMap<string, unknown>): PeerHistoryObjectReader {
  const scopes = admittedInvitationScopes && new Map([...admittedInvitationScopes].map(([id, scope]) => [id, structuredClone(scope)]))
  return { ensureCurrent,
    ...(scopes ? { invitationScopeAuthority: (workspaceId: string) => structuredClone(scopes.get(workspaceId)) } : {}),
    readBaseline: async (workspaceId, baselineId) => {
      const descriptor = await readPeerHistoryBaseline(() => connection.openStream(), workspaceId, ensureCurrent, baselineId)
      return descriptor === undefined ? undefined : capturePeerHistoryBaselineDescriptor(descriptor)
    },
    read: (objectId, binding, baselineId) => {
      if (!baselineId || !/^[A-Za-z0-9_-]{43}$/.test(baselineId)) throw new Error("Peer history object read requires its verified baseline")
      return readPeerHistoryObject(() => connection.openStream(), { baselineId, objectId, binding }, ensureCurrent)
    },
    readDocument: (descriptor, workspaceId) => readPeerHistoryDocument(() => connection.openStream(), {
      workspaceId, baselineId: descriptor.baselineId, documentDigest: descriptor.documentDigest, length: descriptor.documentLength,
    }, ensureCurrent) }
}

export type WorkspacePeerHistoryStore = {
  readHistoryBaseline?: (id: string, baselineId?: string) => Promise<unknown | undefined>
  readHistoryBaselineDocument?: (request: PeerHistoryDocumentRequest, remoteDeviceId: string) => Promise<Uint8Array | undefined>
  readHistoryArchiveObject?: (id: string, baselineId: string, objectId: string, binding: PeerHistoryObjectBinding,
    remoteDeviceId: string) => Promise<Uint8Array | undefined>
}

export function createPeerHistoryHandlers(store: WorkspacePeerHistoryStore, ids: string[]) {
  return {
    async serveObject(frame: Uint8Array, stream: DuplexStream, remoteDeviceId: string | undefined,
      ensureCurrent: () => void | Promise<void>): Promise<boolean> {
      if (parsePeerHistoryDocumentRead(frame)) throw new Error("Peer history document request must be routed before object requests")
      const request = parsePeerHistoryObjectRead(frame)
      if (!request) return false
      if (!remoteDeviceId || !store.readHistoryArchiveObject || !ids.includes(request.binding.workspaceId)) throw new Error("Peer history source access is unavailable")
      await respondToPeerHistoryObjectRead(stream, request,
        (baselineId, objectId, binding) => store.readHistoryArchiveObject!(binding.workspaceId, baselineId, objectId, binding, remoteDeviceId), ensureCurrent)
      return true
    },
    async serveBaseline(frame: Uint8Array, stream: DuplexStream, remoteDeviceId: string | undefined,
      ensureCurrent: () => void | Promise<void>): Promise<boolean> {
      const request = parsePeerHistoryBaselineRead(frame)
      if (!request) return false
      if (!remoteDeviceId || !store.readHistoryBaseline || !ids.includes(request.workspaceId)) throw new Error("Peer history source access is unavailable")
      await respondToPeerHistoryBaselineRead(stream, request, (workspaceId, baselineId) =>
        store.readHistoryBaseline!(workspaceId, baselineId), ensureCurrent)
      return true
    },
    async serveDocument(frame: Uint8Array, stream: DuplexStream, remoteDeviceId: string | undefined,
      ensureCurrent: () => void | Promise<void>): Promise<boolean> {
      const request = parsePeerHistoryDocumentRead(frame)
      if (!request) return false
      if (!remoteDeviceId || !store.readHistoryBaselineDocument || !ids.includes(request.workspaceId)) throw new Error("Peer history source access is unavailable")
      await respondToPeerHistoryDocumentRead(stream, request, part => store.readHistoryBaselineDocument!(part, remoteDeviceId), ensureCurrent)
      return true
    },
  }
}
