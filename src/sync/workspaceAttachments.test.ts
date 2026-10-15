import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { listWorkspaceAttachments } from "./workspaceAttachments"

const workspaceId = "workspace-files"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
afterAll(() => vi.unstubAllGlobals())

function document(entities: Record<string, unknown>): WorkspaceDocumentV2 {
  return { kind: "workspace", formatVersion: 3, id: workspaceId, title: "Files", archivedAt: null,
    ownerPersonId: "owner", migration: null, entities } as unknown as WorkspaceDocumentV2
}

function ref(fileName: string, overrides: Record<string, unknown> = {}) {
  return { type: "blob", sha256: "A".repeat(43), byteLength: 12, mimeType: "application/pdf", fileName, ...overrides }
}

function base(id: string, kind: string, extras: Record<string, unknown>) {
  return { id, kind, title: id, createdAt: "2026-01-01", updatedAt: "2026-01-01", archivedAt: "2026-02-01",
    placement: { parentId: "board", rank: "0/1" }, ...extras }
}

describe("workspace attachment enumeration", () => {
  it("Given archived document and artifact references, When listing uploads, Then include real blob refs, preserve metadata variants, and strip tickets", () => {
    const attachments = listWorkspaceAttachments(document({
      doc: base("doc", "document", { file: ref("file.pdf", { ticket: "signed-transport-ticket" }) }),
      artifact: base("artifact", "artifact", { pdf: ref("file.pdf"), sourceMarkdown: ref("source.md", {
        sha256: "B".repeat(43), mimeType: "text/markdown", ticket: "old-ticket",
      }) }),
      legacyPath: base("legacy", "document", { file: { type: "local-file", fileId: "local-1", fileName: "private.pdf" } }),
      note: base("note", "document", { file: null }),
    }))

    expect(attachments).toEqual([
      { kind: "blob", version: 1, blobId: `sha256:${"A".repeat(43)}`, name: "file.pdf", mediaType: "application/pdf", size: 12 },
      { kind: "blob", version: 1, blobId: `sha256:${"B".repeat(43)}`, name: "source.md", mediaType: "text/markdown", size: 12 },
    ])
    expect(JSON.stringify(attachments)).not.toContain("ticket")
    expect(JSON.stringify(attachments)).not.toContain("private.pdf")
  })

  it("Given duplicate references and same bytes with distinct metadata, When listing, Then deduplicate only exact descriptors in stable ordinal order", () => {
    const attachments = listWorkspaceAttachments(document({
      z: base("z", "document", { file: ref("z.pdf") }),
      a: base("a", "artifact", { pdf: ref("a.pdf"), sourceMarkdown: ref("z.pdf") }),
    }))
    expect(attachments.map(value => value.name)).toEqual(["a.pdf", "z.pdf"])
    expect(attachments).toHaveLength(2)
  })

  it("Given a real Automerge document view, When listing attachments, Then return detached descriptor records", () => {
    const source = Automerge.from(document({ doc: base("doc", "document", { file: ref("frozen.pdf") }) }))
    const view = Automerge.view(source, Automerge.getHeads(source))
    const attachments = listWorkspaceAttachments(view)
    expect(attachments[0]).toMatchObject({ name: "frozen.pdf", size: 12 })
    const changed = Automerge.change(source, draft => {
      ;(draft.entities.doc as unknown as { file: { fileName: string } }).file.fileName = "changed.pdf"
    })
    expect(listWorkspaceAttachments(changed)[0]?.name).toBe("changed.pdf")
    expect(attachments[0]?.name).toBe("frozen.pdf")
    expect(() => structuredClone(attachments)).not.toThrow()
  })

  it("Given a malformed blob reference, When listing uploads, Then reject it instead of manufacturing a valid descriptor", () => {
    expect(() => listWorkspaceAttachments(document({ bad: base("bad", "document", {
      file: ref("bad.pdf", { byteLength: 0 }),
    }) }))).toThrow(/blob descriptor/i)
  })

  it("Given more than the bounded attachment count, When listing uploads, Then fail explicitly instead of truncating", () => {
    const entities = Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`file-${index}`, base(`file-${index}`, "document", {
      file: ref(`file-${index}.pdf`, { sha256: String(index).padStart(43, "A") }),
    })]))
    expect(() => listWorkspaceAttachments(document(entities))).toThrow(/1024|limit/i)
  })
})
