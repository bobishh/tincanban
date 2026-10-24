import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash, blindObjectId, canonicalBlindJson, blindProducerHeaders, type BlindAccess } from "./blindClient"
import { fetchBlind, readBlindJson } from "./rustyHttp"
import type { RustyFetch } from "@meta-uber/mesh-replication/rusty-replica"

const MAX_BLOB_CIPHERTEXT_BYTES = 1_048_592
const MAX_BLOB_RESPONSE_BYTES = 2 * 1024 * 1024
const encoder = new TextEncoder()

export type BlindBlobReceipt = {
  payload: { kind: "blind-blob-storage-receipt"; version: 1; serviceId: string; scopeId: string; keyEpoch: number;
    objectId: string; policyRevision: number; requestId: string }
  signerKeyId: string
  signature: string
}

const exactRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const ownKeys = Object.keys(value)
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validateAccess(access: BlindAccess): BlindAccess {
  const value = structuredClone(access)
  if (!value || !/^[-A-Za-z0-9_]{1,128}$/.test(value.scopeId) || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 0 ||
    typeof value.servicePublicKey !== "string" || typeof value.readToken !== "string" || typeof value.writeToken !== "string") {
    throw new Error("Invalid Rusty blob access")
  }
  value.origin = blindOrigin(value.origin)
  return value
}

function validateObject(value: unknown, scopeId: string): BlindObject {
  if (!exactRecord(value, ["version", "scopeId", "keyEpoch", "nonce", "ciphertext"]) || value.version !== 1 || value.scopeId !== scopeId ||
    !Number.isSafeInteger(value.keyEpoch) || (value.keyEpoch as number) < 1 || typeof value.nonce !== "string" || typeof value.ciphertext !== "string") {
    throw new Error("Invalid encrypted attachment object")
  }
  const nonce = decodeBlindBytes(value.nonce)
  const ciphertext = decodeBlindBytes(value.ciphertext)
  if (nonce.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_BLOB_CIPHERTEXT_BYTES) {
    throw new Error("Invalid encrypted attachment object")
  }
  return value as BlindObject
}

function validateRequestId(requestId: string): void {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(requestId)) throw new Error("Invalid Rusty blob request ID")
}

function parseReceipt(value: unknown): BlindBlobReceipt {
  if (!exactRecord(value, ["payload", "signerKeyId", "signature"]) || typeof value.signerKeyId !== "string" || typeof value.signature !== "string" ||
    !exactRecord(value.payload, ["kind", "version", "serviceId", "scopeId", "keyEpoch", "objectId", "policyRevision", "requestId"])) {
    throw new Error("Invalid Rusty blob receipt")
  }
  const payload = value.payload
  if (payload.kind !== "blind-blob-storage-receipt" || payload.version !== 1 || typeof payload.serviceId !== "string" ||
    typeof payload.scopeId !== "string" || !Number.isSafeInteger(payload.keyEpoch) || typeof payload.objectId !== "string" ||
    !Number.isSafeInteger(payload.policyRevision) || typeof payload.requestId !== "string") throw new Error("Invalid Rusty blob receipt")
  return value as unknown as BlindBlobReceipt
}

/** Verify a durable acknowledgement for exactly this immutable ciphertext and request. */
export async function verifyBlindBlobReceipt(input: BlindBlobReceipt, accessInput: BlindAccess, objectInput: BlindObject,
  requestIdInput: string): Promise<void> {
  const receipt = structuredClone(input)
  const access = validateAccess(accessInput)
  const object = validateObject(structuredClone(objectInput), access.scopeId)
  const requestId = requestIdInput
  validateRequestId(requestId)
  const validReceipt = parseReceipt(receipt)
  const payload = validReceipt.payload
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  const objectId = await blindObjectId(object)
  if (payload.serviceId !== serviceId || validReceipt.signerKeyId !== serviceId || payload.scopeId !== access.scopeId ||
    payload.keyEpoch !== object.keyEpoch || payload.objectId !== objectId || payload.requestId !== requestId ||
    !Number.isSafeInteger(payload.policyRevision) || payload.policyRevision !== access.policyRevision ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.objectId) || !/^[A-Za-z0-9_-]{43}$/.test(payload.serviceId)) {
    throw new Error("Rusty blob receipt does not cover this encrypted attachment")
  }
  const publicKey = await crypto.subtle.importKey("raw", decodeBlindBytes(access.servicePublicKey), "Ed25519", false, ["verify"])
  const message = encoder.encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)
  if (!await crypto.subtle.verify("Ed25519", publicKey, decodeBlindBytes(validReceipt.signature), message)) {
    throw new Error("Rusty blob receipt signature invalid")
  }
}

/** Upload an opaque attachment object and return only after verifying the service's signed durability receipt. */
export async function uploadBlindBlob(accessInput: BlindAccess, objectInput: BlindObject, requestIdInput: string,
  fetcher: RustyFetch = fetchBlind): Promise<BlindBlobReceipt> {
  const access = validateAccess(accessInput)
  const object = validateObject(structuredClone(objectInput), access.scopeId)
  const requestId = requestIdInput
  validateRequestId(requestId)
  const objectId = await blindObjectId(object)
  const receipt = await readBlindJson<unknown>(await fetcher(`${access.origin}/v2/scopes/${access.scopeId}/blobs/${objectId}?writerVersion=2`, {
    method: "PUT", signal: AbortSignal.timeout(30000), headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.writeToken}`,
      "Content-Type": "application/json", "X-Rusty-Request-Id": requestId }, body: JSON.stringify(object),
  }), 16384)
  const parsed = parseReceipt(receipt)
  await verifyBlindBlobReceipt(parsed, access, object, requestId)
  return parsed
}

/** Download an opaque ciphertext object; reject namespace, schema, encoding and digest mismatches. */
export async function downloadBlindBlob(accessInput: BlindAccess, idInput: string, fetcher: RustyFetch = fetchBlind): Promise<BlindObject> {
  const access = validateAccess(accessInput)
  const id = idInput
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Invalid encrypted attachment ID")
  const value = await readBlindJson<unknown>(await fetcher(`${access.origin}/v2/scopes/${access.scopeId}/blobs/${id}`, {
    signal: AbortSignal.timeout(30000), headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.readToken}` },
  }), MAX_BLOB_RESPONSE_BYTES)
  const object = validateObject(value, access.scopeId)
  if (await blindObjectId(object) !== id) throw new Error("Rusty attachment integrity failure")
  return object
}
