import { BLOB_CHUNK_BYTES, type BlobDescriptor, type MeshBlobStore } from "@meta-uber/mesh-blob"
import { createBlobStreamDescriptor } from "@meta-uber/mesh-blob/stream"

async function* fileSlices(file: File) {
  for (let offset = 0; offset < file.size; offset += BLOB_CHUNK_BYTES) {
    yield new Uint8Array(await file.slice(offset, Math.min(offset + BLOB_CHUNK_BYTES, file.size)).arrayBuffer())
  }
}

/** Hash then replay bounded File slices; persistence publishes only after a second complete digest check. */
export async function storeFileAttachment(store: MeshBlobStore, file: File): Promise<BlobDescriptor> {
  const descriptor = await createBlobStreamDescriptor(fileSlices(file), file.size, file.name, file.type || "application/octet-stream")
  await store.putStream(descriptor, fileSlices(file))
  return descriptor
}
export { preloadBlobStreamStorage } from "@meta-uber/mesh-blob/stream"
