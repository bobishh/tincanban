import { BrowserMeshStore, MemoryMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, sha256Base64Url } from "@meta-uber/mesh-identity"
import type { EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import type { HistoryPreparationIdentity } from "@meta-uber/mesh-replication/history-preparation-journal"
import { createWorkspaceHistoryPreparation } from "./historyPreparationRepository"
import { parseWireHistoryBaseline, type WireHistoryBaseline } from "../product-replica/historyBaselineReceiver"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindReplicaConfig } from "./blindReplication"
import { contentKeysForEpoch } from "./replicaContentKeys"

const STORE = "records"
const DATABASE = "tincanban-history-preparations-v1"
const memory = new MemoryMeshStore()
const encoder = new TextEncoder()
const HEAD_PREFIX = "meta-mesh.history-publication-head.v1."
export type WorkspaceHistoryPublication = {
  kind: "workspace-history-publication"
  version: 1
  workspaceId: string
  publicationId: string
  wire: WireHistoryBaseline
  preparations: HistoryPreparationIdentity[]
  savedAt: string
}
type Publication = WorkspaceHistoryPublication
type PublicationHead = { version: 1; workspaceId: string; baselineId: string; previousBaselineId: string | null;
  historyEpoch: number; publicationId: string; publicationKey: string }
const keyDigestCache = new WeakMap<object, Map<number, { keys: string[]; digest: Promise<string[]> }>>()

function store() { return typeof indexedDB === "undefined" ? memory : new BrowserMeshStore(DATABASE, [STORE]) }
function keyPrefix(workspaceId: string, digest: string) { return `meta-mesh.history-publication.v1.${digest}.${workspaceId}.` }
function headKey(workspaceId: string) { return HEAD_PREFIX + workspaceId }
function captureHead(value: unknown, workspaceId: string): PublicationHead {
  const head = structuredClone(value)
  exact(head, ["version", "workspaceId", "baselineId", "previousBaselineId", "historyEpoch", "publicationId", "publicationKey"])
  if (head.version !== 1 || head.workspaceId !== workspaceId || typeof head.baselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(head.baselineId) ||
      !(head.previousBaselineId === null || typeof head.previousBaselineId === "string" && /^[A-Za-z0-9_-]{43}$/.test(head.previousBaselineId)) ||
      !Number.isSafeInteger(head.historyEpoch) || (head.historyEpoch as number) < 1 || typeof head.publicationId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(head.publicationId) || typeof head.publicationKey !== "string" || !head.publicationKey.startsWith("meta-mesh.history-publication.v1.")) {
    throw new Error("Invalid current history publication head")
  }
  return head as PublicationHead
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid history publication record")
}

function capturePublication(value: unknown): Publication {
  const cloned = structuredClone(value)
  exact(cloned, ["kind", "version", "workspaceId", "publicationId", "wire", "preparations", "savedAt"])
  if (!validPublicationIdentity(cloned)) {
    throw new Error("Invalid history publication record")
  }
  const wire = parseWireHistoryBaseline(cloned.wire)
  if (wire.basis.context.workspaceId !== cloned.workspaceId) throw new Error("History publication workspace mismatch")
  const preparations = capturePreparations(cloned.preparations as unknown[], cloned.workspaceId)
  return { kind: "workspace-history-publication", version: 1, workspaceId: cloned.workspaceId,
    publicationId: cloned.publicationId, wire, preparations, savedAt: cloned.savedAt }
}
function validPublicationIdentity(value: Record<string, unknown>): value is Record<string, unknown> &
  { workspaceId: string; publicationId: string; savedAt: string; preparations: unknown[] } {
  return value.kind === "workspace-history-publication" && value.version === 1 &&
    typeof value.workspaceId === "string" && Boolean(value.workspaceId) && value.workspaceId.length <= 256 &&
    typeof value.publicationId === "string" && /^[0-9a-f-]{36}$/.test(value.publicationId) &&
    typeof value.savedAt === "string" && Number.isFinite(Date.parse(value.savedAt)) &&
    Array.isArray(value.preparations) && value.preparations.length >= 1 && value.preparations.length <= 8
}
function capturePreparations(value: unknown[], workspaceId: string): HistoryPreparationIdentity[] {
  const preparations = value.map(item => structuredClone(item) as HistoryPreparationIdentity)
  const transitions = new Set<string>()
  for (const preparation of preparations) {
    if (preparation.workspaceId !== workspaceId || transitions.has(preparation.transitionId)) {
      throw new Error("History publication preparation scope mismatch")
    }
    transitions.add(preparation.transitionId)
  }
  return preparations
}

async function baselineLink(publication: Publication): Promise<{ id: string; previous: string | null; epoch: number }> {
  let envelope: unknown
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(decodeBlindBytes(publication.wire.signedJson))
    envelope = JSON.parse(source)
  }
  catch { throw new Error("History publication has invalid signed baseline JSON") }
  if (canonicalizeJson(envelope) !== source) throw new Error("History publication baseline JSON is not canonical")
  const fields = baselinePayload(envelope, publication.workspaceId)
  const payloadCopy: Record<string, unknown> = structuredClone(fields)
  delete payloadCopy.baselineId
  const expectedId = await sha256Base64Url(encoder.encode(canonicalizeJson(payloadCopy)))
  if (expectedId !== fields.baselineId) throw new Error("History publication baseline identifier is invalid")
  return { id: fields.baselineId, previous: fields.previousBaselineId, epoch: fields.historyEpoch }
}
function baselinePayload(value: unknown, workspaceId: string): Record<string, unknown> &
  { baselineId: string; previousBaselineId: string | null; historyEpoch: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("History publication baseline is malformed")
  const payload = (value as Record<string, unknown>).payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("History publication baseline payload is malformed")
  const fields = payload as Record<string, unknown>
  if (!validBaselineLinkFields(fields, workspaceId)) {
    throw new Error("History publication baseline link is malformed")
  }
  return fields as Record<string, unknown> & { baselineId: string; previousBaselineId: string | null; historyEpoch: number }
}
function validBaselineLinkFields(fields: Record<string, unknown>, workspaceId: string): boolean {
  const previous = fields.previousBaselineId
  return fields.kind === "workspace-history-baseline" && typeof fields.baselineId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(fields.baselineId) &&
    (previous === null || typeof previous === "string" && /^[A-Za-z0-9_-]{43}$/.test(previous)) &&
    Number.isSafeInteger(fields.historyEpoch) && (fields.historyEpoch as number) >= 1 && fields.workspaceId === workspaceId
}

function publicationContent(publication: Publication): string {
  return canonicalizeJson({ kind: publication.kind, version: publication.version, workspaceId: publication.workspaceId,
    publicationId: publication.publicationId, wire: publication.wire, preparations: publication.preparations })
}

function retainedKeyDigests(config: BlindReplicaConfig, epoch: number): Promise<string[]> {
  const keys = contentKeysForEpoch(config, epoch)
  let epochs = keyDigestCache.get(config)
  if (!epochs) { epochs = new Map(); keyDigestCache.set(config, epochs) }
  const cached = epochs.get(epoch)
  if (cached && cached.keys.length === keys.length && cached.keys.every((key, index) => key === keys[index])) return cached.digest
  const digest = Promise.all(keys.map(key => sha256Base64Url(decodeBlindBytes(key))))
  epochs.set(epoch, { keys, digest })
  return digest
}

/** Immutable private head indexing exact encrypted preparation journals for recovery/export. */
export function publishWorkspaceHistoryRecord(input: Omit<Publication, "kind" | "version" | "savedAt">,
  ensureCurrent: () => void): Promise<Publication> { return storeHistoryPublication(input, ensureCurrent, true) }

/** Unactivated attempts retain exact immutable evidence without advancing the admitted publication head. */
export function retainPreparedHistoryPublication(input: Omit<Publication, "kind" | "version" | "savedAt">,
  ensureCurrent: () => void): Promise<Publication> { return storeHistoryPublication(input, ensureCurrent, false) }

async function storeHistoryPublication(input: Omit<Publication, "kind" | "version" | "savedAt">,
  ensureCurrent: () => void, advance: boolean): Promise<Publication> {
  const captured = capturePublication({ ...structuredClone(input), kind: "workspace-history-publication", version: 1,
    savedAt: new Date().toISOString() })
  const workspaceDigest = await sha256Base64Url(encoder.encode(captured.workspaceId))
  ensureCurrent()
  const prefix = keyPrefix(captured.workspaceId, workspaceDigest)
  const key = (advance ? prefix : prefix.replace("history-publication", "history-prepared-publication")) + captured.publicationId
  const persistence = store()
  const existing = await persistence.get<string>(STORE, key)
  ensureCurrent()
  if (existing) {
    const saved = capturePublication(JSON.parse(existing))
    if (publicationContent(saved) !== publicationContent(captured)) throw new Error("History publication identifier already names different evidence")
    if (advance) await advancePublicationHead(saved, key, ensureCurrent)
    return saved
  }
  const raw = canonicalizeJson(captured)
  if (!await persistence.compareAndSwap([{ store: STORE, key, expected: undefined }],
    [{ type: "put", store: STORE, key, value: raw }], ensureCurrent)) {
    const winner = await persistence.get<string>(STORE, key)
    if (winner === undefined || publicationContent(capturePublication(JSON.parse(winner))) !== publicationContent(captured)) {
      throw new Error("History publication changed during durable commit")
    }
    const saved = capturePublication(JSON.parse(winner))
    ensureCurrent()
    if (advance) await advancePublicationHead(saved, key, ensureCurrent)
    return saved
  }
  ensureCurrent()
  if (advance) await advancePublicationHead(captured, key, ensureCurrent)
  return captured
}

async function advancePublicationHead(publication: Publication, publicationKey: string, ensureCurrent: () => void): Promise<void> {
  const link = await baselineLink(publication)
  ensureCurrent()
  const persistence = store(), key = headKey(publication.workspaceId)
  let currentRaw = await persistence.get<string>(STORE, key)
  ensureCurrent()
  let previous: PublicationHead | undefined
  if (currentRaw !== undefined) previous = captureHead(JSON.parse(currentRaw), publication.workspaceId)
  else {
    await readCurrentWorkspaceHistoryPublication(publication.workspaceId, ensureCurrent)
    currentRaw = await persistence.get<string>(STORE, key)
    ensureCurrent()
    if (currentRaw !== undefined) previous = captureHead(JSON.parse(currentRaw), publication.workspaceId)
  }
  if (previous?.baselineId === link.id) {
    if (previous.publicationId !== publication.publicationId) throw new Error("History baseline is published under another record")
    return
  }
  if (previous ? link.previous !== previous.baselineId || link.epoch !== previous.historyEpoch + 1 : link.previous !== null || link.epoch !== 1) {
    throw new Error("History publication does not extend the current verified head")
  }
  const next: PublicationHead = { version: 1, workspaceId: publication.workspaceId, baselineId: link.id,
    previousBaselineId: link.previous, historyEpoch: link.epoch, publicationId: publication.publicationId, publicationKey }
  const nextRaw = canonicalizeJson(next)
  if (await persistence.compareAndSwap([{ store: STORE, key, expected: currentRaw }],
    [{ type: "put", store: STORE, key, value: nextRaw }], ensureCurrent)) return
  const winnerRaw = await persistence.get<string>(STORE, key)
  ensureCurrent()
  if (winnerRaw === undefined) throw new Error("History publication head changed during durable commit")
  const winner = captureHead(JSON.parse(winnerRaw), publication.workspaceId)
  if (winner.baselineId !== link.id || winner.publicationId !== publication.publicationId) {
    throw new Error("Another history publication advanced the current head")
  }
}

/** List exact owner-published wire heads without reading or rewriting archive evidence. */
export async function listWorkspaceHistoryPublications(workspaceId: string): Promise<WorkspaceHistoryPublication[]> {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 256) throw new Error("Invalid history workspace")
  const digest = await sha256Base64Url(encoder.encode(workspaceId))
  const prefix = keyPrefix(workspaceId, digest)
  const persistence = store()
  return scanPublications(persistence, prefix, workspaceId)
}

async function scanPublications(persistence: ReturnType<typeof store>, prefix: string, workspaceId: string): Promise<Publication[]> {
  const result: Publication[] = []
  let after: string | undefined
  while (true) {
    const page = await persistence.scan<unknown>(STORE, prefix, after, 64)
    if (page.entries.length > 64 || page.nextAfter !== null && page.nextAfter !== page.entries.at(-1)?.key) throw new Error("Invalid durable history publication page")
    after = appendPublicationPage(page.entries, prefix, workspaceId, after, result)
    if (page.nextAfter === null) return result
    if (!page.entries.length) throw new Error("History publication scan made no progress")
  }
}
function appendPublicationPage(entries: Array<{key:string;value:unknown}>, prefix: string, workspaceId: string,
  after: string | undefined, output: Publication[]): string | undefined {
  for (const entry of entries) {
    if (!entry.key.startsWith(prefix) || after !== undefined && entry.key <= after) throw new Error("History publication ordering changed")
    const publication = capturePublication(typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value)
    if (publication.workspaceId !== workspaceId || entry.key !== prefix + publication.publicationId) throw new Error("History publication key mismatch")
    output.push(publication)
    after = entry.key
  }
  return after
}

export async function readCurrentWorkspaceHistoryPublication(workspaceId: string, ensureCurrent: () => void): Promise<WorkspaceHistoryPublication | undefined> {
  ensureCurrent()
  const persistence = store(), key = headKey(workspaceId)
  let raw = await persistence.get<string>(STORE, key)
  ensureCurrent()
  if (raw !== undefined) {
    const head = captureHead(JSON.parse(raw), workspaceId)
    const value = await persistence.get<unknown>(STORE, head.publicationKey)
    ensureCurrent()
    if (value === undefined) throw new Error("Current history publication record is missing")
    const publication = capturePublication(typeof value === "string" ? JSON.parse(value) : value)
    if (publication.workspaceId !== workspaceId || publication.publicationId !== head.publicationId) throw new Error("Current history publication pointer is inconsistent")
    return publication
  }
  const publications = await listWorkspaceHistoryPublications(workspaceId)
  ensureCurrent()
  if (!publications.length) return undefined
  const current = await selectPublicationHead(publications)
  const digest = await sha256Base64Url(encoder.encode(workspaceId))
  const migratedHead: PublicationHead = { version: 1, workspaceId, baselineId: current.link.id,
    previousBaselineId: current.link.previous, historyEpoch: current.link.epoch, publicationId: current.publication.publicationId,
    publicationKey: keyPrefix(workspaceId, digest) + current.publication.publicationId }
  const migratedRaw = canonicalizeJson(migratedHead)
  await persistence.compareAndSwap([{ store: STORE, key, expected: undefined }],
    [{ type: "put", store: STORE, key, value: migratedRaw }], ensureCurrent)
  ensureCurrent()
  raw = await persistence.get<string>(STORE, key)
  ensureCurrent()
  if (raw === undefined || captureHead(JSON.parse(raw), workspaceId).baselineId !== current.link.id) {
    throw new Error("History publication head changed during migration")
  }
  return current.publication
}

async function selectPublicationHead(publications: Publication[]) {
  const byId = new Map<string, { publication: Publication; link: Awaited<ReturnType<typeof baselineLink>> }>()
  for (const publication of publications) {
    const link = await baselineLink(publication)
    if (byId.has(link.id)) throw new Error("History publication contains duplicate baseline identifiers")
    byId.set(link.id, { publication, link })
  }
  const roots = [...byId.values()].filter(item => item.link.epoch === 1 && item.link.previous === null)
  if (roots.length !== 1) throw new Error("History publication chain has no unique first baseline")
  let current = roots[0]!
  const visited = new Set([current.link.id])
  while (true) {
    const children = [...byId.values()].filter(item => item.link.previous === current.link.id)
    if (children.length > 1) throw new Error("History publication chain is forked")
    if (!children.length) break
    const next = children[0]!
    if (next.link.epoch !== current.link.epoch + 1 || visited.has(next.link.id)) throw new Error("History publication chain is inconsistent")
    current = next
    visited.add(current.link.id)
  }
  if (visited.size !== byId.size) throw new Error("History publication contains a detached baseline")
  return current
}

/** Resolve a publication only inside its pinned local workspace/Rusty storage configuration. */
export async function readPublishedHistoryBaseline(workspaceId: string, config: BlindReplicaConfig,
  ensureCurrent: () => void): Promise<{ wire: WireHistoryBaseline; baselineId: string } | undefined> {
  ensureCurrent()
  const publication = await readCurrentWorkspaceHistoryPublication(workspaceId, ensureCurrent)
  if (!publication) return undefined
  if (publication.workspaceId !== workspaceId || config.workspaceId !== workspaceId || publication.preparations.length < 1) {
    throw new Error("History publication belongs to another workspace")
  }
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBlindBytes(publication.wire.signedJson))) as {
    payload?: { baselineId?: unknown; previousBaselineId?: unknown; historyEpoch?: unknown; storage?: {
      authority?: { scopeId?: unknown; servicePublicKey?: unknown; policyRevision?: unknown }; keyEpoch?: unknown; keyDigest?: unknown }
    }
  }
  const payload = envelope.payload
  const storage = payload?.storage
  if (!await publicationMatchesConfig(publication, payload, storage, config)) {
    throw new Error("History publication does not match the current Rusty storage configuration")
  }
  ensureCurrent()
  return { wire: structuredClone(publication.wire), baselineId: payload!.baselineId as string }
}

async function publicationMatchesConfig(publication: Publication, payload: { baselineId?: unknown; previousBaselineId?: unknown;
  historyEpoch?: unknown; storage?: { authority?: { scopeId?: unknown; servicePublicKey?: unknown; policyRevision?: unknown };
  keyEpoch?: unknown; keyDigest?: unknown } } | undefined, storage: { authority?: { scopeId?: unknown;
  servicePublicKey?: unknown; policyRevision?: unknown }; keyEpoch?: unknown; keyDigest?: unknown } | undefined,
config: BlindReplicaConfig): Promise<boolean> {
  if (typeof payload?.baselineId !== "string" || !Number.isSafeInteger(payload.historyEpoch) || !storage ||
      storage.authority?.scopeId !== config.scopeId || storage.authority.servicePublicKey !== config.servicePublicKey ||
      !Number.isSafeInteger(storage.authority.policyRevision) || (storage.authority.policyRevision as number) > config.policyRevision ||
      typeof storage.keyDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(storage.keyDigest)) return false
  let candidateDigests: string[]
  try { candidateDigests = typeof storage.keyEpoch === "number" ? await retainedKeyDigests(config, storage.keyEpoch) : [] }
  catch { return false }
  return candidateDigests.includes(storage.keyDigest) && publication.preparations.every(item =>
    item.storage.scopeId === config.scopeId && item.storage.origin === config.origin &&
    item.storage.servicePublicKey === config.servicePublicKey && item.storage.policyRevision === storage.authority!.policyRevision &&
    item.storage.keyEpoch === storage.keyEpoch && item.storage.keyDigest === storage.keyDigest &&
    item.historyEpoch === payload.historyEpoch && item.previousBaselineId === payload.previousBaselineId)
}

/** Return locally retained archive ciphertext by its immutable Rusty identifier. */
export async function readPreparedHistoryObject(publicationInput: unknown, ciphertextId: string,
  ensureCurrent: () => void): Promise<EncryptedArchiveObject | undefined> {
  const publication = capturePublication(publicationInput)
  if (typeof ciphertextId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ciphertextId) || typeof ensureCurrent !== "function") {
    throw new Error("Invalid prepared history object lookup")
  }
  const matches: EncryptedArchiveObject[] = []
  for (const identity of publication.preparations) {
    ensureCurrent()
    const journal = createWorkspaceHistoryPreparation(identity, ensureCurrent)
    const prepared = await journal.readObject(ciphertextId)
    ensureCurrent()
    if (prepared) matches.push(structuredClone(prepared.sealed.object))
  }
  if (matches.length > 1 && matches.some(value => canonicalizeJson(value) !== canonicalizeJson(matches[0]))) {
    throw new Error("Prepared history ciphertext ID is ambiguous")
  }
  ensureCurrent()
  return matches[0]
}

export async function readPreparedHistoryPublication(workspaceId: string, publicationId: string, guard: () => void): Promise<Publication | undefined> {
  const digest = await sha256Base64Url(encoder.encode(workspaceId))
  const key = keyPrefix(workspaceId, digest).replace("history-publication", "history-prepared-publication") + publicationId
  const raw = await store().get<string>(STORE, key)
  guard()
  if (raw === undefined) return undefined
  const result = capturePublication(JSON.parse(raw))
  if (result.workspaceId !== workspaceId || result.publicationId !== publicationId) throw new Error("Prepared history publication binding changed")
  return result
}
export async function commitPreparedHistoryPublication(workspaceId: string, publicationId: string, guard: () => void): Promise<void> {
  const prepared = await readPreparedHistoryPublication(workspaceId, publicationId, guard)
  if (!prepared) throw new Error("Prepared history publication is unavailable")
  await publishWorkspaceHistoryRecord({ workspaceId, publicationId, wire: prepared.wire, preparations: prepared.preparations }, guard)
}
