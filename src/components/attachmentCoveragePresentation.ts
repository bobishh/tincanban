import type { FileReference } from "../domain/model"
import type { AttachmentCoverageStatus } from "../sync/attachmentReplicationTypes"

export type { AttachmentCoverageStatus } from "../sync/attachmentReplicationTypes"

export type AttachmentCoveragePresentation = { label: string; error?: string }

const fallback: AttachmentCoveragePresentation = { label: "Not confirmed on Rusty" }

function blobId(file: Extract<FileReference, { type: "blob" }>): string | undefined {
  if (file.sha256) return `sha256:${file.sha256}`
  if (file.hash) return `blake3:${file.hash}`
  return undefined
}

function matchesFile(status: AttachmentCoverageStatus, workspaceId: string, file: FileReference): boolean {
  if (file.type !== "blob") return false
  const descriptor = status.descriptor
  return status.workspaceId === workspaceId && descriptor.blobId === blobId(file) &&
    descriptor.hash === file.hash && descriptor.name === file.fileName &&
    descriptor.mediaType === file.mimeType && descriptor.size === file.byteLength
}

function nonCompletePriority(status: AttachmentCoverageStatus): number {
  switch (status.phase) {
    case "uploading": return 0
    case "checking": return 1
    case "missing-source": return 2
    case "incomplete": return 3
    case "denied": return 4
    case "capacity": return 5
    case "unsupported": return 6
    case "unavailable": return 7
    case "complete": return 8
  }
}

export function attachmentCoveragePresentation(
  coverage: Record<string, AttachmentCoverageStatus[]> | undefined,
  workspaceId: string | undefined,
  file: FileReference | undefined,
): AttachmentCoveragePresentation {
  if (!coverage || !workspaceId || !file || file.type !== "blob") return fallback
  const matching = Object.values(coverage).flat().filter(status => matchesFile(status, workspaceId, file))
  if (matching.some(status => status.phase === "complete")) return { label: "Complete on Rusty" }
  const current = matching.sort((left, right) => nonCompletePriority(left) - nonCompletePriority(right))[0]
  if (!current) return fallback
  return {
    label: current.label,
    ...(current.error ? { error: current.error } : {}),
  }
}
