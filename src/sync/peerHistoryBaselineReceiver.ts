import { WasmStateCore, type WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { readArchiveIndex, type ArchiveIndexRoot, type ArchiveObjectReadBinding, type ArchiveObjectStore,
  type ArchiveTreeContext } from "@meta-uber/mesh-replication/history-archive"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import type { StoredReceivedHistoryBaseline } from "../storageJournal"

export type PeerHistoryPlaintextFetch = {
  ensureCurrent(): void | Promise<void>
  read(objectId: string, binding?: ArchiveObjectReadBinding): Promise<Uint8Array | undefined>
}
export type StoredPeerHistoryProofs = { version: 1; objects: Array<{ objectId: string; bytes: Uint8Array }> }
type PeerRoute = { workspaceId: string; historyEpoch: number; archive: { context: ArchiveTreeContext; root: ArchiveIndexRoot }; sourceHeads: string[] }
type PeerPayloadMetadata = PeerRoute & { baselineId: string; storage: { authority: unknown; keyEpoch: number } }
const decoder = new TextDecoder("utf-8", { fatal: true })

function parsePeerRoute(signedJson: Uint8Array): PeerRoute {
  const decoded = JSON.parse(decoder.decode(signedJson)) as unknown
  if (!isRecord(decoded) || !isRecord(decoded.payload)) throw new Error("Peer history envelope is malformed")
  const payload = decoded.payload
  if (typeof payload.workspaceId !== "string" || !Number.isSafeInteger(payload.historyEpoch) ||
      !isRecord(payload.archive) || !isRecord(payload.archive.context) || !isRecord(payload.archive.root) || !Array.isArray(payload.sourceHeads)) {
    throw new Error("Peer history bootstrap routing is invalid")
  }
  const context = payload.archive.context as unknown as ArchiveTreeContext
  if (context.workspaceId !== payload.workspaceId || context.historyEpoch !== payload.historyEpoch || context.indexId !== "catalogue" ||
      !payload.sourceHeads.every((hash: unknown) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) || payload.sourceHeads.length > 256) {
    throw new Error("Peer history bootstrap routing is invalid")
  }
  return payload as unknown as PeerRoute
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createProofStore(route: PeerRoute, fetch: PeerHistoryPlaintextFetch, ensureCurrent: () => void) {
  const objects = new Map<string, Uint8Array>()
  let byteCount = 0
  const guard = async () => { ensureCurrent(); await fetch.ensureCurrent(); ensureCurrent() }
  const store: ArchiveObjectStore = {
    async read(id, maximumBytes, binding) {
      await guard()
      const retained = objects.get(id)
      if (retained) return retained.slice()
      if (!binding || maximumBytes > 64 * 1024) throw new Error("Peer bootstrap may read only bounded proof pages and records")
      const result = await fetch.read(id, structuredClone(binding))
      await guard()
      if (!(result instanceof Uint8Array)) throw new Error("Peer history proof is unavailable")
      const bytes = result.slice()
      if (bytes.length > maximumBytes || await sha256Base64Url(bytes) !== id) throw new Error("Peer history plaintext proof hash changed")
      await guard()
      byteCount += bytes.length
      if (byteCount > 64 * 1024 * 1024 || objects.size >= 16_384) throw new Error("Peer history proof set exceeds its bootstrap bound")
      objects.set(id, bytes)
      return bytes.slice()
    },
    async write() { throw new Error("Peer history bootstrap is read only") },
  }
  return { objects, store, guard, route }
}

async function readRequiredProofs(context: ArchiveTreeContext, root: ArchiveIndexRoot, store: ArchiveObjectStore,
  sourceHeads: string[], guard: () => Promise<void>): Promise<void> {
  for (const key of ["control", "document", ...sourceHeads.map(hash => `change/${hash}`)]) {
    await guard()
    const page = await readArchiveIndex(context, root, store, { prefix: key, limit: 2 })
    const entry = page.entries.find(candidate => candidate.key === key)
    if (!entry) throw new Error("Peer history omits a required signed archive path")
    const bytes = await store.read(entry.objectId, 64 * 1024,
      { ...context, objectKind: "record", partIndex: 0, partCount: 1 })
    if (!bytes) throw new Error("Peer history source record is unavailable")
  }
}

/** This establishes Owner baseline authority. Public Rusty receipts are retained, without claiming ciphertext correspondence. */
export async function verifyPeerReceivedHistoryBaseline(input: {
  signedJson: Uint8Array; baselineDocument: Uint8Array; trustedScopeAuthority: unknown;
  previous?: WasmVerifiedReceivedHistoryBaseline | null; fetch: PeerHistoryPlaintextFetch; ensureCurrent(): void
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  input.ensureCurrent()
  const signedJson = new Uint8Array(input.signedJson), document = new Uint8Array(input.baselineDocument)
  const trusted = structuredClone(input.trustedScopeAuthority), previous = input.previous
  if (!signedJson.length || signedJson.length > 256 * 1024 || !document.length || document.length > 256 * 1024 * 1024) {
    throw new Error("Peer history bootstrap exceeds its signature or document bound")
  }
  const route = parsePeerRoute(signedJson)
  const proofs = createProofStore(route, input.fetch, input.ensureCurrent)
  await readRequiredProofs(route.archive.context, route.archive.root, proofs.store, route.sourceHeads, proofs.guard)
  await proofs.guard()
  const basis = previous
    ? WasmStateCore.verifyOwnerAttestedPeerHistoryBaselineFromParent(signedJson, document, trusted, previous, proofs.objects, input.ensureCurrent)
    : WasmStateCore.verifyOwnerAttestedPeerHistoryBaseline(signedJson, document, trusted, proofs.objects, input.ensureCurrent)
  try { await proofs.guard(); return basis } catch (error) { basis.free(); throw error }
}

function captureStoredProofs(stored: StoredReceivedHistoryBaseline): Map<string, Uint8Array> {
  const evidence = (stored as StoredReceivedHistoryBaseline & { peerProofs?: StoredPeerHistoryProofs }).peerProofs
  if (!evidence || evidence.version !== 1 || !Array.isArray(evidence.objects) || evidence.objects.length > 16_384) {
    throw new Error("Saved peer history proof set is missing or unsupported")
  }
  const objects = new Map<string, Uint8Array>()
  let bytes = 0
  for (const record of evidence.objects) {
    if (!record || typeof record.objectId !== "string" || !(record.bytes instanceof Uint8Array) || objects.has(record.objectId)) {
      throw new Error("Saved peer history proof set is malformed")
    }
    bytes += record.bytes.length
    if (bytes > 64 * 1024 * 1024) throw new Error("Saved peer history proof set exceeds its byte bound")
    objects.set(record.objectId, record.bytes)
  }
  return objects
}

function verifyStoredMetadata(basis: WasmVerifiedReceivedHistoryBaseline, stored: StoredReceivedHistoryBaseline): void {
  const envelope = basis.envelope() as unknown as { payload?: unknown }
  if (!isRecord(envelope.payload)) throw new Error("Saved peer history payload is invalid")
  const rawPayload = envelope.payload
  if (!isRecord(rawPayload.storage)) throw new Error("Saved peer history storage metadata is invalid")
  const storage = rawPayload.storage
  if (!isRecord(storage.authority)) throw new Error("Saved peer history storage metadata is invalid")
  const authority = storage.authority
  const payload = rawPayload as unknown as PeerPayloadMetadata
  if (payload.workspaceId !== stored.workspaceId || stored.baselineId && payload.baselineId !== stored.baselineId ||
      authority.scopeId !== stored.scopeId || storage.keyEpoch !== stored.keyEpoch ||
      canonicalizeJson(authority) !== canonicalizeJson(stored.pinnedStorage) ||
      stored.controlJson && canonicalizeJson(JSON.parse(decoder.decode(stored.controlJson))) !==
        canonicalizeJson(JSON.parse(decoder.decode(basis.controlJson())))) throw new Error("Saved peer history metadata differs from its verified source")
}

/** Restart always re-verifies bytes and signatures; the persisted row is never a trust token. */
export async function reverifyStoredPeerHistoryBaseline(input: {
  stored: StoredReceivedHistoryBaseline; trustedScopeAuthority: unknown; ensureCurrent(): void
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  input.ensureCurrent()
  const stored = structuredClone(input.stored)
  const objects = captureStoredProofs(stored)
  const basis = await verifyPeerReceivedHistoryBaseline({ signedJson: stored.signedJson, baselineDocument: stored.document,
    trustedScopeAuthority: input.trustedScopeAuthority, ensureCurrent: input.ensureCurrent,
    fetch: { ensureCurrent: input.ensureCurrent, read: async id => objects.get(id)?.slice() } })
  try { input.ensureCurrent(); verifyStoredMetadata(basis, stored); return basis }
  catch (error) { basis.free(); throw error }
}
