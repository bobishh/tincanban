import { MeshNetworkError } from "@meta-uber/mesh-transport"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import type { DurableMesh } from "./durableMesh"
import type { LiveWorkspaceSync } from "./workspaceSet"
import { PeerHistoryObjectUnavailableError } from "./peerHistoryErrors"
import type { PeerHistoryBaselineDescriptor } from "./workspaceSetHistory"

async function fetchPeerHistoryBaseline(input: { workspaceId: string; baselineId: string; durableMesh?: DurableMesh;
  durableMeshPromise?: Promise<DurableMesh | undefined>; directPeerSessions: () => Iterable<LiveWorkspaceSync> }) {
  const { workspaceId, baselineId } = input
  if (!workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(baselineId)) throw new Error("Invalid peer history baseline selector")
  const mesh = input.durableMesh ?? await input.durableMeshPromise
  try {
    const durable = await mesh?.fetchHistoryBaseline(workspaceId, baselineId)
    if (durable) return durable
  } catch (error) { if (!isUnavailable(error)) throw error }
  for (const session of input.directPeerSessions()) {
    if (!session.readHistoryBaseline) continue
    try {
      const descriptor: PeerHistoryBaselineDescriptor | undefined = await session.readHistoryBaseline(workspaceId, baselineId)
      if (descriptor) return structuredClone(descriptor)
    } catch (error) { if (!isUnavailable(error)) throw error }
  }
  return undefined
}

async function fetchPeerHistoryDocument(input: { workspaceId: string; descriptor: PeerHistoryBaselineDescriptor;
  durableMesh?: DurableMesh; durableMeshPromise?: Promise<DurableMesh | undefined>; directPeerSessions: () => Iterable<LiveWorkspaceSync> }) {
  const { workspaceId, descriptor } = input
  if (!workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.baselineId)) throw new Error("Invalid peer history document selector")
  const mesh = input.durableMesh ?? await input.durableMeshPromise
  try {
    const durable = await mesh?.fetchHistoryDocument(workspaceId, descriptor)
    if (durable) return durable
  } catch (error) { if (!isUnavailable(error)) throw error }
  for (const session of input.directPeerSessions()) {
    if (!session.readHistoryDocument) continue
    try {
      const bytes = await session.readHistoryDocument(structuredClone(descriptor), workspaceId)
      if (bytes) return bytes.slice()
    } catch (error) { if (!isUnavailable(error)) throw error }
  }
  return undefined
}

async function fetchPeerHistoryObject(input: {
  workspaceId: string; baselineId: string; objectId: string; binding: ArchiveObjectReadBinding
  durableMesh?: DurableMesh; durableMeshPromise?: Promise<DurableMesh | undefined>
  directPeerSessions: () => Iterable<LiveWorkspaceSync>
}): Promise<Uint8Array | undefined> {
  const { workspaceId, baselineId, objectId, binding } = input
  if (binding.workspaceId !== workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(baselineId)) {
    throw new Error("Peer history request does not match its workspace baseline")
  }
  const mesh = input.durableMesh ?? await input.durableMeshPromise
  try {
    const durable = await mesh?.fetchHistoryObject(workspaceId, baselineId, objectId, structuredClone(binding))
    if (durable) return durable
  } catch (error) { if (!isUnavailable(error)) throw error }
  for (const session of input.directPeerSessions()) {
    if (!session.readHistoryObject) continue
    try { return await session.readHistoryObject(baselineId, objectId, structuredClone(binding)) }
    catch (error) { if (!isUnavailable(error)) throw error }
  }
  return undefined
}

function isUnavailable(error: unknown): boolean {
  return error instanceof PeerHistoryObjectUnavailableError || error instanceof MeshNetworkError
}

export function createPeerHistoryReadActions(input: {
  durableMesh: () => DurableMesh | undefined
  durableMeshPromise: () => Promise<DurableMesh | undefined> | undefined
  directPeerSessions: () => Iterable<LiveWorkspaceSync>
}) {
  const routing = () => ({ durableMesh: input.durableMesh(), durableMeshPromise: input.durableMeshPromise(),
    directPeerSessions: () => input.directPeerSessions() })
  return {
    fetchHistoryObject: (workspaceId: string, baselineId: string, objectId: string, binding: ArchiveObjectReadBinding) =>
      fetchPeerHistoryObject({ ...routing(), workspaceId, baselineId, objectId, binding }),
    fetchHistoryBaseline: (workspaceId: string, baselineId: string) =>
      fetchPeerHistoryBaseline({ ...routing(), workspaceId, baselineId }),
    fetchHistoryDocument: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) =>
      fetchPeerHistoryDocument({ ...routing(), workspaceId, descriptor }),
  }
}
