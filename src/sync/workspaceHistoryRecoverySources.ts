import { sha256Base64Url, toBase64Url } from "../domain/identity"
import type { PrivateReplicaWire } from "./privateReplicaPreferences"
import type { BlindReplicaConfig } from "./blindReplication"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { getPrivateReplicaConfigurations, getPrivateReplicaProgress } from "./privateReplicaRepository"
import { contentKeysForEpoch } from "./replicaContentKeys"
import { listWorkspaceHistoryPublications, readPreparedHistoryObject } from "./historyBaselinePublicationRepository"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { createArchiveRemote, ArchiveRemoteError } from "@meta-uber/mesh-replication/history-archive-remote"
import { openArchiveObject, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import type { ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"
import type { HistoryRecoveryArchiveSource } from "./historyRecoveryArchive"
import { fetchBlind } from "./rustyHttp"
import { listRetainedWorkspaceRecoveryArchives } from "./workspaceHistoryRecoveryArchives"
import { listWorkspaceRecoveryObjectIndexes, readWorkspaceRecoveryObject } from "./workspaceHistoryRecoveryObjects"
import { parseWireHistoryBaseline } from "../product-replica/historyBaselineReceiver"
import type { StoredReceivedHistoryBaseline } from "../storageJournalRecords"

type Routing = { payload: { workspaceId: string; baselineId: string; locatorRoot: ArchiveLocatorRoot;
  storage: { keyEpoch: number; authority: { scopeId: string; servicePublicKey: string } } } }
type AddSource = { id: string; signedJson: Uint8Array; basisRoot?: ArchiveLocatorRoot; keyDigest?: string;
  metadata: unknown; local: (id: string) => Promise<EncryptedArchiveObject | undefined> }
type SourceContext = { workspaceId: string; wire: PrivateReplicaWire; configurations: BlindReplicaConfig[];
  variants: BlindReplicaConfig[]; retainedObjects: Set<string>; guard: () => Promise<void> }

export function receivedHistoryHasRustyArchiveRoute(row: Pick<StoredReceivedHistoryBaseline, "peerProofs" | "wire">): boolean {
  return row.peerProofs === undefined || row.wire !== undefined
}

async function addRecoverySource(input: AddSource, context: SourceContext, sources: HistoryRecoveryArchiveSource[],
  readers: Map<string, (id: string) => Promise<EncryptedArchiveObject | undefined>>): Promise<void> {
  const routing = sourceRouting(input, context.workspaceId), payload = routing.payload, storage = payload.storage
  const scopeId = storage.authority.scopeId
  const keys = retainedReadingKeys(context.variants, scopeId, storage.authority.servicePublicKey, storage.keyEpoch)
  if (!keys.length) throw new Error("A retained history reading key is missing. Recover the private Rusty connection first.")
  const current = context.configurations.find(config => config.scopeId === scopeId && config.servicePublicKey === storage.authority.servicePublicKey)
  const read = sourceObjectReader(input, context, scopeId, current)
  const chosen = await selectReadingKey(input, payload.locatorRoot, scopeId, storage.keyEpoch, keys, read, context.guard)
  sources.push({ id: input.id, workspaceId: context.workspaceId, scope: { scopeId, keyEpoch: storage.keyEpoch, key: decodeBlindBytes(chosen) },
    roots: [payload.locatorRoot, ...(input.basisRoot ? [input.basisRoot] : [])], signedJson: input.signedJson.slice(),
    authorityEvidence: { evidence: input.metadata, retainedKeyCandidates: keys, originalSignedEnvelope: routing } })
  readers.set(input.id, read)
}
function sourceRouting(input: AddSource, workspaceId: string): Routing {
  if (input.signedJson.length > 256 * 1024) throw new Error("Stored history signature exceeds recovery limit")
  const routing = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.signedJson)) as Routing
  const { payload } = routing, storage = payload?.storage
  if (payload?.workspaceId !== workspaceId || !payload.locatorRoot || !storage?.authority || !Number.isSafeInteger(storage.keyEpoch)) {
    throw new Error("Stored history archive routing is invalid")
  }
  return routing
}
function retainedReadingKeys(variants: BlindReplicaConfig[], scopeId: string, servicePublicKey: string, epoch: number): string[] {
  return [...new Set(variants.filter(config => config.scopeId === scopeId && config.servicePublicKey === servicePublicKey)
    .flatMap(config => { try { return contentKeysForEpoch(config, epoch) } catch { return [] } }))]
}
function sourceObjectReader(input: AddSource, context: SourceContext, scopeId: string, current?: BlindReplicaConfig) {
  return async (id: string): Promise<EncryptedArchiveObject | undefined> => {
    await context.guard()
    const local = await input.local(id)
    await context.guard()
    if (local) return local
    const retained = await retainedObject(id, context, scopeId)
    if (retained) return retained
    if (!current) return undefined
    return fetchCurrentArchiveObject(id, current, context)
  }
}
async function retainedObject(id: string, context: SourceContext, scopeId: string): Promise<EncryptedArchiveObject | undefined> {
  if (!context.retainedObjects.has(`${scopeId}/${id}`)) return undefined
  const value = await readWorkspaceRecoveryObject(context.wire.personId, scopeId, id, () => {})
  await context.guard()
  return value
}
async function fetchCurrentArchiveObject(id: string, current: BlindReplicaConfig, context: SourceContext) {
  const remoteGuard = async () => { await context.guard(); await getPrivateReplicaProgress(context.wire.personId, current); await context.guard() }
  await remoteGuard()
  try { return await createArchiveRemote(current, { fetch: fetchBlind, ensureCurrent: remoteGuard }).download(id) }
  catch (error) { if (error instanceof ArchiveRemoteError && error.status === 404) return undefined; throw error }
}
async function selectReadingKey(input: AddSource, root: ArchiveLocatorRoot, scopeId: string, keyEpoch: number,
  keys: string[], read: (id: string) => Promise<EncryptedArchiveObject | undefined>, guard: () => Promise<void>): Promise<string> {
  if (input.keyDigest) return findDigestKey(keys, input.keyDigest)
  const rootObject = await read(root.root.ciphertextId)
  if (!rootObject) return keys[0]!
  return authenticateRootKey(keys, root, scopeId, keyEpoch, rootObject, guard)
}
async function findDigestKey(keys: string[], keyDigest: string): Promise<string> {
  for (const candidate of keys) if (await sha256Base64Url(decodeBlindBytes(candidate)) === keyDigest) return candidate
  throw new Error("History publication key digest does not match retained private access")
}
async function authenticateRootKey(keys: string[], root: ArchiveLocatorRoot, scopeId: string, keyEpoch: number,
  object: EncryptedArchiveObject, guard: () => Promise<void>): Promise<string> {
  for (const candidate of keys) {
    try {
      await openArchiveObject({ scopeId, keyEpoch, key: decodeBlindBytes(candidate) }, {
        ...root.context, objectId: root.root.objectId, objectKind: "page", partIndex: 0, partCount: 1,
      }, root.root.ciphertextId, object)
      return candidate
    } catch { await guard() }
  }
  throw new Error("Stored history root cannot be authenticated with retained reading keys")
}

/** Recovery retains all published/received roots. It does not choose or activate a baseline. */
export async function workspaceHistoryRecoverySources(workspaceId: string, wire: PrivateReplicaWire, guard: () => Promise<void>) {
  const sources: HistoryRecoveryArchiveSource[] = []
  const readers = new Map<string, (id: string) => Promise<EncryptedArchiveObject | undefined>>()
  const configurations = (await getPrivateReplicaConfigurations(wire.personId)).filter((config): config is BlindReplicaConfig =>
    config.purpose !== "identity" && config.workspaceId === workspaceId)
  const variants = wire.entries.flatMap(entry => entry.operations.flatMap(operation => operation.config && operation.config.purpose !== "identity" &&
    operation.config.workspaceId === workspaceId ? [operation.config] : []))
  await guard()
  const [publications, received] = await Promise.all([
    listWorkspaceHistoryPublications(workspaceId), createReceivedHistoryBaselineRepository(workspaceId, () => {}).readArchiveRecords(),
  ])
  await guard()
  const retainedIndexes = await listWorkspaceRecoveryObjectIndexes(wire.personId, workspaceId, () => {})
  await guard()
  const retainedObjects = new Set(retainedIndexes.flatMap(index => index.objects.map(object => `${object.scopeId}/${object.ciphertextId}`)))
  const sourceContext: SourceContext = { workspaceId, wire, configurations, variants, retainedObjects, guard }
  await addPublicationSources(publications, sourceContext, sources, readers)
  await addReceivedSources(received, sourceContext, sources, readers)
  await addRetainedSources(sourceContext, sources, readers)
  await guard()
  return { sources, download: async (source: HistoryRecoveryArchiveSource, ciphertextId: string) => {
    const read = readers.get(source.id)
    const original = sources.find(value => value.id === source.id)
    if (!read || !original || source.workspaceId !== workspaceId || source.scope.scopeId !== original.scope.scopeId ||
      source.scope.keyEpoch !== original.scope.keyEpoch) throw new Error("Recovery archive source changed")
    return read(ciphertextId)
  } }
}

async function addPublicationSources(publications: Awaited<ReturnType<typeof listWorkspaceHistoryPublications>>,
  context: SourceContext, sources: HistoryRecoveryArchiveSource[], readers: Map<string, (id: string) => Promise<EncryptedArchiveObject | undefined>>) {
  for (const publication of publications) await addRecoverySource({ id: `published:${publication.publicationId}`,
    signedJson: decodeBlindBytes(publication.wire.signedJson), basisRoot: publication.wire.basis.locatorRoot,
    keyDigest: publication.preparations[0]?.storage.keyDigest, metadata: publication,
    local: id => readPreparedHistoryObject(publication, id, () => {}) }, context, sources, readers)
}
async function addReceivedSources(received: Awaited<ReturnType<ReturnType<typeof createReceivedHistoryBaselineRepository>["readArchiveRecords"]>>,
  context: SourceContext, sources: HistoryRecoveryArchiveSource[], readers: Map<string, (id: string) => Promise<EncryptedArchiveObject | undefined>>) {
  for (const row of received) {
    const objects = new Map(row.encryptedObjects.map(entry => [entry.ciphertextId, entry.object as EncryptedArchiveObject]))
    const wire = row.wire === undefined ? undefined : parseWireHistoryBaseline(row.wire)
    if (wire && wire.signedJson !== toBase64Url(row.signedJson)) throw new Error("Received Rusty history route differs from its signed source")
    if (row.peerProofs) {
      const route = sourceRouting({ id: `received:${row.stageId}`, signedJson: row.signedJson, metadata: null,
        local: async () => undefined }, context.workspaceId)
      const storage = route.payload.storage
      if (!retainedReadingKeys(context.variants, storage.authority.scopeId, storage.authority.servicePublicKey, storage.keyEpoch).length) continue
    }
    if (!receivedHistoryHasRustyArchiveRoute(row) && !row.peerProofs) continue
    await addRecoverySource({ id: `received:${row.stageId}`, signedJson: row.signedJson, basisRoot: wire?.basis.locatorRoot,
      metadata: { baselineId: row.baselineId ?? null, scopeId: row.scopeId, keyEpoch: row.keyEpoch, pinnedStorage: row.pinnedStorage,
        ...(wire ? { wire } : {}) }, local: async id => structuredClone(objects.get(id)) }, context, sources, readers)
  }
}
async function addRetainedSources(context: SourceContext, sources: HistoryRecoveryArchiveSource[],
  readers: Map<string, (id: string) => Promise<EncryptedArchiveObject | undefined>>) {
  const retained = await listRetainedWorkspaceRecoveryArchives(context.wire.personId, context.workspaceId, () => {})
  for (const item of retained) await addRetainedSource(item.sourceId, item.source, context, sources, readers)
}
async function addRetainedSource(sourceId: string, source: Awaited<ReturnType<typeof listRetainedWorkspaceRecoveryArchives>>[number]["source"],
  context: SourceContext, sources: HistoryRecoveryArchiveSource[], readers: Map<string, (id: string) => Promise<EncryptedArchiveObject | undefined>>) {
  await context.guard()
  const signedJson = decodeBlindBytes(source.signedJson)
  const routing = sourceRouting({ id: sourceId, signedJson, metadata: null, local: async () => undefined }, context.workspaceId)
  const storage = routing.payload.storage
  if (storage.authority.scopeId !== source.scopeId || storage.keyEpoch !== source.keyEpoch) throw new Error("Retained history archive scope differs from its original signature")
  const current = context.configurations.find(config => config.scopeId === source.scopeId && config.servicePublicKey === storage.authority.servicePublicKey)
  sources.push({ id: sourceId, workspaceId: context.workspaceId, scope: { scopeId: source.scopeId, keyEpoch: source.keyEpoch,
    key: decodeBlindBytes(source.key) }, roots: structuredClone(source.roots), signedJson, authorityEvidence: structuredClone(source.authorityEvidence) })
  readers.set(sourceId, retainedSourceReader(source, context, current))
}
function retainedSourceReader(source: Awaited<ReturnType<typeof listRetainedWorkspaceRecoveryArchives>>[number]["source"],
  context: SourceContext, current?: BlindReplicaConfig) {
  return async (id: string): Promise<EncryptedArchiveObject | undefined> => {
    await context.guard()
    const local = await readWorkspaceRecoveryObject(context.wire.personId, source.scopeId, id, () => {})
    await context.guard()
    if (local || !current) return local
    return fetchCurrentArchiveObject(id, current, context)
  }
}
