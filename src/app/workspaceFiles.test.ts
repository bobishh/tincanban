import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { unzipSync } from "fflate"
import { createWorkspaceDoc } from "../test/boardFixture"
import { readWorkspaceBundleV2 } from "../domain/workspaceBundle"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { createAllWorkspaceArchive } from "./workspaceFiles"

beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
})

it("Given accessible and archived boards, when exporting all, then include one full current-format bundle per board", async () => {
  const active = documentWithAttachment("active-1")
  const archived = Automerge.change(Automerge.from(createWorkspaceDoc("archived-2", "Planning / roadmap", "owner", "blank")), draft => {
    draft.archivedAt = "2026-10-20T12:00:00.000Z"
  })
  const attachment = new TextEncoder().encode("local attachment bytes")
  const readWorkspaceDoc = vi.fn(async (id: string) => {
    if (id === active.id) return active
    if (id === archived.id) return archived
    throw new Error("workspace is not locally available")
  })
  const result = await createAllWorkspaceArchive({
    available: [{ id: active.id, title: active.title }],
    archived: [{ id: archived.id, title: archived.title }, { id: active.id, title: active.title }],
    readWorkspaceDoc,
    readAttachment: async () => attachment,
  })

  const archive = unzipSync(result.bytes)
  const filenames = Object.keys(archive).sort()
  expect(result.workspaceCount).toBe(2)
  expect(filenames).toHaveLength(2)
  expect(filenames.every(name => name.endsWith(".tincanban"))).toBe(true)
  expect(filenames.some(name => name.includes("/") || name.includes("\\"))).toBe(false)
  expect(filenames[0]).not.toBe(filenames[1])
  expect(readWorkspaceDoc).toHaveBeenCalledTimes(2)
  expect(readWorkspaceDoc).not.toHaveBeenCalledWith("remote-phantom")

  const bundles = await Promise.all(filenames.map(async filename => {
    const entries = Object.keys(unzipSync(archive[filename]!)).sort()
    expect(entries).toContain("manifest.json")
    expect(entries).toContain("workspace.automerge")
    expect(entries).toContain("workspace.json")
    expect(entries.some(name => name.toLowerCase().includes("identity") || name.toLowerCase().includes("recovery"))).toBe(false)
    const parsed = await readWorkspaceBundleV2(archive[filename]!)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error.message)
    return parsed.value
  }))
  expect(bundles.map(bundle => bundle.doc.id).sort()).toEqual([active.id, archived.id])
  expect(bundles.find(bundle => bundle.doc.id === active.id)?.blobs).toEqual([
    { blobId: "sha256:attachment-hash", bytes: attachment },
  ])
})

it("Given a board export fails, when exporting all, then reject without returning a partial archive", async () => {
  const available = [
    { id: "board-a", title: "First" },
    { id: "board-b", title: "Second" },
  ]
  const readWorkspaceDoc = vi.fn(async (id: string) => {
    if (id === "board-a") return Automerge.from(createWorkspaceDoc(id, "First", "owner", "blank"))
    throw new Error("stored board could not be read")
  })

  await expect(createAllWorkspaceArchive({ available, archived: [], readWorkspaceDoc, readAttachment: async () => undefined }))
    .rejects.toThrow(/Second.*stored board could not be read/u)
})

function documentWithAttachment(id: string): Automerge.Doc<WorkspaceDocumentV2> {
  const base = Automerge.from(createWorkspaceDoc(id, "Planning / roadmap", "owner", "blank"))
  return Automerge.change(base, draft => {
    draft.entities.attachment = {
      id: "attachment", kind: "document", title: "Attachment",
      placement: { parentId: "missing-item", rank: "1/1" }, archivedAt: null,
      createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z",
      documentKind: "attachment", format: "file", content: null,
      file: { type: "blob", sha256: "attachment-hash", byteLength: 23, mimeType: "text/plain", fileName: "note.txt" },
    }
  })
}
