import { describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "../test/boardFixture"
import { workspaceBlobDescriptor, workspaceChatRoomId } from "./workspaceMetadata"

describe("workspace metadata", () => {
  it("uses current owner and board identity for chat room", () => {
    const doc = createWorkspaceDoc("workspace-1", "Board", "owner-new", "blank")
    const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
    expect(workspaceChatRoomId(doc)).toBe(`owner-new:${board.id}`)
  })

  it("returns blob descriptors from the current document", () => {
    const doc = createWorkspaceDoc("workspace-1", "Board", "owner", "blank")
    const blobId = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    doc.entities["artifact-1"] = {
      id: "artifact-1", kind: "artifact", title: "CV.pdf",
      placement: { parentId: null, rank: "0/1" }, archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      artifactKind: "cv", templateId: "template-1",
      pdf: { type: "blob", sha256: blobId.slice("sha256:".length), byteLength: 12,
        mimeType: "application/pdf", fileName: "CV.pdf" },
      sourceMarkdown: null,
    }
    expect(workspaceBlobDescriptor(doc, blobId)).toMatchObject({ blobId, name: "CV.pdf", size: 12 })
    expect(workspaceBlobDescriptor(doc, "sha256:missing")).toBeUndefined()
  })
})
