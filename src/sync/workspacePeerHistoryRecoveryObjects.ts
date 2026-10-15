import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../domain/identity"

const DATABASE = "tincanban-private-workspace-recovery-v1"
const STORE = "records"
const MAX_OBJECTS = 1_048_576
const MAX_BYTES = 512 * 1024 * 1024
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true })
type PeerSource = { version: 1; workspaceId: string; baselineId: string; signedJson: string }
type CachedPeerObject = { kind: "workspace-peer-history-recovery-object"; version: 1; personId: string; workspaceId: string;
  baselineId: string; objectId: string; digest: string; bytes: Uint8Array }
type DecodedPeerHistory = { journal: { receivedBaselines: Array<{ id: string; value: unknown }> }; auxiliary: Map<string, unknown> }

function persistence() { return new BrowserMeshStore(DATABASE, [STORE]) }
function validBinding(personId: string, workspaceId: string, baselineId?: string, objectId?: string): void {
  if (typeof personId !== "string" || !personId || personId.length > 512 || typeof workspaceId !== "string" ||
      !workspaceId || workspaceId.length > 256 || baselineId !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(baselineId) ||
      objectId !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(objectId)) throw new Error("Invalid peer history recovery binding")
}
function peerObjectKey(auxiliaryKey: string): { baselineId: string; objectId: string } {
  const match = /^peer-history-object\/([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/.exec(auxiliaryKey)
  if (!match) throw new Error("Invalid peer history recovery object key")
  return { baselineId: match[1]!, objectId: match[2]! }
}
function captureSource(value: unknown, workspaceId: string, baselineId: string): PeerSource {
  const source = structuredClone(value) as PeerSource
  if (!validSourceShape(source, workspaceId, baselineId)) throw new Error("Invalid peer history recovery source")
  const signed = fromBase64Url(source.signedJson)
  if (!signed.length || signed.length > 256 * 1024 || toBase64Url(signed) !== source.signedJson) throw new Error("Invalid peer history recovery signature bytes")
  let envelope: unknown
  try { envelope = JSON.parse(decoder.decode(signed)) } catch { throw new Error("Invalid peer history recovery signature bytes") }
  const payload = envelope && typeof envelope === "object" && !Array.isArray(envelope)
    ? (envelope as Record<string, unknown>).payload : undefined
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload as Record<string, unknown>).workspaceId !== workspaceId ||
      (payload as Record<string, unknown>).baselineId !== baselineId) throw new Error("Peer recovery source routing mismatch")
  return source
}
function validSourceShape(source: PeerSource, workspaceId: string, baselineId: string): boolean {
  return Boolean(source && typeof source === "object" && !Array.isArray(source) && Object.keys(source).length === 4 &&
    source.version === 1 && source.workspaceId === workspaceId && source.baselineId === baselineId &&
    typeof source.signedJson === "string" && source.signedJson.length <= Math.ceil(256 * 1024 * 4 / 3) &&
    /^[A-Za-z0-9_-]+$/.test(source.signedJson))
}
async function keyFor(personId: string, workspaceId: string, baselineId: string, objectId: string): Promise<string> {
  const digest = await sha256Base64Url(encoder.encode(canonicalizeJson([personId, workspaceId, baselineId, objectId])))
  return `workspace-recovery.peer-object.v1.${digest}`
}
function exactOriginalSource(decoded: DecodedPeerHistory, source: PeerSource, baselineId: string): void {
  const original = decoded.journal.receivedBaselines.find(row => {
    const value = row.value as { id?: unknown; workspaceId?: unknown; baselineId?: unknown; state?: unknown; signedJson?: unknown }
    const stagedWithoutCachedId = value?.baselineId === undefined && value.state === "staged" &&
      typeof value.id === "string" && value.id.startsWith(`${source.workspaceId}:staged:`)
    return value?.workspaceId === source.workspaceId && (value.baselineId === baselineId || stagedWithoutCachedId) &&
      value.signedJson instanceof Uint8Array
  })?.value as { signedJson: Uint8Array } | undefined
  const encoded = fromBase64Url(source.signedJson)
  if (!original || original.signedJson.length !== encoded.length || original.signedJson.some((byte, index) => byte !== encoded[index])) {
    throw new Error("Peer recovery source is not the exact saved baseline signature")
  }
}

/** Retain only validated opaque peer archive bytes; this cache grants no baseline or authorization authority. */
export async function retainDecodedPeerHistoryRecovery(personId: string, workspaceId: string, decodedValue: DecodedPeerHistory,
  ensureCurrent: () => void): Promise<void> {
  validBinding(personId, workspaceId)
  validateDecodedPeerRecovery(decodedValue, ensureCurrent)
  const auxiliary = await capturePeerRecoveryAuxiliary(personId, workspaceId, decodedValue, ensureCurrent)
  await persistPeerRecoveryObjects(personId, workspaceId, auxiliary, ensureCurrent)
}
function validateDecodedPeerRecovery(value: DecodedPeerHistory, ensureCurrent: () => void): void {
  if (!value || !(value.auxiliary instanceof Map) || !value.journal || !Array.isArray(value.journal.receivedBaselines) ||
      typeof ensureCurrent !== "function") throw new Error("Invalid decoded peer history recovery evidence")
  ensureCurrent()
}
async function capturePeerRecoveryAuxiliary(personId: string, workspaceId: string, decoded: DecodedPeerHistory,
  ensureCurrent: () => void): Promise<Map<string, unknown>> {
  const auxiliary = collectPeerEvidence(personId, workspaceId, decoded)
  assertPeerEvidenceSources(auxiliary)
  for (const [key, value] of auxiliary) {
    if (!key.startsWith("peer-history-object/")) continue
    if (!(value instanceof Uint8Array) || await sha256Base64Url(value) !== peerObjectKey(key).objectId) {
      throw new Error("Peer history recovery object hash mismatch")
    }
    ensureCurrent()
  }
  return auxiliary
}
function collectPeerEvidence(personId: string, workspaceId: string, decoded: DecodedPeerHistory): Map<string, unknown> {
  const auxiliary = new Map<string, unknown>()
  let totalBytes = 0, objectCount = 0
  for (const [key, value] of decoded.auxiliary) {
    if (typeof key !== "string" || !key.startsWith("peer-history-")) continue
    if (key.startsWith("peer-history-object/")) {
      const { baselineId, objectId } = peerObjectKey(key)
      validBinding(personId, workspaceId, baselineId, objectId)
      if (!(value instanceof Uint8Array) || value.length > 256 * 1024 || ++objectCount > MAX_OBJECTS ||
          (totalBytes += value.length) > MAX_BYTES) throw new Error("Invalid peer history recovery object bytes")
      auxiliary.set(key, value.slice())
      continue
    }
    if (!key.startsWith("peer-history-source/")) throw new Error("Unknown peer history recovery evidence")
    const baselineId = key.slice("peer-history-source/".length)
    validBinding(personId, workspaceId, baselineId)
    const source = captureSource(value, workspaceId, baselineId)
    exactOriginalSource(decoded, source, baselineId)
    auxiliary.set(key, source)
  }
  return auxiliary
}
function assertPeerEvidenceSources(auxiliary: Map<string, unknown>): void {
  for (const key of auxiliary.keys()) {
    if (!key.startsWith("peer-history-object/")) continue
    const { baselineId } = peerObjectKey(key)
    if (!auxiliary.has(`peer-history-source/${baselineId}`)) throw new Error("Peer history recovery object has no retained source")
  }
}
async function persistPeerRecoveryObjects(personId: string, workspaceId: string, auxiliary: Map<string, unknown>,
  ensureCurrent: () => void): Promise<void> {
  ensureCurrent()
  const database = persistence()
  for (const [key, bytes] of auxiliary) {
    if (!key.startsWith("peer-history-object/")) continue
    if (!(bytes instanceof Uint8Array)) throw new Error("Invalid peer history recovery object bytes")
    const { baselineId, objectId } = peerObjectKey(key)
    const digest = await sha256Base64Url(bytes)
    const storageKey = await keyFor(personId, workspaceId, baselineId, objectId)
    ensureCurrent()
    const value: CachedPeerObject = { kind: "workspace-peer-history-recovery-object", version: 1, personId,
      workspaceId, baselineId, objectId, digest, bytes }
    await database.updateRecords(STORE, [storageKey], current => {
      ensureCurrent()
      const old = current[0] as CachedPeerObject | undefined
      if (old === undefined) return { writes: [{ key: storageKey, value }], result: undefined }
      if (!old || old.kind !== value.kind || old.version !== 1 || old.personId !== personId || old.workspaceId !== workspaceId ||
          old.baselineId !== baselineId || old.objectId !== objectId || old.digest !== digest ||
          !(old.bytes instanceof Uint8Array) || old.bytes.length !== bytes.length || old.bytes.some((byte, index) => byte !== bytes[index])) {
        throw new Error("Immutable peer history recovery object changed")
      }
      return { writes: [], result: undefined }
    })
    ensureCurrent()
  }
}

/** Read exact retained bytes by local identity, workspace, and original baseline/object IDs. */
export async function readPeerHistoryRecoveryObject(personId: string, workspaceId: string, baselineId: string,
  objectId: string, ensureCurrent: () => void): Promise<Uint8Array | undefined> {
  validBinding(personId, workspaceId, baselineId, objectId)
  if (typeof ensureCurrent !== "function") throw new Error("Invalid peer history recovery guard")
  ensureCurrent()
  const key = await keyFor(personId, workspaceId, baselineId, objectId)
  ensureCurrent()
  const stored = await persistence().get<unknown>(STORE, key)
  ensureCurrent()
  if (stored === undefined) return undefined
  const value = structuredClone(stored) as CachedPeerObject
  if (!value || value.kind !== "workspace-peer-history-recovery-object" || value.version !== 1 || value.personId !== personId ||
      value.workspaceId !== workspaceId || value.baselineId !== baselineId || value.objectId !== objectId ||
      !(value.bytes instanceof Uint8Array) || value.bytes.length > 256 * 1024 ||
      await sha256Base64Url(value.bytes) !== objectId || value.digest !== objectId) {
    throw new Error("Stored peer history recovery object failed integrity validation")
  }
  ensureCurrent()
  return value.bytes.slice()
}
