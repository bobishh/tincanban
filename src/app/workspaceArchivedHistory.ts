import type { useTincanban } from "../state"
import { canonicalizeJson, fromBase64Url, isCurrentIdentityProfile, toBase64Url } from "../domain/identity"
import type { HistoryEntry } from "../domain/history"
import { exportPrivateReplicaState } from "../sync/privateReplicaRepository"
import { authorityValidationFingerprint, readWorkspaceSigningAuthority, workspaceRole } from "../sync/changeAuthorization"
import { workspaceSigningContext } from "../sync/workspaceSigning"
import { workspaceHistoryRecoverySources } from "../sync/workspaceHistoryRecoverySources"
import { createReceivedHistoryBaselineRepository } from "../sync/receivedHistoryBaselineRepository"
import { parseWireHistoryBaseline, verifyReceivedWireHistoryBaseline, type WireHistoryBaseline } from "../sync/historyBaselineReceiver"
import { workspacePeerHistoryRecoverySources, type PeerHistoryRemoteRead } from "../sync/workspacePeerHistoryRecoverySources"
import type { PeerHistoryBaselineDescriptor } from "../sync/workspaceSetHistory"
import { reverifyStoredPeerHistoryBaseline } from "../sync/peerHistoryBaselineReceiver"
import { verifyPeerReceivedHistoryBaseline } from "../sync/peerHistoryBaselineReceiver"
import { createHistoryArchiveReader } from "../sync/historyArchiveReader"
import { capturePeerHistoryBaselineDescriptor } from "../sync/workspaceSetHistory"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import { selectActiveHistoryRoute } from "./workspaceActiveHistoryRoute"

type Reader = ReturnType<typeof createHistoryArchiveReader>
type ArchivedVersion = Awaited<ReturnType<Reader["readItemVersion"]>>
type PeerSource = Awaited<ReturnType<typeof workspacePeerHistoryRecoverySources>>[number]
type RustySource = Awaited<ReturnType<typeof workspaceHistoryRecoverySources>>["sources"][number]
type ArchiveSources = Awaited<ReturnType<typeof workspaceHistoryRecoverySources>>
type PeerRouteSource = {
  id: string; workspaceId: string; baselineId: string; signedJson: Uint8Array
  read(objectId: string, binding: ArchiveObjectReadBinding): Promise<Uint8Array | undefined>
  row?: PeerSource["row"]; document?: Uint8Array
  rustySource?: RustySource
}
type HistoryRoute = { kind: "rusty"; source: RustySource; envelope: { payload: { baselineId: string; historyEpoch: number; previousBaselineId?: string | null; storage: { authority: unknown } } }; wire: WireHistoryBaseline } |
  { kind: "peer"; source: PeerRouteSource; envelope: { payload: { baselineId: string; historyEpoch: number; previousBaselineId?: string | null } } }

/** Explicit history reads only. Opening/rendering cards never fetches archive content. */
export async function createWorkspaceArchivedHistorySession(app: ReturnType<typeof useTincanban>, workspaceId: string,
  entityId: string, ensureSelected: () => void, remote?: PeerHistoryRemoteRead,
  readRemoteBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>,
  readRemoteDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>) {
  const profile = app.getCurrentProfile()
  if (!profile) throw new Error("Identity is unavailable")
  let disposed = false
  const ensureCurrent = () => {
    ensureSelected()
    if (disposed || !isCurrentIdentityProfile(profile) || app.activeWorkspace.id !== workspaceId) throw new Error("Workspace or history selection changed")
  }
  ensureCurrent()
  const doc = await app.readWorkspaceDoc(workspaceId)
  const signing = await workspaceSigningContext(doc, profile, "history-recovery-read", "workspaceId", undefined, {
    readAuthority: () => readWorkspaceSigningAuthority(workspaceId), authorityFingerprint: authorityValidationFingerprint, workspaceRole,
  })
  const wire = await exportPrivateReplicaState(profile.identity.personId), wireFingerprint = canonicalizeJson(wire)
  const guard = async () => {
    ensureCurrent()
    await signing.requireCurrent()
    if (canonicalizeJson(await exportPrivateReplicaState(profile.identity.personId)) !== wireFingerprint) throw new Error("Rusty access changed; reopen history")
    ensureCurrent()
  }
  const repository = createReceivedHistoryBaselineRepository(workspaceId, ensureCurrent)
  const [archive, stored, current, peerSources, active] = await Promise.all([
    workspaceHistoryRecoverySources(workspaceId, wire, guard),
    repository.readArchiveRecords(),
    readWorkspaceSigningAuthority(workspaceId),
    workspacePeerHistoryRecoverySources(profile.identity.personId, workspaceId, guard, remote),
    repository.readActive(),
  ])
  await guard()
  if (current.invalid) throw new Error("Workspace permissions could not be verified")
  const admittedScope = current.authority?.scopeAuthoritySnapshot
  if (!admittedScope && (archive.sources.length || peerSources.length)) throw new Error("History requires this board's saved signed access record")
  // Historical checkpoints may precede current control changes. Current reading rights were checked above;
  // Native separately verifies their original controller against this immutable signed genesis.
  const trustedScopeAuthority = admittedScope ? { genesis: admittedScope.genesis, grants: [], grantIssuers: [],
    revocations: [], controlTransfers: [], successionTransfers: [] } : undefined
  const routes = archive.sources.flatMap(source => {
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.signedJson)) as {
      payload: { baselineId: string; historyEpoch: number; previousBaselineId?: string | null; storage: { authority: unknown } }
    }
    const metadata = source.authorityEvidence as { evidence?: { wire?: unknown } }
    const row = stored.find(value => toBase64Url(value.signedJson) === toBase64Url(source.signedJson))
    const descriptor = metadata?.evidence?.wire ?? row?.wire
    if (!descriptor) return []
    const wire = parseWireHistoryBaseline(descriptor)
    if (wire.signedJson !== toBase64Url(source.signedJson)) throw new Error("Archived history descriptor differs from its signature")
    return [{ kind: "rusty" as const, source, envelope, wire }]
  })
  const peerRoutes = peerSources.map(source => ({ kind: "peer" as const, source: { ...source, id: `peer:${source.baselineId}`,
    rustySource: archive.sources.find(candidate => sameBytes(candidate.signedJson, source.signedJson)) },
    envelope: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.signedJson)) as {
      payload: { baselineId: string; historyEpoch: number; previousBaselineId?: string | null }
    } }))
  const availableRoutes: HistoryRoute[] = [...routes, ...peerRoutes]
  const first = selectActiveHistoryRoute(availableRoutes.map(route => ({ baselineId: route.envelope.payload.baselineId,
    signedJson: route.source.signedJson, route })), active)
  const sources: HistoryRoute[] = first ? [first] : []
  const access = createHistoryRouteAccess({ workspaceId, sources, availableRoutes, archive, trustedScopeAuthority, guard,
    ensureCurrent, remote, readRemoteBaseline, readRemoteDocument })
  return createHistorySessionApi({ entityId, sources, guard, ...access, onDispose: () => {
    disposed = true
    for (const route of sources) if (route.kind === "rusty") route.source.scope.key.fill(0)
    for (const route of sources) if (route.kind === "peer") route.source.rustySource?.scope.key.fill(0)
    access.dispose()
  } })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function createHistoryRouteAccess(input: {
  workspaceId: string; sources: HistoryRoute[]; availableRoutes: HistoryRoute[]; archive: ArchiveSources
  trustedScopeAuthority: unknown; guard: () => Promise<void>; ensureCurrent: () => void
  remote?: PeerHistoryRemoteRead
  readRemoteBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readRemoteDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>
}) {
  const { workspaceId, sources, availableRoutes, archive, trustedScopeAuthority, guard, ensureCurrent } = input
  const verifiedBases = new Map<string, WasmVerifiedReceivedHistoryBaseline>()
  let currentReader: { sourceId: string; basis: WasmVerifiedReceivedHistoryBaseline; reader: Reader } | undefined
  const releaseReader = () => { currentReader?.reader.dispose(); currentReader?.basis.free(); currentReader = undefined }
  const readRouteBasis = (route: HistoryRoute) => readHistoryRouteBasis(route, { archive, guard, ensureCurrent, trustedScopeAuthority })
  const appendPrevious = (child: HistoryRoute, childBasis: WasmVerifiedReceivedHistoryBaseline) =>
    appendHistoryParent(child, childBasis, { workspaceId, sources, availableRoutes, verifiedBases,
      readRouteBasis, guard, remote: input.remote, readRemoteBaseline: input.readRemoteBaseline,
      readRemoteDocument: input.readRemoteDocument })
  const readerFor = (sourceId: string) => createReaderForRoute(sourceId, {
    sources, verifiedBases, readRouteBasis, releaseReader, archive, guard, ensureCurrent,
    currentReader: () => currentReader,
    setCurrent: value => { currentReader = value },
  })
  return {
    readerFor,
    releaseReader,
    advance: async (route: HistoryRoute) => currentReader ? appendPrevious(route, currentReader.basis) : undefined,
    dispose: () => { for (const basis of verifiedBases.values()) basis.free(); verifiedBases.clear() },
  }
}

async function readHistoryRouteBasis(route: HistoryRoute, input: { archive: ArchiveSources; guard: () => Promise<void>;
  ensureCurrent: () => void; trustedScopeAuthority: unknown }) {
  const { archive, guard, ensureCurrent, trustedScopeAuthority } = input
  if (route.kind === "rusty") {
    return verifyReceivedWireHistoryBaseline({ wire: route.wire, scope: route.source.scope,
      pinnedStorage: route.envelope.payload.storage.authority as Parameters<typeof verifyReceivedWireHistoryBaseline>[0]["pinnedStorage"],
      trustedScopeAuthority, fetch: { ensureCurrent: guard, download: async id => {
        await guard()
        const object = await archive.download(route.source, id)
        await guard()
        if (!object) throw new Error("Part of this history is unavailable. Reconnect Rusty or import a complete private backup.")
        return object
      } }, ensureCurrent })
  }
  if (route.source.row) return reverifyStoredPeerHistoryBaseline({ stored: route.source.row, trustedScopeAuthority, ensureCurrent })
  if (!route.source.document) throw new Error("Retained peer history source is incomplete")
  return verifyPeerReceivedHistoryBaseline({ signedJson: route.source.signedJson, baselineDocument: route.source.document,
    trustedScopeAuthority, fetch: { ensureCurrent: guard, read: async (id, binding) => {
      if (!binding) throw new Error("Archived peer history requires an exact source binding")
      return route.source.read(id, binding)
    } }, ensureCurrent })
}

async function appendHistoryParent(child: HistoryRoute, childBasis: WasmVerifiedReceivedHistoryBaseline, input: {
  workspaceId: string; sources: HistoryRoute[]; availableRoutes: HistoryRoute[]
  verifiedBases: Map<string, WasmVerifiedReceivedHistoryBaseline>; readRouteBasis(route: HistoryRoute): Promise<WasmVerifiedReceivedHistoryBaseline>
  guard: () => Promise<void>; remote?: PeerHistoryRemoteRead
  readRemoteBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readRemoteDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>
}) {
  const id = parentBaselineId(childBasis)
  if (!id) return undefined
  const existing = input.sources.find(route => route.envelope.payload.baselineId === id)
  if (existing) return existing
  const route = input.availableRoutes.find(value => value.envelope.payload.baselineId === id) ?? await readRemoteParentRoute(id, input)
  const candidate = await input.readRouteBasis(route)
  try { verifyParentEdge(child, childBasis, route, candidate, id) }
  catch (error) { candidate.free(); throw error }
  input.verifiedBases.set(id, candidate)
  input.sources.push(route)
  return route
}

function parentBaselineId(basis: WasmVerifiedReceivedHistoryBaseline) {
  const envelope = basis.envelope() as { payload?: { previousBaselineId?: unknown } }
  const id = envelope.payload?.previousBaselineId
  if (id === null || id === undefined) return undefined
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Native history lineage is malformed")
  return id
}

async function readRemoteParentRoute(id: string, input: {
  workspaceId: string; guard: () => Promise<void>; remote?: PeerHistoryRemoteRead
  readRemoteBaseline?: (workspaceId: string, baselineId: string) => Promise<PeerHistoryBaselineDescriptor | undefined>
  readRemoteDocument?: (workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) => Promise<Uint8Array | undefined>
}): Promise<HistoryRoute> {
  if (!input.readRemoteBaseline || !input.readRemoteDocument || !input.remote) {
    throw new Error("Earlier history is stored on another authorized device; reconnect it to continue")
  }
  await input.guard()
  const descriptor = capturePeerHistoryBaselineDescriptor(await input.readRemoteBaseline(input.workspaceId, id))
  await input.guard()
  if (descriptor.baselineId !== id) throw new Error("Peer returned a different retained history baseline")
  const document = await input.readRemoteDocument(input.workspaceId, descriptor)
  await input.guard()
  if (!(document instanceof Uint8Array) || document.length !== descriptor.documentLength) throw new Error("Retained peer history document is unavailable")
  const signedJson = fromBase64Url(descriptor.signedJson)
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signedJson)) as {
    payload: { baselineId: string; historyEpoch: number; previousBaselineId?: string | null }
  }
  return { kind: "peer", source: { id: `peer:${id}`, workspaceId: input.workspaceId, baselineId: id, signedJson, document,
    read: async (objectId, binding) => input.remote!(input.workspaceId, id, objectId, binding) }, envelope }
}

function verifyParentEdge(child: HistoryRoute, childBasis: WasmVerifiedReceivedHistoryBaseline,
  route: HistoryRoute, candidate: WasmVerifiedReceivedHistoryBaseline, expectedId: string) {
  const envelope = candidate.envelope() as { payload?: { baselineId?: unknown; historyEpoch?: unknown } }
  if (envelope.payload?.baselineId !== expectedId || envelope.payload.historyEpoch !== child.envelope.payload.historyEpoch - 1) {
    throw new Error("Native retained baseline is not the signed parent")
  }
  const verifyPrevious = childBasis as WasmVerifiedReceivedHistoryBaseline & {
    verifyPreviousBaseline(parent: WasmVerifiedReceivedHistoryBaseline): void
  }
  verifyPrevious.verifyPreviousBaseline(candidate)
  if (route.envelope.payload.baselineId !== expectedId) throw new Error("Selected history source differs from Native parent")
}

async function createReaderForRoute(sourceId: string, input: {
  sources: HistoryRoute[]; verifiedBases: Map<string, WasmVerifiedReceivedHistoryBaseline>
  readRouteBasis(route: HistoryRoute): Promise<WasmVerifiedReceivedHistoryBaseline>
  releaseReader(): void; archive: ArchiveSources; guard: () => Promise<void>; ensureCurrent: () => void
  currentReader(): { sourceId: string; basis: WasmVerifiedReceivedHistoryBaseline; reader: Reader } | undefined
  setCurrent(value: { sourceId: string; basis: WasmVerifiedReceivedHistoryBaseline; reader: Reader }): void
}) {
  await input.guard()
  const current = input.currentReader()
  if (current?.sourceId === sourceId) return current.reader
  const route = input.sources.find(value => value.source.id === sourceId)
  if (!route) throw new Error("Archived history source is unavailable")
  const basis = input.verifiedBases.get(route.envelope.payload.baselineId) ?? await input.readRouteBasis(route)
  input.verifiedBases.delete(route.envelope.payload.baselineId)
  input.releaseReader()
  try {
    const reader = route.kind === "peer" ? await createPeerHistoryReader(route, basis, input) :
      await createRustyHistoryReader(route, basis, input)
    input.setCurrent({ sourceId: route.source.id, basis, reader })
    return reader
  } catch (error) { basis.free(); throw error }
}

async function createPeerHistoryReader(route: Extract<HistoryRoute, { kind: "peer" }>,
  basis: WasmVerifiedReceivedHistoryBaseline, input: { guard: () => Promise<void>; ensureCurrent: () => void; archive: ArchiveSources }) {
  await input.guard()
  if (route.source.rustySource) return createHistoryArchiveReader({ basis, scope: route.source.rustySource.scope,
    fetch: { ensureCurrent: input.guard, download: async id => {
      await input.guard()
      const object = await input.archive.download(route.source.rustySource!, id)
      await input.guard()
      if (!object) throw new Error("Part of this history is unavailable. Reconnect Rusty or import a complete private backup.")
      return object
    } }, ensureCurrent: input.ensureCurrent })
  return createHistoryArchiveReader({ basis, ensureCurrent: input.ensureCurrent, peerFetch: { ensureCurrent: input.guard,
    read: async (id, binding) => {
      if (!binding) throw new Error("Archived peer history requires an exact source binding")
      return route.source.read(id, binding)
    } } })
}

async function createRustyHistoryReader(route: Extract<HistoryRoute, { kind: "rusty" }>,
  basis: WasmVerifiedReceivedHistoryBaseline, input: { archive: ArchiveSources; guard: () => Promise<void>; ensureCurrent: () => void }) {
  await input.guard()
  const fetch = { ensureCurrent: input.guard, download: async (id: string) => {
    await input.guard()
    const object = await input.archive.download(route.source, id)
    await input.guard()
    if (!object) throw new Error("Part of this history is unavailable. Reconnect Rusty or import a complete private backup.")
    return object
  } }
  return createHistoryArchiveReader({ basis, scope: route.source.scope, fetch, ensureCurrent: input.ensureCurrent })
}

function createHistorySessionApi(input: { entityId: string; sources: HistoryRoute[];
  guard: () => Promise<void>; readerFor: (sourceId: string) => Promise<Reader>; releaseReader: () => void;
  advance: (route: HistoryRoute) => Promise<HistoryRoute | undefined>; onDispose: () => void }) {
  const { entityId, sources, guard, readerFor, releaseReader, advance } = input
  let sourceIndex = 0, after: string | undefined
  const entries = new Map<string, HistoryEntry>()
  return {
    async loadNext(): Promise<{ entries: HistoryEntry[]; hasMore: boolean }> {
      await guard()
      const result: HistoryEntry[] = []
      while (sourceIndex < sources.length && result.length === 0) {
        const route = sources[sourceIndex]!, reader = await readerFor(route.source.id)
        const page = await reader.listEntity(entityId, { after, limit: 64 })
        await guard()
        for (const entry of page.entries) {
          if (entries.has(entry.hash)) continue
          const item: HistoryEntry = { hash: entry.hash, time: entry.time, actor: entry.actor, action: entry.action,
            entityIds: entry.entityIds, message: entry.message, authorLabel: entry.isLegacy ? "Imported" : "Archived author claim",
            isLegacy: entry.isLegacy,
            archive: { sourceId: route.source.id, baselineId: entry.baselineId, historyEpoch: entry.historyEpoch,
              observation: entry.observation.type } }
          entries.set(item.hash, item); result.push(item)
        }
        after = page.nextAfter ?? undefined
        if (!after) {
          const previous = await advance(route)
          if (previous && !sources.some(source => source.source.id === previous.source.id)) sources.push(previous)
          sourceIndex++
          releaseReader()
        }
      }
      return { entries: result, hasMore: sourceIndex < sources.length }
    },
    async readVersion(hash: string): Promise<ArchivedVersion> {
      await guard()
      const entry = entries.get(hash)
      if (!entry?.archive) throw new Error("Load this archived version before restoring it")
      const version = await (await readerFor(entry.archive.sourceId)).readItemVersion(entityId, hash)
      await guard()
      if (version.changeHash !== hash || version.baselineId !== entry.archive.baselineId || version.item.id !== entityId ||
          version.historyEpoch !== entry.archive.historyEpoch || version.observation !== entry.archive.observation) {
        throw new Error("Archived version differs from the selected original evidence")
      }
      return version
    },
    dispose() { releaseReader(); input.onDispose() },
  }
}
