import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { canonicalizeJson } from "@meta-uber/mesh-identity"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { parseWireHistoryBaseline, type WireHistoryBaseline } from "../product-replica/historyBaselineReceiver"
import type { StoredReceivedHistoryBaseline } from "../storageJournal"

const MAX_BASELINE_DOCUMENT_BYTES = 256 * 1024 * 1024
const MAX_SIGNED_BASELINE_BYTES = 256 * 1024
const MAX_CAPTURED_ENCRYPTED_BYTES = 512 * 1024 * 1024
type CandidateEnvelope = { payload?: { workspaceId?: unknown; baselineId?: unknown;
  storage?: { keyEpoch?: unknown; authority?: Record<string, unknown> } } }

function assertCandidateData(signedJson: Uint8Array, document: Uint8Array, controlJson: Uint8Array, objectMap: Map<unknown, unknown>) {
  if (!(signedJson instanceof Uint8Array) || signedJson.length === 0 || signedJson.length > MAX_SIGNED_BASELINE_BYTES ||
      !(document instanceof Uint8Array) || document.length === 0 || document.length > MAX_BASELINE_DOCUMENT_BYTES ||
      !(controlJson instanceof Uint8Array) || !(objectMap instanceof Map) || objectMap.size > 8192) {
    throw new Error("Native history baseline candidate is malformed")
  }
}
function candidateStorage(envelope: CandidateEnvelope) {
  if (envelope?.payload?.workspaceId === undefined || typeof envelope.payload.baselineId !== "string" || !envelope.payload.baselineId) {
    throw new Error("Native history baseline candidate is malformed")
  }
  const storage = envelope.payload.storage
  if (!storage || !Number.isSafeInteger(storage.keyEpoch) || (storage.keyEpoch as number) < 1 ||
      !storage.authority || typeof storage.authority.scopeId !== "string" || !storage.authority.scopeId) {
    throw new Error("Native history baseline storage binding is malformed")
  }
  return { scopeId: storage.authority.scopeId, keyEpoch: storage.keyEpoch as number,
    pinnedStorage: structuredClone(storage.authority), workspaceId: String(envelope.payload.workspaceId), baselineId: envelope.payload.baselineId }
}
function encryptedEvidence(objectMap: Map<unknown, unknown>) {
  const encryptedObjects: Array<{ ciphertextId: string; object: unknown }> = []
  let encryptedBytes = 0
  for (const [ciphertextId, object] of objectMap.entries()) {
    if (typeof ciphertextId !== "string" || !ciphertextId || encryptedObjects.length >= 8192) {
      throw new Error("Native history encrypted evidence is malformed")
    }
    const detached = structuredClone(object)
    encryptedBytes += new TextEncoder().encode(canonicalizeJson(detached)).length
    if (encryptedBytes > MAX_CAPTURED_ENCRYPTED_BYTES) throw new Error("Native history encrypted evidence exceeds its retention limit")
    encryptedObjects.push({ ciphertextId, object: detached })
  }
  return encryptedObjects
}
function peerEvidence(verification: string, objectMap: Map<unknown, unknown>, peerObjects: Map<string, Uint8Array>) {
  const peerProofs: NonNullable<StoredReceivedHistoryBaseline["peerProofs"]> = { version: 1, objects: [] }
  if (verification !== "public-receipts-only") {
    if (verification !== "encrypted-correspondence" || peerObjects.size !== 0) throw new Error("Native history verification mode is unsupported")
    return undefined
  }
  if (objectMap.size !== 0 || peerObjects.size === 0 || peerObjects.size > 16_384) {
    throw new Error("Native peer history proof evidence is malformed")
  }
  let peerBytes = 0
  for (const [objectId, object] of peerObjects.entries()) {
    if (typeof objectId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(objectId) || !(object instanceof Uint8Array) ||
        peerProofs.objects.length >= 16_384) throw new Error("Native peer history proof evidence is malformed")
    peerBytes += object.byteLength
    if (peerBytes > 64 * 1024 * 1024) throw new Error("Native peer history proof evidence exceeds its retention limit")
    peerProofs.objects.push({ objectId, bytes: object.slice() })
  }
  return peerProofs
}
function assertCandidateWire(wire: WireHistoryBaseline | undefined, envelope: CandidateEnvelope, signedJson: Uint8Array) {
  if (wire && (wire.basis.context.workspaceId !== envelope.payload!.workspaceId ||
      decodeBlindBytes(wire.signedJson).some((byte, index) => byte !== signedJson[index]) ||
      decodeBlindBytes(wire.signedJson).length !== signedJson.length)) {
    throw new Error("Received history routing differs from its Native-verified signature")
  }
}

/** Capture only opaque Native evidence; routing alone cannot create a verified candidate. */
export function captureReceivedHistoryCandidate(candidate: WasmVerifiedReceivedHistoryBaseline, wireInput?: unknown) {
  if (!(candidate instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("History baseline must be Native-verified")
  const signedJson = candidate.originalJson(), document = candidate.document(), controlJson = candidate.controlJson()
  const objectMap = candidate.encryptedObjects() as Map<unknown, unknown>
  const verification = candidate.storageVerification(), peerObjects = candidate.plaintextObjects() as Map<string, Uint8Array>
  const envelope = candidate.envelope() as CandidateEnvelope
  assertCandidateData(signedJson, document, controlJson, objectMap)
  const storage = candidateStorage(envelope)
  const encryptedObjects = encryptedEvidence(objectMap)
  const peerProofs = peerEvidence(verification, objectMap, peerObjects)
  const wire = wireInput === undefined ? undefined : parseWireHistoryBaseline(wireInput)
  assertCandidateWire(wire, envelope, signedJson)
  return { signedJson: signedJson.slice(), document: document.slice(), controlJson: controlJson.slice(), encryptedObjects,
    ...(peerProofs ? { peerProofs } : {}), ...storage, ...(wire ? { wire } : {}) }
}
export type ReceivedHistoryCandidate = ReturnType<typeof captureReceivedHistoryCandidate>
