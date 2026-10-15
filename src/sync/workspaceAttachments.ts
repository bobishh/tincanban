import { validateBlobDescriptor, type BlobDescriptor } from "@meta-uber/mesh-blob"
import { blobDescriptor } from "../attachments"
import { hasEntityKind, type FileReference, type WorkspaceDocumentV2 } from "../domain/model"

const maximumWorkspaceAttachments = 1024

/** Enumerate portable attachment metadata; local paths and transport tickets are never upload inputs. */
export function listWorkspaceAttachments(document: WorkspaceDocumentV2): BlobDescriptor[] {
  const descriptors = new Map<string, BlobDescriptor>()
  for (const entity of Object.values(document.entities)) {
    const references = hasEntityKind(entity, "document") ? [entity.file]
      : hasEntityKind(entity, "artifact") ? [entity.pdf, entity.sourceMarkdown]
        : []
    for (const reference of references) {
      if (!isFileReference(reference) || reference.type !== "blob") continue
      const descriptor = blobDescriptor(reference)
      if (!descriptor) continue
      delete descriptor.ticket
      const detached = validateBlobDescriptor(descriptor)
      descriptors.set(descriptorIdentity(detached), detached)
      if (descriptors.size > maximumWorkspaceAttachments) {
        throw new Error(`Workspace attachment count exceeds ${maximumWorkspaceAttachments}`)
      }
    }
  }
  return [...descriptors.values()].sort(compareDescriptors)
}

function isFileReference(value: unknown): value is FileReference {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function descriptorIdentity(descriptor: BlobDescriptor): string {
  return JSON.stringify([descriptor.blobId, descriptor.name, descriptor.mediaType, descriptor.size, descriptor.hash ?? null])
}

function compareDescriptors(left: BlobDescriptor, right: BlobDescriptor): number {
  return compareStrings(left.blobId, right.blobId) || compareStrings(left.name, right.name) ||
    compareStrings(left.mediaType, right.mediaType) || left.size - right.size ||
    compareStrings(left.hash ?? "", right.hash ?? "")
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
