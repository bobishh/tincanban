import { BLOB_CHUNK_BYTES, validateBlobDescriptor, type BlobDescriptor } from "@meta-uber/mesh-blob"
import { decodeBlindBytes } from "./blindEnvelope"
import type { BlindObject } from "./blindEnvelope"
import type { BlindBlobReceipt } from "./blindBlobClient"
import type { AttachmentProgress } from "./attachmentTransfer"

export const STATE_LIMIT = 256 * 1024
const OBJECT_LIMIT = 34
export const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const REQUEST_PATTERN = /^[A-Za-z0-9_-]{20,64}$/
const encoder = new TextEncoder()
export const hasExactKeys = (value: object, keys: readonly string[]) => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function fail(message: string): never { throw new Error(message) }

export function validateDescriptor(value: unknown): BlobDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Invalid attachment descriptor")
  const keys = Object.keys(value)
  if (keys.some(key => !["kind", "version", "blobId", "name", "mediaType", "size", "hash", "ticket"].includes(key)) ||
    !["kind", "version", "blobId", "name", "mediaType", "size"].every(key => Object.hasOwn(value, key))) return fail("Invalid attachment descriptor")
  try { validateBlobDescriptor(value as BlobDescriptor) } catch { return fail("Invalid attachment descriptor") }
  const descriptor = value as BlobDescriptor
  if (descriptor.ticket !== undefined && (typeof descriptor.ticket !== "string" || descriptor.ticket.length > 8192)) return fail("Invalid attachment descriptor")
  return structuredClone(descriptor)
}

function validateLocator(value: unknown, descriptor: BlobDescriptor): AttachmentProgress["locator"] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, ["version", "blobId", "transferId", "manifestId"])) {
    return fail("Invalid attachment locator")
  }
  const locator = value as AttachmentProgress["locator"]
  if (locator.version !== 1 || locator.blobId !== descriptor.blobId || typeof locator.transferId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(locator.transferId) || typeof locator.manifestId !== "string" || !ID_PATTERN.test(locator.manifestId)) {
    return fail("Invalid attachment locator")
  }
  return structuredClone(locator)
}

function validObjectMetadata(value: BlindObject): boolean {
  return value.version === 1 && typeof value.scopeId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.scopeId) &&
    Number.isSafeInteger(value.keyEpoch) && value.keyEpoch >= 1 && typeof value.nonce === "string" && typeof value.ciphertext === "string"
}

export function validateObject(value: unknown): BlindObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, ["version", "scopeId", "keyEpoch", "nonce", "ciphertext"])) {
    return fail("Invalid encrypted attachment object")
  }
  const object = value as BlindObject
  if (!validObjectMetadata(object)) return fail("Invalid encrypted attachment object")
  try {
    if (!validObjectEncoding(object)) return fail("Invalid encrypted attachment object")
  } catch { return fail("Invalid encrypted attachment object") }
  return structuredClone(object)
}

function validObjectEncoding(object: BlindObject): boolean {
  const nonce = decodeBlindBytes(object.nonce)
  const ciphertext = decodeBlindBytes(object.ciphertext)
  return nonce.length === 12 && ciphertext.length >= 16 && ciphertext.length <= BLOB_CHUNK_BYTES + 16
}

function isReceiptEnvelope(value: unknown): value is BlindBlobReceipt {
  return !!value && typeof value === "object" && !Array.isArray(value) && hasExactKeys(value, ["payload", "signerKeyId", "signature"])
}

function validReceiptPayload(value: unknown): value is BlindBlobReceipt["payload"] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value,
    ["kind", "version", "serviceId", "scopeId", "keyEpoch", "objectId", "policyRevision", "requestId"])) return false
  const payload = value as BlindBlobReceipt["payload"]
  return payload.kind === "blind-blob-storage-receipt" && payload.version === 1 && ID_PATTERN.test(payload.serviceId) &&
    typeof payload.scopeId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(payload.scopeId) &&
    Number.isSafeInteger(payload.keyEpoch) && payload.keyEpoch >= 1 && ID_PATTERN.test(payload.objectId) &&
    Number.isSafeInteger(payload.policyRevision) && payload.policyRevision >= 0 && REQUEST_PATTERN.test(payload.requestId)
}

function validateReceipt(value: unknown): BlindBlobReceipt {
  if (!isReceiptEnvelope(value)) return fail("Invalid attachment receipt")
  const receipt = value
  if (typeof receipt.signerKeyId !== "string" || !ID_PATTERN.test(receipt.signerKeyId) || typeof receipt.signature !== "string" ||
    !validReceiptPayload(receipt.payload)) return fail("Invalid attachment receipt")
  try { if (decodeBlindBytes(receipt.signature).length !== 64) return fail("Invalid attachment receipt") }
  catch { return fail("Invalid attachment receipt") }
  if (receipt.signerKeyId !== receipt.payload.serviceId) return fail("Invalid attachment receipt signer")
  return structuredClone(receipt)
}

function validateObjectPlan(value: unknown): AttachmentProgress["objects"] {
  if (!Array.isArray(value) || value.length > OBJECT_LIMIT) return fail("Invalid attachment object plan bounds")
  const objectIds = new Set<string>()
  const entries: unknown[] = value
  return entries.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !hasExactKeys(item, ["objectId", "requestId"])) {
      return fail("Invalid attachment object plan")
    }
    const candidate = item as Record<string, unknown>
    const objectId = candidate.objectId, requestId = candidate.requestId
    if (typeof objectId !== "string" || !ID_PATTERN.test(objectId) || typeof requestId !== "string" ||
      !REQUEST_PATTERN.test(requestId) || objectIds.has(objectId)) return fail("Invalid attachment object plan")
    objectIds.add(objectId)
    return { objectId, requestId }
  })
}

function validateReceived(value: unknown, objects: AttachmentProgress["objects"]): string[] {
  if (!Array.isArray(value) || value.length > OBJECT_LIMIT) return fail("Invalid received attachment object bounds")
  const objectIds = new Set(objects.map(object => object.objectId))
  const entries: unknown[] = value
  const received = entries.map(id => {
    if (typeof id !== "string" || !objectIds.has(id)) return fail("Invalid received attachment object")
    return id
  })
  if (new Set(received).size !== received.length) return fail("Duplicate received attachment object")
  return received
}

function validateReceipts(value: unknown, objects: AttachmentProgress["objects"]): Record<string, BlindBlobReceipt> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > OBJECT_LIMIT) return fail("Invalid attachment receipt bounds")
  const receipts: Record<string, BlindBlobReceipt> = Object.create(null) as Record<string, BlindBlobReceipt>
  const objectIds = new Set(objects.map(object => object.objectId))
  for (const [id, raw] of Object.entries(value)) {
    if (!objectIds.has(id)) return fail("Receipt is outside attachment object plan")
    const receipt = validateReceipt(raw)
    if (receipt.payload.objectId !== id || receipt.payload.requestId !== objects.find(object => object.objectId === id)?.requestId) {
      return fail("Receipt does not match attachment object plan")
    }
    receipts[id] = receipt
  }
  return receipts
}

export function validateProgress(value: unknown): AttachmentProgress {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value,
    ["version", "generation", "binding", "descriptor", "locator", "objects", "receipts", "received"])) return fail("Invalid attachment progress")
  const state = value as AttachmentProgress
  if (state.version !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0 || !ID_PATTERN.test(state.binding)) {
    return fail("Invalid attachment progress")
  }
  const descriptor = validateDescriptor(state.descriptor)
  const locator = validateLocator(state.locator, descriptor)
  const objects = validateObjectPlan(state.objects)
  const received = validateReceived(state.received, objects)
  const receipts = validateReceipts(state.receipts, objects)
  return { version: 1, generation: state.generation, binding: state.binding, descriptor, locator, objects, receipts, received }
}

export function parseProgress(raw: string | null): AttachmentProgress | null {
  if (raw === null) return null
  if (encoder.encode(raw).byteLength > STATE_LIMIT) return fail("Attachment progress exceeds storage bound")
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { return fail("Invalid attachment progress JSON") }
  return validateProgress(value)
}


export const attachmentObjectKey = (storageHash: string, objectId: string) => `tincanban.attachment-object.v1.${storageHash}.${objectId}`
