import { describe, expect, it } from "vitest"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import type { AttachmentCoverageStatus } from "../sync/attachmentReplicationTypes"
import { attachmentCoveragePresentation } from "./attachmentCoveragePresentation"

type Status = AttachmentCoverageStatus

const file = {
  type: "blob" as const,
  sha256: "a".repeat(64),
  byteLength: 12,
  mimeType: "application/pdf",
  fileName: "resume.pdf",
}
const descriptor = {
  kind: "blob" as const,
  version: 1 as const,
  blobId: `sha256:${file.sha256}`,
  name: file.fileName,
  mediaType: file.mimeType,
  size: file.byteLength,
} satisfies BlobDescriptor
const status = (workspaceId: string, phase: Status["phase"], changes: Partial<Status> = {}): Status => ({
  workspaceId,
  descriptor: { ...descriptor },
  phase,
  label: phase === "complete" ? "Stored on Rusty" : phase === "uploading" ? "Uploading to Rusty" : "Checking Rusty storage",
  ...changes,
})

describe("attachment coverage presentation", () => {
  it("does not infer Rusty coverage from a missing or unrelated status", () => {
    expect(attachmentCoveragePresentation(undefined, "workspace-a", file)).toEqual({
      label: "Not confirmed on Rusty",
    })
    expect(attachmentCoveragePresentation({ other: [status("other", "complete")] }, "workspace-a", file)).toEqual({
      label: "Not confirmed on Rusty",
    })
  })

  it("requires exact workspace and file identity, ignoring only the replaceable peer ticket", () => {
    const wrongName = status("workspace-a", "complete", {
      descriptor: { ...descriptor, name: "different.pdf" },
    })
    const wrongSize = status("workspace-a", "complete", {
      descriptor: { ...descriptor, size: 13 },
    })
    const wrongHash = status("workspace-a", "complete", {
      descriptor: { ...descriptor, blobId: `sha256:${"b".repeat(64)}` },
    })
    expect(attachmentCoveragePresentation({ a: [wrongName, wrongSize, wrongHash] }, "workspace-a", file)).toEqual({
      label: "Not confirmed on Rusty",
    })
    expect(attachmentCoveragePresentation({ a: [status("workspace-a", "complete", {
      descriptor: { ...descriptor, ticket: "new-peer-ticket" },
    })] }, "workspace-a", file)).toEqual({ label: "Complete on Rusty" })
  })

  it("shows confirmed status when any exact current match is complete", () => {
    expect(attachmentCoveragePresentation({ a: [
      status("workspace-a", "denied", { error: "Access changed" }),
      status("workspace-a", "complete"),
    ] }, "workspace-a", file)).toEqual({ label: "Complete on Rusty" })
  })

  it("matches BLAKE3 references by their exact hash and descriptor identity", () => {
    const hash = "b".repeat(64)
    const blakeFile = { type: "blob" as const, hash, byteLength: 12, mimeType: "application/pdf", fileName: "resume.pdf" }
    const blakeDescriptor = { ...descriptor, blobId: `blake3:${hash}`, hash }
    expect(attachmentCoveragePresentation({ a: [status("workspace-a", "complete", {
      descriptor: blakeDescriptor,
    })] }, "workspace-a", blakeFile)).toEqual({ label: "Complete on Rusty" })
  })

  it("shows a useful non-complete state and cause for exact matches", () => {
    expect(attachmentCoveragePresentation({ a: [status("workspace-a", "uploading")] }, "workspace-a", file)).toEqual({
      label: "Uploading to Rusty",
    })
    expect(attachmentCoveragePresentation({ a: [status("workspace-a", "denied", {
      label: "Access denied",
      error: "Workspace access was revoked",
    })] }, "workspace-a", file)).toEqual({
      label: "Access denied",
      error: "Workspace access was revoked",
    })
  })
})
