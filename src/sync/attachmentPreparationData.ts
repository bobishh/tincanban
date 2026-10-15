import { BLOB_CHUNK_BYTES, type BlobDescriptor } from "@meta-uber/mesh-blob"
import type { BlindObject } from "./blindEnvelope"
import type { AttachmentProgress } from "./attachmentTransfer"
import { ID_PATTERN, REQUEST_PATTERN, STATE_LIMIT, hasExactKeys, validateDescriptor } from "./attachmentRepositoryData"

export type AttachmentPreparation = {
  version: 1
  generation: number
  binding: string
  descriptor: BlobDescriptor
  transferId: string
  manifestRequestId: string
  chunks: Array<{ index: number; bytes: number; objectId: string; requestId: string }>
}
export type AttachmentPreparationRepository = {
  read(): Promise<AttachmentPreparation | null>
  commit(expected: number | null, next: AttachmentPreparation, object?: { objectId: string; object: BlindObject }): Promise<void>
  finish(expected: number, next: AttachmentProgress, manifest: { objectId: string; object: BlindObject }): Promise<void>
  discard(expected: AttachmentPreparation): Promise<void>
}

function validatePreparationIdentity(value: AttachmentPreparation, descriptor: BlobDescriptor): void {
  if (value.version !== 1 || typeof value.binding !== "string" || !ID_PATTERN.test(value.binding) ||
    typeof value.transferId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.transferId) ||
    typeof value.manifestRequestId !== "string" || !REQUEST_PATTERN.test(value.manifestRequestId) ||
    Object.hasOwn(descriptor, "ticket")) throw new Error("Invalid attachment preparation identity")
}

function validateChunk(chunk: AttachmentPreparation["chunks"][number], index: number, descriptor: BlobDescriptor): void {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk) || !hasExactKeys(chunk, ["index", "bytes", "objectId", "requestId"]) ||
    chunk.index !== index || chunk.bytes !== Math.min(BLOB_CHUNK_BYTES, descriptor.size - index * BLOB_CHUNK_BYTES) ||
    typeof chunk.objectId !== "string" || !ID_PATTERN.test(chunk.objectId) ||
    typeof chunk.requestId !== "string" || !REQUEST_PATTERN.test(chunk.requestId)) throw new Error("Invalid prepared attachment chunk")
}

function validateChunks(value: AttachmentPreparation, descriptor: BlobDescriptor): void {
  const count = Math.ceil(descriptor.size / BLOB_CHUNK_BYTES)
  if (!Array.isArray(value.chunks) || value.chunks.length > count || value.generation !== value.chunks.length) {
    throw new Error("Invalid attachment preparation bounds")
  }
  const ids = new Set<string>(), requests = new Set<string>([value.manifestRequestId])
  for (const [index, chunk] of value.chunks.entries()) {
    validateChunk(chunk, index, descriptor)
    if (ids.has(chunk.objectId) || requests.has(chunk.requestId)) throw new Error("Duplicate prepared attachment chunk identity")
    ids.add(chunk.objectId)
    requests.add(chunk.requestId)
  }
}

export function parseAttachmentPreparation(raw: string | null): AttachmentPreparation | null {
  if (raw === null) return null
  if (new TextEncoder().encode(raw).byteLength > STATE_LIMIT) throw new Error("Attachment preparation exceeds storage bound")
  const candidate: unknown = JSON.parse(raw)
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !hasExactKeys(candidate,
    ["version", "generation", "binding", "descriptor", "transferId", "manifestRequestId", "chunks"])) throw new Error("Invalid attachment preparation")
  const value = candidate as AttachmentPreparation
  const descriptor = validateDescriptor(value.descriptor)
  validatePreparationIdentity(value, descriptor)
  validateChunks(value, descriptor)
  return { ...value, descriptor }
}
