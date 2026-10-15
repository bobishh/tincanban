import { MeshNetworkError } from "@meta-uber/mesh-transport"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import type { SessionEntry } from "./durableMeshBase"
import { PeerHistoryObjectUnavailableError } from "./peerHistoryTransport"
import type { BlobAuthoritySnapshot } from "./durableMeshBlobFetch"
import type { PeerHistoryBaselineDescriptor } from "./workspaceSetHistory"

export async function fetchDurableMeshHistoryBaseline(input: {
  workspaceId: string; baselineId: string; currentRunId(): number; isRunning(): boolean; sessions(): SessionEntry[]
  isCurrent(entry: SessionEntry, runId: number): boolean; readAuthority(): Promise<BlobAuthoritySnapshot>
}): Promise<PeerHistoryBaselineDescriptor | undefined> {
  if (!input.workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(input.baselineId)) throw new Error("Invalid peer history baseline selector")
  const runId = input.currentRunId(), original = await input.readAuthority()
  const guard = async (entry?: SessionEntry) => {
    assertCurrent(input, runId, entry)
    const current = await input.readAuthority()
    if (current.identity !== original.identity || current.credential !== original.credential || current.transportSecret !== original.transportSecret) {
      throw new Error("Workspace history authority changed during transfer")
    }
    assertCurrent(input, runId, entry)
  }
  await guard()
  for (const entry of input.sessions()) {
    if (entry.workspaceId !== input.workspaceId || !entry.session.readHistoryBaseline) continue
    await guard(entry)
    try {
      const descriptor = await entry.session.readHistoryBaseline(input.workspaceId, input.baselineId)
      await guard(entry)
      if (descriptor) return structuredClone(descriptor)
    } catch (error) {
      await guard(entry)
      if (!(error instanceof PeerHistoryObjectUnavailableError) && !(error instanceof MeshNetworkError)) throw error
    }
  }
  await guard()
  return undefined
}

export async function fetchDurableMeshHistoryDocument(input: {
  workspaceId: string; descriptor: PeerHistoryBaselineDescriptor; currentRunId(): number; isRunning(): boolean; sessions(): SessionEntry[]
  isCurrent(entry: SessionEntry, runId: number): boolean; readAuthority(): Promise<BlobAuthoritySnapshot>
}): Promise<Uint8Array | undefined> {
  const { workspaceId, descriptor } = input
  if (!workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.baselineId)) throw new Error("Invalid peer history document selector")
  const runId = input.currentRunId(), original = await input.readAuthority()
  const guard = async (entry?: SessionEntry) => {
    assertCurrent(input, runId, entry)
    const current = await input.readAuthority()
    if (current.identity !== original.identity || current.credential !== original.credential || current.transportSecret !== original.transportSecret) {
      throw new Error("Workspace history authority changed during transfer")
    }
    assertCurrent(input, runId, entry)
  }
  await guard()
  for (const entry of input.sessions()) {
    if (entry.workspaceId !== workspaceId || !entry.session.readHistoryDocument) continue
    await guard(entry)
    try {
      const bytes = await entry.session.readHistoryDocument(structuredClone(descriptor), workspaceId)
      await guard(entry)
      if (bytes) return bytes.slice()
    } catch (error) {
      await guard(entry)
      if (!(error instanceof PeerHistoryObjectUnavailableError) && !(error instanceof MeshNetworkError)) throw error
    }
  }
  await guard()
  return undefined
}

export async function fetchDurableMeshHistoryObject(input: {
  workspaceId: string; baselineId: string; objectId: string; binding: ArchiveObjectReadBinding
  currentRunId(): number; isRunning(): boolean; sessions(): SessionEntry[]
  isCurrent(entry: SessionEntry, runId: number): boolean
  readAuthority(): Promise<BlobAuthoritySnapshot>
}): Promise<Uint8Array | undefined> {
  if (input.binding.workspaceId !== input.workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(input.baselineId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.objectId)) throw new Error("Peer history request does not match its workspace baseline")
  const runId = input.currentRunId()
  const original = await input.readAuthority()
  const guard = async (entry?: SessionEntry) => {
    assertCurrent(input, runId, entry)
    const current = await input.readAuthority()
    if (current.identity !== original.identity || current.credential !== original.credential || current.transportSecret !== original.transportSecret) {
      throw new Error("Workspace history authority changed during transfer")
    }
    assertCurrent(input, runId, entry)
  }
  await guard()
  for (const entry of input.sessions()) {
    if (entry.workspaceId !== input.workspaceId || !entry.session.readHistoryObject) continue
    await guard(entry)
    try {
      const bytes = await entry.session.readHistoryObject(input.baselineId, input.objectId, structuredClone(input.binding))
      const captured = bytes.slice()
      await guard(entry)
      return captured
    } catch (error) {
      await guard(entry)
      if (!(error instanceof PeerHistoryObjectUnavailableError) && !(error instanceof MeshNetworkError)) throw error
    }
  }
  await guard()
  return undefined
}

function assertCurrent(input: { workspaceId: string; currentRunId(): number; isRunning(): boolean;
  isCurrent(entry: SessionEntry, runId: number): boolean }, runId: number, entry?: SessionEntry): void {
  if (!input.isRunning() || input.currentRunId() !== runId || entry && !input.isCurrent(entry, runId)) {
    throw new PeerHistoryObjectUnavailableError("History peer session was replaced")
  }
}
