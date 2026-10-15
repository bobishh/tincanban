import { captureArchiveBytesReference, readArchiveIndexPage, validateArchiveObjectId, type ArchiveBytesReference,
  type ArchiveIndexRoot, type ArchiveObjectReadBinding, type ArchiveObjectStore,
  type ArchiveTreeContext } from "@meta-uber/mesh-replication/history-archive"
import { canonicalizeJson, sha256Base64Url, toBase64Url } from "../domain/identity"
import type { HistoryRecoveryEvidencePart } from "./historyRecoveryArchive"

export type PeerHistoryRecoverySource = {
  workspaceId: string; baselineId: string; signedJson: Uint8Array
  read(objectId: string, binding: ArchiveObjectReadBinding): Promise<Uint8Array | undefined>
}
type MissingPeerHistoryObject = { baselineId: string; objectId: string }
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true })
const hash = /^[A-Za-z0-9_-]{43}$/, changeHash = /^[a-f0-9]{64}$/
const MAX_BYTES = 512 * 1024 * 1024, MAX_OBJECTS = 1_048_576
class MissingPeerObject extends Error {}
function* parts(category: string, id: string, bytes: Uint8Array): Generator<HistoryRecoveryEvidencePart> {
  const size = 256 * 1024, partCount = Math.max(1, Math.ceil(bytes.length / size))
  for (let partIndex = 0; partIndex < partCount; partIndex++) yield { kind: "local-evidence-part", category, id, partIndex, partCount,
    data: toBase64Url(bytes.subarray(partIndex * size, (partIndex + 1) * size)) }
}
type SourcePayload = { workspaceId: string; baselineId: string; historyEpoch: number; admissionPolicy: string;
  archive: { context: ArchiveTreeContext; root: ArchiveIndexRoot; admissionRevision: string; authorityRevision: string; captureRevision: string } }
type IndexProgress = { complete: boolean; count: number }
type IndexEntry = { key: string; objectId: string }

class ExportBudget {
  readonly missing = new Map<string, MissingPeerHistoryObject>()
  readonly retained = new Set<string>()
  totalBytes = 0
  pageReads = 0
  indexEntryCount = 0
  constructor(readonly ensureCurrent: () => void | Promise<void>) {}
  unavailable(baselineId: string, objectId: string): never {
    const key = `${baselineId}:${objectId}`
    if (!this.missing.has(key) && this.missing.size >= 4096) throw new Error("Too many unavailable peer history objects")
    this.missing.set(key, { baselineId, objectId })
    throw new MissingPeerObject("Peer history object is unavailable")
  }
  retain(key: string, bytes: Uint8Array, pending: HistoryRecoveryEvidencePart[]) {
    if (!this.retained.has(key)) {
      this.totalBytes += bytes.length
      if (this.retained.size >= MAX_OBJECTS || this.totalBytes > MAX_BYTES) throw new Error("Peer history recovery exceeds its size bound")
      this.retained.add(key)
      pending.push(...parts("peer-history-object", key, bytes))
    }
    this.missing.delete(key)
  }
  visitPage(stackSize: number) {
    if (++this.pageReads > MAX_OBJECTS * 4 || stackSize > 32 * 64 + 1) throw new Error("Peer history page traversal exceeds its bound")
  }
  visitEntry() {
    if (++this.indexEntryCount > MAX_OBJECTS * 4) throw new Error("Peer history index entry traversal exceeds its bound")
  }
}

function sourcePayload(source: PeerHistoryRecoverySource, baselineIds: Set<string>): SourcePayload {
  assertSourceHeader(source, baselineIds)
  const envelope = JSON.parse(decoder.decode(source.signedJson)) as { payload: SourcePayload }
  const payload = envelope?.payload, context = payload?.archive?.context
  if (payload?.workspaceId !== source.workspaceId || payload.baselineId !== source.baselineId ||
      !Number.isSafeInteger(payload.historyEpoch) || payload.historyEpoch < 1 ||
      context?.workspaceId !== source.workspaceId || context.indexId !== "catalogue" || context.historyEpoch !== payload.historyEpoch) {
    throw new Error("Peer history recovery routing differs from its signed source")
  }
  return payload
}
function assertSourceHeader(source: PeerHistoryRecoverySource, baselineIds: Set<string>) {
  validateArchiveObjectId(source.baselineId)
  if (!hash.test(source.baselineId) || baselineIds.has(source.baselineId) || !source.workspaceId || source.workspaceId.length > 256 ||
      !source.signedJson.length || source.signedJson.length > 256 * 1024) throw new Error("Invalid peer history recovery source")
  baselineIds.add(source.baselineId)
}

function assertReadBinding(source: PeerHistoryRecoverySource, payload: SourcePayload,
  maximumBytes: number, binding: ArchiveObjectReadBinding | undefined) {
  if (!binding || binding.workspaceId !== source.workspaceId || binding.historyEpoch !== payload.historyEpoch ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 256 * 1024) {
    throw new Error("Peer history recovery read is not bound to its source")
  }
}
function assertRoot(root: ArchiveIndexRoot) {
  if (!root || !Number.isSafeInteger(root.count) || root.count < 0 || root.count > MAX_OBJECTS) throw new Error("Peer history index exceeds its bound")
}
function assertChangeRecord(source: PeerHistoryRecoverySource, payload: SourcePayload, id: string, value: Record<string, unknown>) {
  if (value.kind !== "workspace-history-archive-record" || value.version !== 1 || value.hash !== id ||
      value.workspaceId !== source.workspaceId || value.historyEpoch !== payload.historyEpoch ||
      !Number.isSafeInteger(value.dependencyCount) || (value.dependencyCount as number) < 0) {
    throw new Error("Peer change record differs from its catalogue provenance")
  }
  const expected = { captureRevision: payload.archive.captureRevision, admissionRevision: payload.archive.admissionRevision,
    authorityRevision: payload.archive.authorityRevision, admissionPolicy: payload.admissionPolicy }
  if (Object.entries(expected).some(([key, expectedValue]) => typeof value[key] !== "string" || value[key] !== expectedValue)) {
    throw new Error("Peer change record differs from its catalogue provenance")
  }
}

class PeerHistorySourceExport {
  readonly pending: HistoryRecoveryEvidencePart[] = []
  readonly byteTrees = new Set<string>()
  readonly capturedRecords = new Map<string, string>()
  readonly processedChanges = new Set<string>()
  readonly context: ArchiveTreeContext
  readonly store: ArchiveObjectStore
  constructor(readonly source: PeerHistoryRecoverySource, readonly payload: SourcePayload, readonly budget: ExportBudget) {
    this.context = payload.archive.context
    this.store = { read: (id, maximumBytes, binding) => this.read(id, maximumBytes, binding),
      async write() { throw new Error("Private history export cannot write to a peer archive") } }
  }
  child(indexId: string): ArchiveTreeContext { return { ...this.context, indexId } }
  *flush() { yield* this.pending.splice(0) }
  async read(objectId: string, maximumBytes: number, binding?: ArchiveObjectReadBinding) {
    await this.budget.ensureCurrent()
    validateArchiveObjectId(objectId)
    assertReadBinding(this.source, this.payload, maximumBytes, binding)
    const result = await this.source.read(objectId, structuredClone(binding!))
    const bytes = result instanceof Uint8Array ? result.slice() : undefined
    await this.budget.ensureCurrent()
    if (result === undefined) this.budget.unavailable(this.source.baselineId, objectId)
    if (!bytes || bytes.length > maximumBytes || await sha256Base64Url(bytes) !== objectId) {
      throw new Error("Peer history recovery object hash integrity failure")
    }
    await this.budget.ensureCurrent()
    this.budget.retain(`${this.source.baselineId}:${objectId}`, bytes, this.pending)
    return bytes
  }
  // DFS retains at most one bounded page per level and continues available siblings.
  async *indexEntries(context: ArchiveTreeContext, root: ArchiveIndexRoot, progress: IndexProgress = { complete: true, count: 0 }): AsyncGenerator<IndexEntry> {
    assertRoot(root)
    const stack = [structuredClone(root)]
    while (stack.length) {
      this.budget.visitPage(stack.length)
      const pointer = stack.pop()!
      let page
      try { page = await readArchiveIndexPage(context, pointer, this.store) }
      catch (error) { if (!(error instanceof MissingPeerObject)) throw error; progress.complete = false; continue }
      if ("entries" in page) {
        for (const entry of page.entries) { this.budget.visitEntry(); progress.count++; yield entry }
      } else for (let index = page.children.length - 1; index >= 0; index--) stack.push(page.children[index]!)
    }
    if (progress.complete && progress.count !== root.count) throw new Error("Peer history index count differs from its root")
  }
  async record(objectId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const bytes = await this.store.read(objectId, 64 * 1024, { ...this.context, objectKind: "record", partIndex: 0, partCount: 1 })
      const text = decoder.decode(bytes!), value = JSON.parse(text) as Record<string, unknown>
      if (!value || typeof value !== "object" || Array.isArray(value) || canonicalizeJson(value) !== text) throw new Error("Invalid peer history source record")
      return value
    } catch (error) { if (error instanceof MissingPeerObject) return undefined; throw error }
  }
  async *byteTree(indexId: string, input: unknown): AsyncGenerator<HistoryRecoveryEvidencePart> {
    const reference = captureArchiveBytesReference(input as ArchiveBytesReference)
    const treeKey = `${indexId}:${reference.root.objectId}`
    if (this.byteTrees.has(treeKey)) return
    this.byteTrees.add(treeKey)
    if (this.byteTrees.size > MAX_OBJECTS || reference.byteLength > MAX_BYTES) throw new Error("Peer history byte tree exceeds its bound")
    let previous = -1
    const progress = { complete: true, count: 0 }
    for await (const entry of this.indexEntries(this.child(indexId), reference.root, progress)) {
      yield* this.flush()
      const index = archivePartIndex(entry, previous, reference)
      previous = index
      await this.readPart(indexId, reference, entry, index)
      yield* this.flush()
    }
    yield* this.flush()
    if (progress.complete && progress.count !== reference.partCount) throw new Error("Peer archive part count differs from its reference")
  }
  async readPart(indexId: string, reference: ArchiveBytesReference, entry: IndexEntry, index: number) {
    try {
      const bytes = await this.store.read(entry.objectId, 256 * 1024, { ...this.child(indexId), objectKind: "part", partIndex: index, partCount: reference.partCount })
      if (bytes!.length !== Math.min(256 * 1024, reference.byteLength - index * 256 * 1024)) throw new Error("Peer archive part length differs from its reference")
    } catch (error) { if (!(error instanceof MissingPeerObject)) throw error }
  }
  async *changeRecord(id: string, value: Record<string, unknown>): AsyncGenerator<HistoryRecoveryEvidencePart> {
    assertChangeRecord(this.source, this.payload, id, value)
    if (this.processedChanges.has(id)) return
    this.processedChanges.add(id)
    yield* this.byteTree(`change/${id}/bytes`, value.bytes)
    yield* this.byteTree(`change/${id}/dependencies`, value.dependencies)
    for await (const proof of this.indexEntries(this.child(`change/${id}/authorizations`), value.authorizations as ArchiveIndexRoot)) {
      yield* this.flush()
      if (!/^[a-f0-9]{16}$/.test(proof.key)) throw new Error("Invalid peer original proof key")
      const reference = await this.record(proof.objectId)
      yield* this.flush()
      if (reference) yield* this.byteTree(`source-proof/${proof.key}`, reference)
    }
  }
  async *entityVersions(entry: IndexEntry, value: Record<string, unknown>, catalogueProgress: IndexProgress): AsyncGenerator<HistoryRecoveryEvidencePart> {
    const context = this.child(`${entry.key}/versions`)
    await assertEntityIndex(entry, value, context)
    for await (const version of this.indexEntries(context, value.root as ArchiveIndexRoot)) {
      yield* this.flush()
      const match = /^([a-f0-9]{16})\/([a-f0-9]{64})$/.exec(version.key)
      const known = match ? this.capturedRecords.get(match[2]!) : undefined
      if (!match || known !== undefined && known !== version.objectId || known === undefined && catalogueProgress.complete) {
        throw new Error("Peer entity version is not an original catalogue change")
      }
      const original = await this.record(version.objectId)
      yield* this.flush()
      if (!original) continue
      assertEntityChronology(value.entityId, match[1]!, original)
      yield* this.changeRecord(match[2]!, original)
    }
  }
  async *catalogueEntry(entry: IndexEntry, progress: IndexProgress): AsyncGenerator<HistoryRecoveryEvidencePart> {
    const originalHash = entry.key.startsWith("change/") && changeHash.test(entry.key.slice(7)) ? entry.key.slice(7) : undefined
    if (originalHash) this.capturedRecords.set(originalHash, entry.objectId)
    assertCatalogueEntry(entry.key, originalHash)
    const value = await this.record(entry.objectId)
    yield* this.flush()
    if (!value) return
    if (entry.key === "control" || entry.key === "document") yield* this.byteTree(`source-${entry.key}`, value)
    else if (/^(proof|pending)\/[a-f0-9]{16}$/.test(entry.key)) {
      const [kind, id] = entry.key.split("/")
      yield* this.byteTree(`source-${kind}/${id}`, value)
    } else if (originalHash) yield* this.changeRecord(originalHash, value)
    else yield* this.entityVersions(entry, value, progress)
  }
  async *evidence(): AsyncGenerator<HistoryRecoveryEvidencePart> {
    yield* parts("peer-history-source", this.source.baselineId, encoder.encode(canonicalizeJson({ version: 1,
      workspaceId: this.source.workspaceId, baselineId: this.source.baselineId, signedJson: toBase64Url(this.source.signedJson) })))
    const progress = { complete: true, count: 0 }
    for await (const entry of this.indexEntries(this.context, this.payload.archive.root, progress)) {
      yield* this.flush()
      yield* this.catalogueEntry(entry, progress)
    }
    yield* this.flush()
  }
}

function archivePartIndex(entry: IndexEntry, previous: number, reference: ArchiveBytesReference) {
  const index = /^[a-f0-9]{16}$/.test(entry.key) ? Number(BigInt(`0x${entry.key}`)) : -1
  if (!Number.isSafeInteger(index) || index <= previous || index >= reference.partCount) throw new Error("Peer archive part order differs from its reference")
  return index
}
function assertCatalogueEntry(key: string, originalHash: string | undefined) {
  if (!(key === "control" || key === "document" || /^(proof|pending)\/[a-f0-9]{16}$/.test(key) || originalHash ||
      key.startsWith("entity/") && hash.test(key.slice(7)))) throw new Error("Unknown peer history catalogue entry")
}
async function assertEntityIndex(entry: IndexEntry, value: Record<string, unknown>, context: ArchiveTreeContext) {
  if (value.kind !== "workspace-history-entity-index" || value.version !== 1 || typeof value.entityId !== "string" ||
      !value.entityId || encoder.encode(value.entityId).length > 1024 || value.entityId.includes("\0") ||
      await sha256Base64Url(encoder.encode(value.entityId)) !== entry.key.slice(7) ||
      canonicalizeJson(value.context) !== canonicalizeJson(context)) throw new Error("Peer entity index differs from its catalogue")
}
function assertEntityChronology(entityId: unknown, timeKey: string, original: Record<string, unknown>) {
  const metadata = original.metadata as { time?: unknown; entityIds?: unknown } | undefined
  if (!metadata || !Number.isSafeInteger(metadata.time) || !Array.isArray(metadata.entityIds) || !metadata.entityIds.includes(entityId)) {
    throw new Error("Peer entity version metadata differs from its original record")
  }
  const reverseTime = ((1n << 64n) - 1n) - (BigInt.asUintN(64, BigInt(metadata.time as number)) ^ (1n << 63n))
  if (timeKey !== reverseTime.toString(16).padStart(16, "0")) throw new Error("Peer entity version chronology differs from its original record")
}

/** Full, explicit private export. Signed roots bind bytes; Native admission remains a separate restore step. */
export function createPeerHistoryRecoveryEvidence(inputs: PeerHistoryRecoverySource[], ensureCurrent: () => void | Promise<void>,
  missingParents: Array<{ baselineId: string; objectId: string }> = []) {
  if (!Array.isArray(inputs) || inputs.length > 256 || typeof ensureCurrent !== "function") throw new Error("Invalid peer history recovery sources")
  if (!Array.isArray(missingParents) || missingParents.length > 4096) throw new Error("Peer history lineage exceeds its bound")
  const missingLineage = new Map<string, MissingPeerHistoryObject>()
  for (const item of missingParents) {
    validateArchiveObjectId(item.baselineId); validateArchiveObjectId(item.objectId)
    const key = `${item.baselineId}:${item.objectId}`
    missingLineage.set(key, { baselineId: item.baselineId, objectId: item.objectId })
  }
  const sources = inputs.map(source => {
    if (!source || !(source.signedJson instanceof Uint8Array) || typeof source.read !== "function") throw new Error("Invalid peer history recovery source")
    return { ...source, signedJson: source.signedJson.slice() }
  })
  const budget = new ExportBudget(ensureCurrent)
  let started = false
  async function* evidence(): AsyncGenerator<HistoryRecoveryEvidencePart> {
    if (started) throw new Error("Peer history recovery evidence can only be consumed once")
    started = true
    const baselineIds = new Set<string>()
    for (const source of sources) {
      await ensureCurrent()
      yield* new PeerHistorySourceExport(source, sourcePayload(source, baselineIds), budget).evidence()
    }
    await ensureCurrent()
  }
  return { evidence: evidence(), missingObjects: () => [...new Map([...budget.missing, ...missingLineage]).values()].sort((a, b) => {
    const left = `${a.baselineId}:${a.objectId}`, right = `${b.baselineId}:${b.objectId}`
    return left < right ? -1 : left > right ? 1 : 0
  }) }
}
