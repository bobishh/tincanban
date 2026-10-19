import * as Automerge from "@automerge/automerge/slim"
import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { createLocatedArchiveStore } from "@meta-uber/mesh-replication/history-archive-locators"
import { captureArchiveEncryptionScope, type ArchiveEncryptionScope, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { readArchiveIndex, readArchiveBytes, captureArchiveBytesReference,
  type ArchiveIndexRoot, type ArchiveBytesReference, type ArchiveTreeContext, type ArchiveObjectStore } from "@meta-uber/mesh-replication/history-archive"
import type { HistoryBaselineFetchPort } from "../product-replica/historyBaselineReceiver"
import type { PeerHistoryPlaintextFetch } from "./peerHistoryBaselineReceiver"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { isItem, validateEntity, type Item, type WorkspaceDocumentV2 } from "../domain/model"

type ArchivedHistoryObservation = { type: "admitted"; role: "owner" | "editor" | "visitor" | "automation" } |
  { type: "pending" | "quarantined"; reason: string }
type ArchivedEntityHistoryEntry = { hash: string; time: number; actor: string; action: string; entityIds: string[];
  message?: string | null; claimedPersonId?: string; claimedDeviceId?: string; isLegacy: boolean; observation: ArchivedHistoryObservation;
  baselineId: string; historyEpoch: number }
type ArchivedItemVersion = { item: Item; changeHash: string; baselineId: string; historyEpoch: number;
  observation: ArchivedHistoryObservation["type"]; originalChange: Uint8Array; originalAuthorizations: Uint8Array[] }
type CapturedChange = { kind: string; version: number; workspaceId: string; historyEpoch: number; hash: string;
  bytes: ArchiveBytesReference; dependencies: ArchiveBytesReference; dependencyCount: number; authorizations: ArchiveIndexRoot;
  observation: ArchivedHistoryObservation; admissionPolicy: string; admissionRevision: string; authorityRevision: string; captureRevision: string;
  metadata?: { time: number; actor: string; action: string; entityIds: string[]; personId?: string | null; deviceId?: string | null; message?: string | null; imported?: boolean } }
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true })
const maximumSelectedBytes = 256 * 1024 * 1024
const hashPattern = /^[a-f0-9]{64}$/
type ReaderPayload = { workspaceId: string; baselineId: string; historyEpoch: number; admissionPolicy: string;
  archive: { context: ArchiveTreeContext; root: ArchiveIndexRoot; admissionRevision: string; authorityRevision: string; captureRevision: string };
  locatorRoot: Parameters<typeof createLocatedArchiveStore>[1]; storage: { keyEpoch: number; authority: { scopeId: string } } }
type ReaderInput = { basis: WasmVerifiedReceivedHistoryBaseline; ensureCurrent: () => void } &
  ({ scope: ArchiveEncryptionScope; fetch: HistoryBaselineFetchPort } | { peerFetch: PeerHistoryPlaintextFetch })
type ReaderContext = { basis: WasmVerifiedReceivedHistoryBaseline; payload: ReaderPayload; scope?: ArchiveEncryptionScope;
  peerFetch?: PeerHistoryPlaintextFetch; ensureCurrent: () => void; remoteGuard: () => void | Promise<void>;
  download?: (id: string) => Promise<EncryptedArchiveObject>; assertCurrent: () => void; guard: () => Promise<void>;
  child: (indexId: string) => ArchiveTreeContext; dispose: () => void }
type ReadOperation = { objects: Map<string, EncryptedArchiveObject>; plaintextObjects: Map<string, Uint8Array>;
  store: ArchiveObjectStore; record: <T>(id: string) => Promise<T>; lookup: <T>(key: string) => Promise<T | undefined>;
  captured: (hash: string) => Promise<CapturedChange>; original: (indexId: string, reference: ArchiveBytesReference) => Promise<Uint8Array> }
function observation(value: unknown): asserts value is ArchivedHistoryObservation {
  const item = value as ArchivedHistoryObservation
  if (!item || !(item.type === "admitted" && ["owner", "editor", "visitor", "automation"].includes(item.role) ||
    (item.type === "pending" || item.type === "quarantined") && typeof item.reason === "string")) throw new Error("Invalid original archived admission observation")
}

/** Every root comes from an opaque Native basis. Listing is bounded and never fetches a source document. */
export function createHistoryArchiveReader(input: { basis: WasmVerifiedReceivedHistoryBaseline; ensureCurrent: () => void } &
  ({ scope: ArchiveEncryptionScope; fetch: HistoryBaselineFetchPort } | { peerFetch: PeerHistoryPlaintextFetch })) {
  const capturedInput = captureReaderInput(input as ReaderInput)
  const context = capturedInput
  return readerApi(context)
}

function captureReaderInput(input: ReaderInput): ReaderContext {
  input.ensureCurrent()
  if (!(input.basis instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("Archived history requires a Native-verified baseline")
  const scope = "scope" in input ? captureArchiveEncryptionScope(input.scope) : undefined
  const peerFetch = "peerFetch" in input ? { read: input.peerFetch.read, ensureCurrent: input.peerFetch.ensureCurrent } : undefined
  const remoteGuard = "fetch" in input ? input.fetch.ensureCurrent : peerFetch!.ensureCurrent
  const payload = readPayload(input.basis)
  if ((scope && (scope.scopeId !== payload.storage.authority.scopeId || scope.keyEpoch !== payload.storage.keyEpoch)) ||
      payload.archive.context.workspaceId !== payload.workspaceId) throw new Error("History reader scope differs from its Native-verified source")
  let disposed = false
  const assertCurrent = () => { ensureCurrent(); if (disposed) throw new Error("Archived history reader was closed") }
  const ensureCurrent = input.ensureCurrent
  const guard = async () => { assertCurrent(); await remoteGuard(); assertCurrent() }
  const context = payload.archive.context
  const child = (indexId: string): ArchiveTreeContext => ({ ...context, indexId })
  return { basis: input.basis, payload, scope, peerFetch, ensureCurrent, remoteGuard,
    download: "fetch" in input ? input.fetch.download : undefined, assertCurrent, guard, child,
    dispose: () => { disposed = true; scope?.key.fill(0) } }
}

function readPayload(basis: WasmVerifiedReceivedHistoryBaseline): ReaderPayload {
  const envelope: unknown = basis.envelope()
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Native history baseline envelope is malformed")
  const payload = (envelope as { payload?: unknown }).payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Native history baseline payload is malformed")
  return structuredClone(payload) as ReaderPayload
}

function readerApi(context: ReaderContext) {
  const { guard } = context
  return {
    async listEntity(entityId: string, query: { after?: string; limit?: number } = {}) {
      const request = captureEntityQuery(entityId, query)
      await guard()
      const op = createReadOperation(context)
      return listEntityPage(context, op, request.entityId, request.query)
    },
    async readItemVersion(entityId: string, hash: string): Promise<ArchivedItemVersion> {
      validateItemSelection(entityId, hash)
      await guard()
      const op = createReadOperation(context)
      return loadArchivedItemVersion(context, op, entityId, hash)
    },
    async verifyArchivedSnapshot(document: Uint8Array): Promise<void> {
      const bytes = new Uint8Array(document)
      await guard()
      if (!context.scope) throw new Error("Historical Rusty snapshot requires its pinned encrypted archive")
      const source = Automerge.load(bytes)
      let hashes: string[]
      try { hashes = Automerge.getChangesMetaSince(source, []).map(change => change.hash) }
      finally { Automerge.free(source) }
      const op = createReadOperation(context)
      for (const hash of hashes) {
        const captured = await op.captured(hash)
        await op.original(`change/${hash}/bytes`, captured.bytes)
      }
      await guard()
      context.basis.verifyArchivedSnapshot(context.scope.scopeId, context.scope.keyEpoch, context.scope.key,
        bytes, op.objects, context.assertCurrent)
      await guard()
    },
    dispose: context.dispose,
  }
}

function createReadOperation(context: ReaderContext): ReadOperation {
  const { guard, child, scope, payload } = context
  const peerFetch = context.peerFetch
  const objects = new Map<string, EncryptedArchiveObject>()
  const plaintextObjects = new Map<string, Uint8Array>()
  let bytes = 0
  const port: HistoryBaselineFetchPort = { ensureCurrent: guard, download: async id => {
    await guard()
    const previous = objects.get(id)
    if (previous) return structuredClone(previous)
    if (!context.download) throw new Error("Encrypted history reader has no archive source")
    const value = structuredClone(await context.download(id))
    await guard()
    bytes += encoder.encode(canonicalizeJson(value)).length
    if (bytes > 512 * 1024 * 1024 || objects.size >= 1_048_576) throw new Error("Selected encrypted history exceeds its read bound")
    objects.set(id, value); return structuredClone(value)
  } }
  const store: ArchiveObjectStore = scope ? createLocatedArchiveStore(scope, payload.locatorRoot, port) : {
    async read(id, maximumBytes, binding) {
      await guard()
      const previous = plaintextObjects.get(id)
      if (previous) return previous.slice()
      if (!binding) throw new Error("Peer history read requires an exact archive binding")
      const result = await peerFetch!.read(id, structuredClone(binding)); await guard()
      if (!(result instanceof Uint8Array)) throw new Error("Selected peer history is unavailable")
      const value = result.slice()
      if (value.length > maximumBytes || await sha256Base64Url(value) !== id) throw new Error("Peer history plaintext hash changed")
      await guard()
      bytes += value.length
      if (bytes > 512 * 1024 * 1024 || plaintextObjects.size >= 1_048_576) throw new Error("Selected peer history exceeds its read bound")
      plaintextObjects.set(id, value)
      return value.slice()
    },
    async write() { throw new Error("Peer history reader is read only") },
  }
  const record = async <T>(objectId: string): Promise<T> => {
    await guard()
    const bytes = await store.read(objectId, 64 * 1024, { ...payload.archive.context, objectKind: "record", partIndex: 0, partCount: 1 })
    await guard()
    if (!bytes) throw new Error("Archived history record is unavailable")
    const text = decoder.decode(bytes), value: unknown = JSON.parse(text)
    if (canonicalizeJson(value) !== text) throw new Error("Archived history record is not canonical")
    return value as T
  }
  const lookup = async <T>(key: string): Promise<T | undefined> => {
    const page = await readArchiveIndex(payload.archive.context, payload.archive.root, store, { prefix: key, limit: 2 })
    const found = page.entries.find(entry => entry.key === key)
    return found ? record<T>(found.objectId) : undefined
  }
  const captured = async (hash: string): Promise<CapturedChange> => {
    if (!hashPattern.test(hash)) throw new Error("Invalid selected original change hash")
    const value = await lookup<CapturedChange>(`change/${hash}`)
    if (!value || value.kind !== "workspace-history-archive-record" || value.version !== 1 || value.hash !== hash ||
      value.workspaceId !== payload.workspaceId || value.historyEpoch !== payload.historyEpoch ||
      value.captureRevision !== payload.archive.captureRevision || value.authorityRevision !== payload.archive.authorityRevision ||
      value.admissionRevision !== payload.archive.admissionRevision || value.admissionPolicy !== payload.admissionPolicy) throw new Error("Original archived change differs from signed catalogue")
    observation(value.observation)
    return value
  }
  let plaintextBytes = 0
  const original = async (indexId: string, reference: ArchiveBytesReference) => {
    const capturedReference = captureArchiveBytesReference(reference)
    if (capturedReference.byteLength > maximumSelectedBytes - plaintextBytes) throw new Error("Selected original history exceeds its byte bound")
    const parts = await readArchiveBytes(child(indexId), capturedReference, store)
    const result = new Uint8Array(capturedReference.byteLength)
    let offset = 0
    for await (const part of parts) { await guard(); result.set(part, offset); offset += part.length }
    plaintextBytes += result.length
    return result
  }
  return { objects, plaintextObjects, store, record, lookup, captured, original }
}

function captureEntityQuery(entityId: string, query: { after?: string; limit?: number }) {
  if (!entityId || encoder.encode(entityId).length > 1024 || entityId.includes("\0")) throw new Error("Invalid archived entity id")
  const captured = structuredClone(query), limit = captured.limit ?? 64
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid archived history page size")
  return { entityId, query: { after: captured.after, limit } }
}

function validateItemSelection(entityId: string, hash: string): void {
  if (!entityId || encoder.encode(entityId).length > 1024 || entityId.includes("\0") || !hashPattern.test(hash)) {
    throw new Error("Invalid archived item selection")
  }
}

async function listEntityPage(context: ReaderContext, op: ReadOperation, entityId: string,
  query: { after?: string; limit: number }): Promise<{ entries: ArchivedEntityHistoryEntry[]; nextAfter: string | null }> {
  const { child, guard } = context
  const digest = await sha256Base64Url(encoder.encode(entityId))
  const index = await op.lookup<{ kind: string; version: number; entityId: string; context: ArchiveTreeContext; root: ArchiveIndexRoot }>(`entity/${digest}`)
  if (!index) return { entries: [], nextAfter: null }
  if (index.kind !== "workspace-history-entity-index" || index.version !== 1 || index.entityId !== entityId ||
    canonicalizeJson(index.context) !== canonicalizeJson(child(`entity/${digest}/versions`))) throw new Error("Archived entity index differs from its signed source")
  const page = await readArchiveIndex(index.context, index.root, op.store, { after: query.after, limit: query.limit })
  const entries: ArchivedEntityHistoryEntry[] = []
  for (const entry of page.entries) entries.push(await readEntityVersionMetadata(context, op, entry.objectId, entry.key, entityId))
  await guard()
  return { entries, nextAfter: page.nextAfter }
}

async function readEntityVersionMetadata(context: ReaderContext, op: ReadOperation, objectId: string, key: string,
  entityId: string): Promise<ArchivedEntityHistoryEntry> {
  const { payload, guard } = context
  await guard()
  const value = await op.record<CapturedChange>(objectId), meta = value.metadata
  if (!validEntityMetadata(value, meta, payload, entityId)) throw new Error("Archived entity version metadata is malformed")
  const reverseTime = ((1n << 64n) - 1n) - (BigInt.asUintN(64, BigInt(meta.time)) ^ (1n << 63n))
  if (key !== `${reverseTime.toString(16).padStart(16, "0")}/${value.hash}`) throw new Error("Archived version chronology differs from its original timestamp")
  observation(value.observation)
  return { hash: value.hash, time: meta.time, actor: meta.actor, action: meta.action, entityIds: [...meta.entityIds], message: meta.message,
    isLegacy: meta.imported === true, ...(!meta.imported && meta.personId ? { claimedPersonId: meta.personId } : {}),
    ...(!meta.imported && meta.deviceId ? { claimedDeviceId: meta.deviceId } : {}), observation: structuredClone(value.observation),
    baselineId: payload.baselineId, historyEpoch: payload.historyEpoch }
}

function validEntityMetadata(value: CapturedChange, meta: CapturedChange["metadata"], payload: ReaderPayload,
  entityId: string): meta is NonNullable<CapturedChange["metadata"]> {
  return value.kind === "workspace-history-archive-record" && value.version === 1 && hashPattern.test(value.hash) &&
    value.workspaceId === payload.workspaceId && value.historyEpoch === payload.historyEpoch &&
    value.captureRevision === payload.archive.captureRevision && value.admissionRevision === payload.archive.admissionRevision &&
    value.authorityRevision === payload.archive.authorityRevision && value.admissionPolicy === payload.admissionPolicy &&
    isValidEntityMetadataFields(meta, entityId)
}

function isValidEntityMetadataFields(meta: CapturedChange["metadata"], entityId: string): meta is NonNullable<CapturedChange["metadata"]> {
  if (!meta || !Number.isSafeInteger(meta.time) || typeof meta.actor !== "string" || typeof meta.action !== "string" ||
      !validOptionalMetadata(meta) || !Array.isArray(meta.entityIds)) return false
  return meta.entityIds.includes(entityId) && meta.entityIds.every(id => typeof id === "string")
}

function validOptionalMetadata(meta: NonNullable<CapturedChange["metadata"]>): boolean {
  return (meta.imported === undefined || typeof meta.imported === "boolean") &&
    (meta.personId === undefined || meta.personId === null || typeof meta.personId === "string") &&
    (meta.deviceId === undefined || meta.deviceId === null || typeof meta.deviceId === "string") &&
    (meta.message === undefined || meta.message === null || typeof meta.message === "string")
}

async function loadArchivedItemVersion(context: ReaderContext, op: ReadOperation, entityId: string, hash: string): Promise<ArchivedItemVersion> {
  await loadOriginalClosure(context, op, hash)
  const { basis, scope, payload, assertCurrent } = context
  const verified = (scope ? basis.readArchivedEntityVersion(scope.scopeId, scope.keyEpoch, scope.key, entityId, hash, op.objects, assertCurrent) :
    basis.readArchivedPeerEntityVersion(entityId, hash, op.plaintextObjects, assertCurrent)) as {
    workspaceId: string; entityId: string; changeHash: string; baselineId: string; historyEpoch: number;
    document: number[] | Uint8Array; observation: ArchivedHistoryObservation; originalChange: number[] | Uint8Array; originalAuthorizations: Array<number[] | Uint8Array> }
  assertCurrent()
  if (verified.workspaceId !== payload.workspaceId || verified.entityId !== entityId || verified.changeHash !== hash ||
    verified.baselineId !== payload.baselineId || verified.historyEpoch !== payload.historyEpoch) throw new Error("Native archived source differs from selected version")
  observation(verified.observation)
  return materializeArchivedItem(context, verified, entityId, hash)
}

async function loadOriginalClosure(context: ReaderContext, op: ReadOperation, hash: string): Promise<void> {
  const queue = [hash], seen = new Set<string>()
  while (queue.length) {
    const current = queue.pop()!
    if (seen.has(current)) continue
    if (seen.size >= 1_048_576) throw new Error("Selected archived dependency closure exceeds limit")
    seen.add(current)
    const value = await op.captured(current)
    const raw = await op.original(`change/${current}/bytes`, value.bytes), decoded = Automerge.decodeChange(raw)
    if (decoded.hash !== current || decoded.deps.length !== value.dependencyCount) throw new Error("Archived original hash or dependencies changed")
    const deps = JSON.parse(decoder.decode(await op.original(`change/${current}/dependencies`, value.dependencies))) as unknown
    if (canonicalizeJson(deps) !== canonicalizeJson(decoded.deps)) throw new Error("Archived dependencies differ from signed original bytes")
    queue.push(...decoded.deps)
    if (current === hash) await loadArchivedProofs(context, op, current, value)
  }
}

async function loadArchivedProofs(context: ReaderContext, op: ReadOperation, hash: string, value: CapturedChange): Promise<void> {
  if (value.authorizations.count > 20_000) throw new Error("Selected original proof set exceeds limit")
  let after: string | undefined
  do {
    const page = await readArchiveIndex(context.child(`change/${hash}/authorizations`), value.authorizations, op.store, { after, limit: 256 })
    for (const proof of page.entries) {
      if (!/^[0-9a-f]{16}$/.test(proof.key)) throw new Error("Invalid original archived proof ordinal")
      const reference = await op.record<ArchiveBytesReference>(proof.objectId)
      await op.original(`source-proof/${proof.key}`, reference)
    }
    after = page.nextAfter ?? undefined
  } while (after)
}

function materializeArchivedItem(context: ReaderContext, verified: { document: number[] | Uint8Array; observation: ArchivedHistoryObservation;
  originalChange: number[] | Uint8Array; originalAuthorizations: Array<number[] | Uint8Array> }, entityId: string, hash: string): ArchivedItemVersion {
  const document = Automerge.load<WorkspaceDocumentV2>(new Uint8Array(verified.document))
  try {
    if (document.id !== context.payload.workspaceId) throw new Error("Archived item source belongs to another workspace")
    const parsed = validateEntity(document.entities[entityId])
    if (!parsed.ok || !isItem(parsed.value) || parsed.value.id !== entityId) throw new Error("Selected archived version has no valid item")
    return { item: structuredClone(parsed.value), changeHash: hash, baselineId: context.payload.baselineId,
      historyEpoch: context.payload.historyEpoch, observation: verified.observation.type, originalChange: new Uint8Array(verified.originalChange),
      originalAuthorizations: verified.originalAuthorizations.map(bytes => new Uint8Array(bytes)) }
  } finally { Automerge.free(document) }
}
