import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { blobDescriptor } from "../attachments"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"

export function workspaceBlobDescriptor(doc: WorkspaceDocumentV2, blobId: string, matches?: (value: BlobDescriptor) => boolean) {
  for (const entity of Object.values(doc.entities)) {
    const references = hasEntityKind(entity, "document")
      ? [entity.file]
      : hasEntityKind(entity, "artifact")
        ? [entity.pdf, entity.sourceMarkdown]
        : []
    for (const reference of references) {
      if (!reference) continue
      const descriptor = blobDescriptor(reference)
      if (descriptor?.blobId === blobId && (!matches || matches(descriptor))) return descriptor
    }
  }
  return undefined
}
