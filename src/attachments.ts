import type { BlobDescriptor, MeshBlobStore } from "@meta-uber/mesh-blob"
import type { BlobByteSource } from "@meta-uber/mesh-blob/stream"
import type { FileReference } from "./domain/model"
import { blobDescriptor } from "./domain/filePresentation"
export { blobDescriptor, attachmentMediaType, attachmentName, attachmentSize } from "./domain/filePresentation"

let storage: Promise<MeshBlobStore> | undefined
const blobs = () => storage ??= import("./attachmentBlobStore").then(module => module.attachmentBlobStore)
  .catch(cause => { storage = undefined; throw cause })

let fetchAttachment: ((descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>) | undefined

export function configureAttachmentFetcher(
  fetcher: ((descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>) | undefined,
): void {
  fetchAttachment = fetcher
}

export async function storeAttachment(file: File): Promise<FileReference> {
  const descriptor = await (await import("./attachmentFileStream")).storeFileAttachment(await blobs(), file)
  return referenceFromDescriptor(descriptor)
}

export async function readAttachment(
  reference: FileReference,
): Promise<Uint8Array | undefined> {
  const descriptor = blobDescriptor(reference)
  if (!descriptor) return undefined
  const local = await (await blobs()).getVerified(descriptor)
  if (local || !fetchAttachment) return local
  const received = await fetchAttachment(descriptor)
  if (!received) return undefined
  const cached = await (await blobs()).getVerified(descriptor)
  if (cached) return cached
  await (await blobs()).put(descriptor, received)
  return received
}

export async function readStoredAttachment(
  descriptor: BlobDescriptor,
): Promise<Uint8Array | undefined> {
  return (await blobs()).getVerified(descriptor)
}

export async function readStoredAttachmentStream(descriptor: BlobDescriptor): Promise<BlobByteSource | undefined> {
  const requested = structuredClone(descriptor)
  return (await blobs()).getStream(requested)
}

export async function writeStoredAttachmentStream(descriptor: BlobDescriptor, source: BlobByteSource,
  ensureCurrent: () => void): Promise<void> {
  const requested = structuredClone(descriptor)
  await (await blobs()).putStream(requested, source, { ensureCurrent })
}

export async function writeStoredAttachment(
  descriptor: BlobDescriptor,
  bytes: Uint8Array,
): Promise<void> {
  await (await blobs()).put(descriptor, bytes)
}

function referenceFromDescriptor(descriptor: BlobDescriptor): FileReference {
  return {
    type: "blob",
    ...(descriptor.blobId.startsWith("sha256:")
      ? { sha256: descriptor.blobId.slice("sha256:".length) }
      : { hash: descriptor.blobId.slice("blake3:".length) }),
    ...(descriptor.ticket ? { ticket: descriptor.ticket } : {}),
    byteLength: descriptor.size,
    mimeType: descriptor.mediaType,
    fileName: descriptor.name,
  }
}
