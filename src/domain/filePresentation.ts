import type { FileReference } from "./entitySchemas"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"

export function blobDescriptor(reference: FileReference): BlobDescriptor | undefined {
  if (reference.type !== "blob") return undefined
  const blobId = reference.sha256 ? `sha256:${reference.sha256}` : reference.hash ? `blake3:${reference.hash}` : undefined
  if (!blobId) return undefined
  return { kind: "blob", version: 1, blobId, name: reference.fileName, mediaType: reference.mimeType,
    size: reference.byteLength, ...(reference.hash ? { hash: reference.hash } : {}), ...(reference.ticket ? { ticket: reference.ticket } : {}) }
}

export function attachmentName(reference: FileReference): string {
  return reference.fileName
}

export function attachmentMediaType(reference: FileReference): string {
  return reference.type === "blob" ? reference.mimeType : "application/octet-stream"
}

export function attachmentSize(reference: FileReference): number | undefined {
  return reference.type === "blob" ? reference.byteLength : undefined
}
