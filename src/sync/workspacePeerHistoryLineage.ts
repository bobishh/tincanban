import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { fromBase64Url } from "../domain/identity"
import { capturePeerHistoryBaselineDescriptor, type PeerHistoryBaselineDescriptor } from "./workspaceSetHistory"
import { verifyPeerReceivedHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { reverifyStoredPeerHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { workspacePeerHistoryRecoverySources, type PeerHistoryRemoteRead, type WorkspacePeerHistoryRecoverySource } from "./workspacePeerHistoryRecoverySources"
import type { PeerHistoryRecoverySource } from "./peerHistoryRecovery"

type Source = PeerHistoryRecoverySource & {
  row?: WorkspacePeerHistoryRecoverySource["row"]
  document?: Uint8Array
}
type MissingParent = { baselineId: string; objectId: string }

/** Collects each retained peer baseline and its signed ancestors for a private backup. */
export async function workspacePeerHistoryRecoveryLineage(input: {
  personId: string; workspaceId: string; ensureCurrent: () => void; guard: () => void | Promise<void>
  trustedScopeAuthority: unknown; readObject?: PeerHistoryRemoteRead
  readBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>
}): Promise<{ sources: PeerHistoryRecoverySource[]; missingParents: MissingParent[] }> {
  const initial = await workspacePeerHistoryRecoverySources(input.personId, input.workspaceId, input.guard, input.readObject)
  const sources = new Map(initial.map(source => [source.baselineId, source as Source]))
  const missing = new Map<string, MissingParent>()
  if (sources.size && !input.trustedScopeAuthority) throw new Error("Peer history requires a saved signed workspace authority")

  for (const start of [...sources.values()]) {
    let current = start
    let currentBasis = await verifySource(current, input)
    try {
      for (let depth = 0; depth < 256; depth++) {
        await input.guard()
        const parentId = readParentId(currentBasis)
        if (!parentId) break
        const parent = await findParentSource(parentId, sources, input)
        if (!parent) {
          missing.set(`${current.baselineId}:${parentId}`, { baselineId: current.baselineId, objectId: parentId })
          break
        }
        const parentBasis = await verifySource(parent, input)
        try {
          const verifyPrevious = currentBasis as WasmVerifiedReceivedHistoryBaseline & {
            verifyPreviousBaseline(previous: WasmVerifiedReceivedHistoryBaseline): void
          }
          verifyPrevious.verifyPreviousBaseline(parentBasis)
        } catch (error) { parentBasis.free(); throw error }
        currentBasis.free()
        currentBasis = parentBasis
        current = parent
        if (depth === 255) throw new Error("Peer history lineage exceeds its bound")
      }
    } finally { currentBasis.free() }
  }
  await input.guard()
  return { sources: [...sources.values()], missingParents: [...missing.values()].sort((left, right) => {
    const a = `${left.baselineId}:${left.objectId}`, b = `${right.baselineId}:${right.objectId}`
    return a < b ? -1 : a > b ? 1 : 0
  }) }
}

export function missingHistoryBaselineParents(sources: Array<{ workspaceId: string; baselineId: string; signedJson: Uint8Array }>,
  workspaceId: string): MissingParent[] {
  if (!Array.isArray(sources) || sources.length > 512) throw new Error("Too many retained history baselines")
  const baselines = new Map<string, { epoch: number; parent?: string | null }>()
  for (const source of sources) addLineageSource(baselines, source, workspaceId)
  return collectMissingLineageParents(baselines)
}

function addLineageSource(baselines: Map<string, { epoch: number; parent?: string | null }>,
  source: { workspaceId: string; baselineId: string; signedJson: Uint8Array }, workspaceId: string): void {
  if (source.workspaceId !== workspaceId || !/^[A-Za-z0-9_-]{43}$/.test(source.baselineId)) {
    throw new Error("Retained history source belongs to another workspace")
  }
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.signedJson)) as {
    payload?: { workspaceId?: unknown; baselineId?: unknown; historyEpoch?: unknown; previousBaselineId?: unknown }
  }
  const item = envelope.payload
  if (item?.workspaceId !== workspaceId || item.baselineId !== source.baselineId || !Number.isSafeInteger(item.historyEpoch) ||
      item.previousBaselineId !== null && item.previousBaselineId !== undefined &&
      (typeof item.previousBaselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.previousBaselineId))) {
    throw new Error("Retained history lineage is malformed")
  }
  const value = { epoch: item.historyEpoch as number, parent: item.previousBaselineId as string | null | undefined }
  const previous = baselines.get(source.baselineId)
  if (previous && (previous.epoch !== value.epoch || previous.parent !== value.parent)) throw new Error("Retained history sources conflict")
  baselines.set(source.baselineId, value)
}

function collectMissingLineageParents(baselines: Map<string, { epoch: number; parent?: string | null }>): MissingParent[] {
  const missing: MissingParent[] = []
  for (const [baselineId, source] of baselines) {
    if (!source.parent) continue
    const parent = baselines.get(source.parent)
    if (parent && parent.epoch !== source.epoch - 1) throw new Error("Retained history lineage skips a signed baseline epoch")
    if (!parent) missing.push({ baselineId, objectId: source.parent })
  }
  return missing.sort((left, right) => {
    const a = `${left.baselineId}:${left.objectId}`, b = `${right.baselineId}:${right.objectId}`
    return a < b ? -1 : a > b ? 1 : 0
  })
}

async function findParentSource(id: string, sources: Map<string, Source>, input: {
  workspaceId: string; guard: () => void | Promise<void>; readObject?: PeerHistoryRemoteRead
  readBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>
}): Promise<Source | undefined> {
  const retained = sources.get(id)
  if (retained) return retained
  const fetched = await readRemoteParent(id, input)
  if (!fetched) return undefined
  sources.set(id, fetched)
  if (sources.size > 256) throw new Error("Too many retained peer history baselines")
  return fetched
}

async function verifySource(source: Source, input: {
  workspaceId: string; ensureCurrent: () => void; guard: () => void | Promise<void>; trustedScopeAuthority: unknown
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  await input.guard()
  if (source.workspaceId !== input.workspaceId) throw new Error("Peer history source belongs to another workspace")
  if (source.row) {
    const basis = await reverifyStoredPeerHistoryBaseline({ stored: source.row,
      trustedScopeAuthority: input.trustedScopeAuthority, ensureCurrent: input.ensureCurrent })
    try { await input.guard(); return basis } catch (error) { basis.free(); throw error }
  }
  if (!(source.document instanceof Uint8Array)) throw new Error("Retained peer baseline document is unavailable")
  const basis = await verifyPeerReceivedHistoryBaseline({ signedJson: source.signedJson, baselineDocument: source.document,
    trustedScopeAuthority: input.trustedScopeAuthority, fetch: { ensureCurrent: input.guard, read: async (id, binding) => {
      await input.guard()
      if (!binding || binding.workspaceId !== input.workspaceId) throw new Error("Peer history object binding is invalid")
      const bytes = await source.read(id, binding)
      await input.guard()
      return bytes
    } }, ensureCurrent: input.ensureCurrent })
  try { await input.guard(); return basis } catch (error) { basis.free(); throw error }
}

async function readRemoteParent(id: string, input: {
  workspaceId: string; guard: () => void | Promise<void>; readObject?: PeerHistoryRemoteRead
  readBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>
}): Promise<Source | undefined> {
  if (!input.readObject || !input.readBaseline || !input.readDocument) return undefined
  await input.guard()
  const rawDescriptor = await input.readBaseline(input.workspaceId, id)
  await input.guard()
  if (rawDescriptor === undefined) return undefined
  const descriptor = capturePeerHistoryBaselineDescriptor(rawDescriptor)
  if (descriptor.baselineId !== id) throw new Error("Peer returned a different retained history baseline")
  const document = await input.readDocument(input.workspaceId, descriptor)
  await input.guard()
  if (document === undefined) return undefined
  if (!(document instanceof Uint8Array) || document.length !== descriptor.documentLength) throw new Error("Retained peer baseline document is malformed")
  const signedJson = fromBase64Url(descriptor.signedJson)
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signedJson)) as {
    payload?: { workspaceId?: unknown; baselineId?: unknown }
  }
  if (envelope.payload?.workspaceId !== input.workspaceId || envelope.payload.baselineId !== id) {
    throw new Error("Peer baseline signature routing differs from its selector")
  }
  return { workspaceId: input.workspaceId, baselineId: id, signedJson, document,
    read: async (objectId, binding) => input.readObject!(input.workspaceId, id, objectId, binding) }
}

function readParentId(basis: WasmVerifiedReceivedHistoryBaseline): string | undefined {
  const envelope = basis.envelope() as { payload?: { previousBaselineId?: unknown } }
  const id = envelope.payload?.previousBaselineId
  if (id === null || id === undefined) return undefined
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Native history lineage is malformed")
  return id
}
