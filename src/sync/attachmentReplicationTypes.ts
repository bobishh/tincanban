import type { BlobDescriptor } from "@meta-uber/mesh-blob"

export type AttachmentCoverageStatus = {
  workspaceId: string
  descriptor: BlobDescriptor
  phase: "checking" | "uploading" | "complete" | "missing-source" | "incomplete" | "unavailable" | "denied" | "unsupported" | "capacity"
  label: string
  error?: string
}
