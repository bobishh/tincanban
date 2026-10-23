import { readFile } from "node:fs/promises"
import { beforeAll, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { strToU8, unzipSync, zipSync } from "fflate"
import { createWorkspaceDoc } from "../test/boardFixture"
import { exportWorkspaceBundleV2, forkWorkspaceDocumentV2, readWorkspaceBundleV2 } from "./workspaceBundle"
import type { WorkspaceDocumentV2 } from "./model"
import { assertWorkspaceTransition } from "./permissions"

beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
})

it("exports locally available attachment bytes and reports unavailable bytes honestly", async () => {
  const doc = documentWithAttachment()
  const bytes = new TextEncoder().encode("saved attachment")
  const bundleBytes = await exportWorkspaceBundleV2(doc, async () => bytes)
  expect(unzipSync(bundleBytes)["proofs.json"]).toBeUndefined()
  const read = await readWorkspaceBundleV2(bundleBytes)
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.value.manifest.includedBlobHashes).toEqual(["sha256:attachment-hash"])
  expect(read.value.manifest.missingBlobHashes).toEqual([])
  expect(read.value.blobs[0]).toEqual({ blobId: "sha256:attachment-hash", bytes })

  const missing = await readWorkspaceBundleV2(await exportWorkspaceBundleV2(doc))
  expect(missing.ok).toBe(true)
  if (!missing.ok) return
  expect(missing.value.manifest.includedBlobHashes).toEqual([])
  expect(missing.value.manifest.missingBlobHashes).toEqual(["sha256:attachment-hash"])
})

it("imports as a fresh locally owned Automerge board without source authority or history", () => {
  const source = Automerge.change(documentWithAttachment(), draft => { draft.title = "Source board changed" })
  const copied = forkWorkspaceDocumentV2(source, "new-workspace", "local-owner")
  expect(copied.ok).toBe(true)
  if (!copied.ok) return

  expect(copied.value.id).toBe("new-workspace")
  expect(copied.value.ownerPersonId).toBe("local-owner")
  expect(copied.value.migration).toBeNull()
  expect(copied.value.entities).toEqual(source.entities)
  expect(Automerge.getAllChanges(copied.value)).toHaveLength(1)
  expect(Automerge.getAllChanges(source).length).toBeGreaterThan(1)

  const changedCopy = Automerge.change(copied.value, draft => { draft.title = "Copy only" })
  expect(source.title).toBe("Source board changed")
  expect(changedCopy.title).toBe("Copy only")
  expect(source.ownerPersonId).toBe("source-owner")
  expect(forkWorkspaceDocumentV2(source, source.id, "local-owner")).toMatchObject({ ok: false })
})

it("Given an exported board contains participant profiles, when imported as a new board, then its content can be admitted under the new owner", async () => {
  const source = Automerge.change(documentWithAttachment(), draft => {
    for (const personId of ["source-owner", "former-participant", "local-owner"]) {
      const id = `member-profile:${personId}`
      draft.entities[id] = {
        id, kind: "member_profile", personId, title: "Member profile",
        data: JSON.stringify({ avatarData: null, changedAt: "2026-01-01T00:00:00.000Z" }),
        placement: { parentId: null, rank: "0/1" }, archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }
    }
  })
  const bundle = await readWorkspaceBundleV2(await exportWorkspaceBundleV2(source))
  expect(bundle.ok).toBe(true)
  if (!bundle.ok) return
  const copied = forkWorkspaceDocumentV2(bundle.value.doc, "new-workspace", "local-owner")
  expect(copied.ok).toBe(true)
  if (!copied.ok) return
  const restored = Automerge.load<WorkspaceDocumentV2>(Automerge.save(copied.value))
  expect(() => assertWorkspaceTransition("owner", Automerge.view(restored, []), restored, "local-owner")).not.toThrow()
  expect(Object.values(restored.entities).some(entity => entity.kind === "member_profile")).toBe(false)
  expect(restored.entities).toEqual(Object.fromEntries(Object.entries(source.entities)
    .filter(([, entity]) => entity.kind !== "member_profile")))
  expect(Object.values(source.entities).filter(entity => entity.kind === "member_profile")).toHaveLength(3)
})

it("treats attachments as unavailable in the original proof-format v2 export", async () => {
  const doc = documentWithAttachment()
  const legacyBundle = zipSync({
    "manifest.json": strToU8(JSON.stringify({
      format: "match", version: 2, workspaceId: doc.id,
      includedBlobHashes: [], missingBlobHashes: [], proofFormatVersion: 1,
    })),
    "workspace.automerge": Automerge.save(doc),
  })
  const result = await readWorkspaceBundleV2(legacyBundle)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.manifest.includedBlobHashes).toEqual([])
  expect(result.value.manifest.missingBlobHashes).toEqual(["sha256:attachment-hash"])
  expect(result.value.blobs).toEqual([])
})

it("rejects inconsistent attachment manifests", async () => {
  const doc = documentWithAttachment()
  const base = unzipSync(await exportWorkspaceBundleV2(doc))
  for (const [includedBlobHashes, missingBlobHashes] of [
    [[], []],
    [["sha256:attachment-hash"], []],
    [[], ["sha256:attachment-hash", "sha256:attachment-hash"]],
    [[], ["sha256:unreferenced"]],
    [["sha256:attachment-hash"], ["sha256:attachment-hash"]],
  ]) {
    const manifest = { format: "match", version: 2, workspaceId: doc.id, includedBlobHashes, missingBlobHashes }
    const result = await readWorkspaceBundleV2(zipSync({ ...base, "manifest.json": strToU8(JSON.stringify(manifest)) }))
    expect(result.ok).toBe(false)
  }
})

it("rejects corrupt bundles", async () => {
  const result = await readWorkspaceBundleV2(new Uint8Array([1, 2, 3, 4]))
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe("unsupported_format")
})

function documentWithAttachment(): Automerge.Doc<WorkspaceDocumentV2> {
  const base = Automerge.from(createWorkspaceDoc("source-workspace", "Source board", "source-owner", "blank"))
  return Automerge.change(base, draft => {
    draft.entities.attachment = {
      id: "attachment",
      kind: "document",
      title: "Attachment",
      placement: { parentId: "missing-item", rank: "1/1" },
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      documentKind: "attachment",
      format: "file",
      content: null,
      file: { type: "blob", sha256: "attachment-hash", byteLength: 16, mimeType: "text/plain", fileName: "note.txt" },
    }
  })
}
