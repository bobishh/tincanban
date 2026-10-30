import { MeshNetworkError } from "@meta-uber/mesh-transport"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import type { SessionEntry } from "./durableMeshBase"
import { PeerHistoryObjectUnavailableError } from "./peerHistoryTransport"
import type { BlobAuthoritySnapshot } from "./durableMeshBlobFetch"
import type { PeerHistoryBaselineDescriptor } from "./workspaceSetHistory"

type HistoryReadContext = {
  workspaceId: string; currentRunId(): number; isRunning(): boolean; sessions(): SessionEntry[]
  isCurrent(entry: SessionEntry, runId: number): boolean; readAuthority(): Promise<BlobAuthoritySnapshot>
}

export async function fetchDurableMeshHistoryBaseline(input: HistoryReadContext & {
  baselineId: string
}): Promise<PeerHistoryBaselineDescriptor | undefined> {
  if (!input.workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(input.baselineId)) throw new Error("Invalid peer history baseline selector")
  return readCurrentHistoryPeers(input, async entry => {
    const descriptor = await entry.session.readHistoryBaseline?.(input.workspaceId, input.baselineId)
    return descriptor ? structuredClone(descriptor) : undefined
  })
}

export async function fetchDurableMeshHistoryDocument(input: HistoryReadContext & {
  descriptor: PeerHistoryBaselineDescriptor
}): Promise<Uint8Array | undefined> {
  const { workspaceId, descriptor } = input
  if (!workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.baselineId)) throw new Error("Invalid peer history document selector")
  return readCurrentHistoryPeers(input, async entry =>
    (await entry.session.readHistoryDocument?.(structuredClone(descriptor), workspaceId))?.slice())
}

export async function fetchDurableMeshHistoryObject(input: HistoryReadContext & {
  baselineId: string; objectId: string; binding: ArchiveObjectReadBinding
}): Promise<Uint8Array | undefined> {
  if (input.binding.workspaceId !== input.workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(input.baselineId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.objectId)) throw new Error("Peer history request does not match its workspace baseline")
  return readCurrentHistoryPeers(input, async entry => {
    if (!entry.session.readHistoryObject) return undefined
    const bytes = await entry.session.readHistoryObject(input.baselineId, input.objectId, structuredClone(input.binding))
    return bytes.slice()
  })
}

async function readCurrentHistoryPeers<T>(input: HistoryReadContext,
  read: (entry: SessionEntry) => Promise<T | undefined>): Promise<T | undefined> {
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
  const attempted = new Set<SessionEntry>()
  let replaced: PeerHistoryObjectUnavailableError | undefined
  // Refresh the session snapshot once for a replacement that arrived during a read.
  for (let pass = 0; pass < 2; pass++) for (const entry of input.sessions()) {
    if (entry.workspaceId !== input.workspaceId || attempted.has(entry)) continue
    attempted.add(entry)
    try {
      await guard(entry)
      const value = await read(entry)
      await guard(entry)
      if (value !== undefined) return value
    } catch (error) {
      // A lost session does not invalidate other peers; changed authority still aborts the whole read.
      await guard()
      if (!(error instanceof PeerHistoryObjectUnavailableError) && !(error instanceof MeshNetworkError)) throw error
      if (!input.isCurrent(entry, runId)) replaced = new PeerHistoryObjectUnavailableError("History peer session was replaced")
    }
  }
  await guard()
  if (replaced) throw replaced
  return undefined
}

function assertCurrent(input: HistoryReadContext, runId: number, entry?: SessionEntry): void {
  if (!input.isRunning() || input.currentRunId() !== runId || entry && !input.isCurrent(entry, runId)) {
    throw new PeerHistoryObjectUnavailableError("History peer session was replaced")
  }
}
