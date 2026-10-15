import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import { chunkBlobSource, createBlobStreamVerifier, type BlobByteSource } from "@meta-uber/mesh-blob/stream"
import { AttachmentPreparationCodec, type AttachmentScope } from "./attachmentCodec"
import { blindObjectId, canonicalBlindJson } from "./blindClient"
import type { AttachmentPreparation } from "./attachmentPreparationData"
import type { AttachmentProgress, AttachmentTransferRepository } from "./attachmentTransfer"

/** No network or final manifest until the exact complete source digest has been verified. */
export async function prepareAttachmentStream(scope: AttachmentScope, descriptor: BlobDescriptor, binding: string,
  repository: AttachmentTransferRepository, guard: () => Promise<void>, source?: BlobByteSource): Promise<AttachmentProgress> {
  const preparation = repository.preparation
  if (!preparation) throw new Error("Attachment repository does not support streaming preparation")
  let state = await preparation.read()
  await guard()
  if (!state) {
    if (!source) throw new Error("Attachment source file is unavailable; no encrypted transfer is prepared")
    state = { version: 1, generation: 0, binding, descriptor, transferId: crypto.randomUUID(), manifestRequestId: crypto.randomUUID(), chunks: [] }
    await preparation.commit(null, state)
  }
  if (state.binding !== binding || canonicalBlindJson(state.descriptor) !== canonicalBlindJson(descriptor)) {
    throw new Error("Attachment preparation belongs to different storage access or file")
  }
  const codec = new AttachmentPreparationCodec(scope, descriptor, state.transferId)
  const verifier = createBlobStreamVerifier(descriptor)
  let verifiedChunks = 0
  const openSaved = async (chunk: AttachmentPreparation["chunks"][number]) => {
    await guard()
    const object = await repository.object(chunk.objectId)
    if (!object || await blindObjectId(object) !== chunk.objectId) throw new Error("Prepared attachment ciphertext is missing or corrupt")
    const bytes = await codec.openChunk(chunk.index, object)
    await guard()
    return bytes
  }
  if (source) {
    let index = 0
    for await (const bytes of chunkBlobSource(source)) {
      await guard()
      verifier.update(bytes)
      const saved = state.chunks[index]
      if (saved) {
        const previous = await openSaved(saved)
        if (previous.length !== bytes.length || previous.some((value, offset) => value !== bytes[offset])) {
          throw new Error("Attachment source chunk differs from the saved file; restore the original source")
        }
      } else {
        const object = await codec.sealChunk(index, bytes)
        const objectId = await blindObjectId(object)
        const next: AttachmentPreparation = { ...state, generation: state.generation + 1,
          chunks: [...state.chunks, { objectId, index, bytes: bytes.length, requestId: crypto.randomUUID() }] }
        await guard()
        await preparation.commit(state.generation, next, { objectId, object })
        state = next
      }
      index += 1
      verifiedChunks += 1
    }
  } else {
    if (state.chunks.length !== codec.chunkCount) throw new Error("Attachment source file is needed to finish the saved encrypted transfer")
    for (const chunk of state.chunks) { verifier.update(await openSaved(chunk)); verifiedChunks += 1 }
  }
  try { verifier.finish() }
  catch (cause) {
    // A complete mismatching file is unusable. Drop only its exact unpublished intent so a valid source can retry.
    if (verifiedChunks === codec.chunkCount) { await guard(); await preparation.discard(state) }
    throw cause
  }
  const sealed = await codec.sealManifest(state.chunks.map(({ index, objectId, bytes }) => ({ index, objectId, bytes })))
  const progress: AttachmentProgress = { version: 1, generation: 0, binding, descriptor,
    locator: sealed.locator, receipts: {}, received: [], objects: state.chunks.map(({ objectId, requestId }) => ({ objectId, requestId }))
      .concat({ objectId: sealed.locator.manifestId, requestId: state.manifestRequestId }) }
  await guard()
  await preparation.finish(state.generation, progress, { objectId: sealed.locator.manifestId, object: sealed.manifest })
  await guard()
  return progress
}
