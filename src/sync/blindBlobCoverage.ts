import { blindOrigin } from "./blindOrigin"
import { decodeBlindBytes } from "./blindEnvelope"
import { blindHash, canonicalBlindJson, fetchBlind, readBlindJson, blindProducerHeaders,
  type BlindAccess } from "./blindClient"

const MAX_RESPONSE_BYTES = 32 * 1024
const encoder = new TextEncoder()
const OBJECT_ID = /^[A-Za-z0-9_-]{43}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{20,64}$/

type BlindBlobCoverageObject = { objectId: string; keyEpoch: number }
export type BlindBlobCoverageReceipt = {
  payload: { kind: "blind-blob-coverage-receipt"; version: 1; serviceId: string; scopeId: string;
    policyRevision: number; requestId: string; objects: BlindBlobCoverageObject[] }
  signerKeyId: string
  signature: string
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function captureAccess(value: BlindAccess): BlindAccess {
  const access = structuredClone(value)
  if (!access || typeof access.scopeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(access.scopeId) ||
    typeof access.servicePublicKey !== "string" || typeof access.readToken !== "string" || !access.readToken ||
    !Number.isSafeInteger(access.policyRevision) || access.policyRevision < 0) throw new Error("Invalid Rusty blob coverage access")
  access.origin = blindOrigin(access.origin)
  if (decodeBlindBytes(access.servicePublicKey).length !== 32) throw new Error("Invalid Rusty service key")
  return access
}

function captureObjects(value: unknown): BlindBlobCoverageObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 33) throw new Error("Invalid Rusty blob coverage object count")
  const seen = new Set<string>()
  const objects = value.map(item => {
    if (!exactRecord(item, ["objectId", "keyEpoch"]) || typeof item.objectId !== "string" || !OBJECT_ID.test(item.objectId) ||
      !Number.isSafeInteger(item.keyEpoch) || (item.keyEpoch as number) < 1 || seen.has(item.objectId)) {
      throw new Error("Invalid Rusty blob coverage object")
    }
    seen.add(item.objectId)
    return { objectId: item.objectId, keyEpoch: item.keyEpoch as number }
  })
  return objects.sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0)
}

function captureRequestId(value: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw new Error("Invalid Rusty blob coverage request ID")
  return value
}

function validReceiptHeader(value: unknown): value is Record<string, unknown> {
  return exactRecord(value, ["payload", "signerKeyId", "signature"]) && typeof value.signerKeyId === "string" &&
    OBJECT_ID.test(value.signerKeyId) && typeof value.signature === "string"
}

function validReceiptPayload(value: unknown): value is Record<string, unknown> {
  if (!exactRecord(value, ["kind", "version", "serviceId", "scopeId", "policyRevision", "requestId", "objects"])) return false
  if (value.kind !== "blind-blob-coverage-receipt" || value.version !== 1 || typeof value.serviceId !== "string" ||
    !OBJECT_ID.test(value.serviceId)) return false
  if (typeof value.scopeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.scopeId) ||
    !Number.isSafeInteger(value.policyRevision) || (value.policyRevision as number) < 0) return false
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId) || !Array.isArray(value.objects) ||
    value.objects.length < 1 || value.objects.length > 33) return false
  return true
}

function parseReceiptObjects(value: unknown[]): BlindBlobCoverageObject[] {
  const objects = value.map(item => {
    if (!exactRecord(item, ["objectId", "keyEpoch"]) || typeof item.objectId !== "string" || !OBJECT_ID.test(item.objectId) ||
      !Number.isSafeInteger(item.keyEpoch) || (item.keyEpoch as number) < 1) throw new Error("Invalid Rusty blob coverage receipt objects")
    return { objectId: item.objectId, keyEpoch: item.keyEpoch as number }
  })
  if (new Set(objects.map(item => item.objectId)).size !== objects.length ||
    objects.some((item, index) => index > 0 && objects[index - 1]!.objectId >= item.objectId)) {
    throw new Error("Rusty blob coverage receipt objects are not uniquely sorted")
  }
  return objects
}

function parseReceipt(value: unknown): BlindBlobCoverageReceipt {
  if (!validReceiptHeader(value) || !validReceiptPayload(value.payload)) throw new Error("Invalid Rusty blob coverage receipt")
  const payload = value.payload
  const objects = parseReceiptObjects(payload.objects as unknown[])
  const signerKeyId = value.signerKeyId as string
  const signature = value.signature as string
  try { if (decodeBlindBytes(signature).length !== 64) throw new Error() }
  catch { throw new Error("Invalid Rusty blob coverage signature") }
  return structuredClone({ payload: { ...payload, objects }, signerKeyId, signature }) as BlindBlobCoverageReceipt
}

/** Verify exact scope, policy, request, sorted epoch list and pinned service signature. */
export async function verifyBlindBlobCoverageReceipt(receiptInput: unknown, accessInput: BlindAccess,
  objectsInput: unknown, requestIdInput: string): Promise<void> {
  const receipt = parseReceipt(structuredClone(receiptInput))
  const access = captureAccess(accessInput)
  const objects = captureObjects(structuredClone(objectsInput))
  const requestId = captureRequestId(requestIdInput)
  const payload = receipt.payload
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  if (payload.serviceId !== serviceId || receipt.signerKeyId !== serviceId || payload.scopeId !== access.scopeId ||
    payload.policyRevision !== access.policyRevision || payload.requestId !== requestId ||
    canonicalBlindJson(payload.objects) !== canonicalBlindJson(objects)) {
    throw new Error("Rusty blob coverage receipt does not cover this request")
  }
  const publicKey = await crypto.subtle.importKey("raw", decodeBlindBytes(access.servicePublicKey), "Ed25519", false, ["verify"])
  const message = encoder.encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)
  if (!await crypto.subtle.verify("Ed25519", publicKey, decodeBlindBytes(receipt.signature), message)) {
    throw new Error("Rusty blob coverage receipt signature invalid")
  }
}

/** Ask Rusty which exact encrypted blob IDs exist, using read-only credentials. */
export async function requestBlindBlobCoverage(accessInput: BlindAccess, objectsInput: unknown,
  requestIdInput: string = crypto.randomUUID()): Promise<BlindBlobCoverageReceipt> {
  const access = captureAccess(accessInput)
  const objects = captureObjects(structuredClone(objectsInput))
  const requestId = captureRequestId(requestIdInput)
  const body = { version: 1 as const, requestId, objects }
  const receipt = parseReceipt(await readBlindJson<unknown>(await fetchBlind(
    `${access.origin}/v2/scopes/${access.scopeId}/blob-coverage`, {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.readToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), MAX_RESPONSE_BYTES))
  await verifyBlindBlobCoverageReceipt(receipt, access, objects, requestId)
  return receipt
}
