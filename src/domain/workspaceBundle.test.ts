import { readFile } from "node:fs/promises"
import { beforeAll, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { strToU8, unzipSync, zipSync } from "fflate"
import { createWorkspaceDoc } from "../test/boardFixture"
import { hasEntityKind, validateWorkspaceDoc } from "./model"
import { exportWorkspaceBundleV2, forkWorkspaceDocumentV2, readWorkspaceBundleV2 } from "./workspaceBundle"
import type { WorkspaceDocumentV2 } from "./model"
import { assertWorkspaceTransition } from "./permissions"
import { canonicalizeJson } from "./identity"
import { automationEntityId } from "./automationLifecycle"
import type { AutomationDefinition } from "./automationContract"

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
  expect(copied.value.entities).toEqual(importedContent(source.entities, copied.value.entities))
  expect(Automerge.getAllChanges(copied.value)).toHaveLength(1)
  expect(Automerge.getAllChanges(source).length).toBeGreaterThan(1)

  const changedCopy = Automerge.change(copied.value, draft => { draft.title = "Copy only" })
  expect(source.title).toBe("Source board changed")
  expect(changedCopy.title).toBe("Copy only")
  expect(source.ownerPersonId).toBe("source-owner")
  expect(forkWorkspaceDocumentV2(source, source.id, "local-owner")).toMatchObject({ ok: false })
})

it("Given a board with an existing Rusty publication, when imported as a new board, then use a fresh public resource ID and preserve source content", () => {
  const source = Automerge.from(createWorkspaceDoc("source-workspace", "Source board", "source-owner", "blank"))
  const sourceBoard = Object.values(source.entities).find(entity => hasEntityKind(entity, "board"))!
  const sourceChildren = Object.values(source.entities).filter(entity => entity.placement.parentId === sourceBoard.id)

  const copied = forkWorkspaceDocumentV2(source, "new-workspace", "local-owner")
  expect(copied.ok).toBe(true)
  if (!copied.ok) return

  const importedBoard = Object.values(copied.value.entities).find(entity => hasEntityKind(entity, "board"))!
  expect(importedBoard.id).not.toBe(sourceBoard.id)
  expect(copied.value.entities[sourceBoard.id]).toBeUndefined()
  expect(importedBoard).toMatchObject({ id: importedBoard.id, kind: "board", title: sourceBoard.title })
  for (const child of sourceChildren) {
    expect(copied.value.entities[child.id]).toMatchObject({ id: child.id, placement: { parentId: importedBoard.id } })
  }
  expect(source.entities[sourceBoard.id]).toEqual(sourceBoard)
  expect(source.ownerPersonId).toBe("source-owner")
  expect(copied.value.ownerPersonId).toBe("local-owner")
})

it("Given an application board with source evidence and an active Worker, when imported under a new owner, then rebase unsigned evidence and omit the source-signed Worker", () => {
  const source = applicationWorkspaceWithWorker()
  const sourceValidation = validateWorkspaceDoc(source)
  if (!sourceValidation.ok) throw new Error(JSON.stringify(sourceValidation.error))
  const sourceWorkspaceId = source.id
  const sourceBoard = Object.values(source.entities).find(entity => hasEntityKind(entity, "board"))!
  const sourceEvidence = Object.values(source.entities).filter(entity => hasEntityKind(entity, "application_source"))
  const sourceWorker = Object.values(source.entities).find(entity => hasEntityKind(entity, "automation"))!
  const sourceBytes = Automerge.save(source)

  const copied = forkWorkspaceDocumentV2(source, "imported-applications", "local-owner")
  expect(copied.ok).toBe(true)
  if (!copied.ok) return

  expect(validateWorkspaceDoc(copied.value)).toMatchObject({ ok: true })
  const importedBoard = Object.values(copied.value.entities).find(entity => hasEntityKind(entity, "board"))!
  const importedEvidence = Object.values(copied.value.entities).filter(entity => hasEntityKind(entity, "application_source"))
  expect(copied.value.ownerPersonId).toBe("local-owner")
  expect(importedBoard.id).not.toBe(sourceBoard.id)
  expect(importedEvidence).toHaveLength(sourceEvidence.length)
  for (const entity of importedEvidence) {
    if (!hasEntityKind(entity, "application_source")) continue
    const data = JSON.parse(entity.data) as { workspaceId: string; cardId: string; applicationId: string; messageIds?: string[]; observation: unknown }
    const original = source.entities[entity.id]
    if (!hasEntityKind(original, "application_source")) throw new Error("Source application evidence disappeared")
    const sourceData = JSON.parse(original.data) as { workspaceId: string; applicationId: string; cardId: string; messageIds?: string[]; observation: unknown }
    expect(data).toEqual({ ...sourceData, workspaceId: copied.value.id, applicationId: `${copied.value.id}:${sourceData.cardId}` })
  }
  expect(copied.value.entities[sourceWorker.id]).toBeUndefined()
  expect(Automerge.save(source)).toEqual(sourceBytes)
  expect(source.id).toBe(sourceWorkspaceId)
  expect(source.entities[sourceWorker.id]).toEqual(sourceWorker)
  expect(source.ownerPersonId).toBe("source-owner")
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
  expect(restored.entities).toEqual(importedContent(source.entities, restored.entities))
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

function applicationWorkspaceWithWorker(): Automerge.Doc<WorkspaceDocumentV2> {
  const base = Automerge.from(createWorkspaceDoc("source-workspace", "Job search", "source-owner", "job-search", "2026-01-01T00:00:00.000Z"))
  const board = Object.values(base.entities).find(entity => hasEntityKind(entity, "board"))!
  const cardId = "application-card"
  const leadColumn = Object.values(base.entities).find(entity => hasEntityKind(entity, "column") && entity.title === "Lead")!
  const observedAt = "2026-01-01T00:00:00.000Z"
  const originalRecordId = "source-original"
  const refreshRecordId = "source-refresh"
  const common = { kind: "application-source-observation", version: 2, workspaceId: base.id,
    cardId: cardId, applicationId: `${base.id}:${cardId}`, messageIds: ["<applied@example.test>"], atsId: "REQ-1" }
  const original = { ...common, recordId: originalRecordId, observation: { phase: "original", origin: "email", status: "available",
    observedAt, company: "Nacre Light", title: "Engineer", text: "Original application evidence.",
    extractorVersion: "mail-1", contentDigest: "a".repeat(43) } }
  const refresh = { ...common, recordId: refreshRecordId, observation: { ...original.observation, phase: "refresh", originalRecordId } }
  const sourceEntity = (recordId: string, data: unknown) => ({
    id: `application-source:${recordId}`, kind: "application_source" as const, title: "Application source" as const,
    placement: { parentId: cardId, rank: "0/1" as const }, archivedAt: null, createdAt: observedAt, updatedAt: observedAt,
    data: canonicalizeJson(data),
  })
  const definition: AutomationDefinition = {
    kind: "automation-definition", version: 1, id: "intake-1", name: "Job intake", type: "job-intake", typeVersion: 1,
    parameters: { sources: ["website", "email"] }, permissions: ["workspace.read", "board.lead.create", "board.application.advance"],
    scope: { workspaceId: base.id, boardId: board.id, grantId: "signed-grant-1" },
  }
  const approval = JSON.stringify({ definition: { payload: definition, signerKeyId: "owner-device", signature: "test-definition" },
    grant: { payload: { kind: "workspace-grant", version: 1, grantId: "signed-grant-1", workspaceId: base.id, personId: "worker",
      role: "automation", accessEpoch: 1, automation: { version: 1, boardId: board.id,
        columns: { lead: "lead", interview: "interview", rejected: "rejected" }, fieldIds: ["company"], expiresAt: 2000000000000 } },
      signerKeyId: "owner-device", signature: "test-grant" } })
  const workerId = automationEntityId(definition.id)
  return Automerge.change(base, draft => {
    draft.entities[cardId] = { id: cardId, title: "Application", body: "", values: {},
      placement: { parentId: leadColumn.id, rank: "0/1" }, workflow: { columnId: leadColumn.id, changedAt: observedAt },
      archivedAt: null, createdAt: observedAt, updatedAt: observedAt }
    draft.entities[sourceEntity(originalRecordId, original).id] = sourceEntity(originalRecordId, original)
    draft.entities[sourceEntity(refreshRecordId, refresh).id] = sourceEntity(refreshRecordId, refresh)
    draft.entities[workerId] = {
      id: workerId, kind: "automation", title: definition.name, definition: canonicalizeJson(definition), approval,
      executor: { origin: "https://automation.example.test", personId: "worker" }, controls: {
        "c272eb90-9326-48c1-9321-8c0fd14c8854": JSON.stringify({ state: "active", supersedes: [] }),
      }, placement: { parentId: board.id, rank: "0/1" }, archivedAt: null, createdAt: observedAt, updatedAt: observedAt,
    }
  })
}

function importedContent(source: WorkspaceDocumentV2["entities"], imported: WorkspaceDocumentV2["entities"]): WorkspaceDocumentV2["entities"] {
  const sourceBoards = Object.values(source).filter(entity => hasEntityKind(entity, "board"))
  const importedBoards = Object.values(imported).filter(entity => hasEntityKind(entity, "board"))
  const boardIds = new Map(sourceBoards.map((board, index) => [board.id, importedBoards[index]!.id]))
  return Object.fromEntries(Object.entries(source)
    .filter(([, entity]) => !hasEntityKind(entity, "member_profile"))
    .map(([id, entity]) => {
      const copy = structuredClone(entity)
      copy.id = boardIds.get(id) ?? id
      if (copy.placement.parentId) copy.placement.parentId = boardIds.get(copy.placement.parentId) ?? copy.placement.parentId
      return [boardIds.get(id) ?? id, copy]
    })) as WorkspaceDocumentV2["entities"]
}
