import { hasEntityKind } from "./model"
import * as Automerge from "@automerge/automerge/slim"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type { CommandResult, FileReference, WorkspaceDocumentV2 } from "./model"
import { validateWorkspaceDoc } from "./model"
import { canonicalizeJson } from "./identity"
import { readApplicationSourceData } from "./applicationSourceData"

export type BundleManifest = { format: "tincanban" | "match"; version: 2; workspaceId: string; heads?: string[]; includedBlobHashes: string[]; missingBlobHashes: string[]; proofFormatVersion?: number; exportedAt?: string }
export type BundleBlob = { blobId: string; bytes: Uint8Array }
export type ReadBundleBlob = (reference: FileReference) => Promise<Uint8Array | undefined>

export async function exportWorkspaceBundleV2(doc: WorkspaceDocumentV2, readBlob?: ReadBundleBlob): Promise<Uint8Array> {
  const blobs = await bundleBlobs(doc, readBlob)
  const manifest: BundleManifest = { format: "tincanban", version: 2, workspaceId: doc.id, heads: Automerge.getHeads(doc as Automerge.Doc<WorkspaceDocumentV2>).sort(), includedBlobHashes: blobs.included.map(blob => blob.blobId), missingBlobHashes: blobs.missing, exportedAt: new Date().toISOString() }
  const files: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), "workspace.automerge": Automerge.save(doc as Automerge.Doc<WorkspaceDocumentV2>), "workspace.json": strToU8(canonicalizeJson(doc)) }
  for (const blob of blobs.included) files[blobArchivePath(blob.blobId)] = blob.bytes
  return zipSync(files)
}

export async function readWorkspaceBundleV2(bundleBytes: Uint8Array): Promise<CommandResult<{ doc: WorkspaceDocumentV2; manifest: BundleManifest; blobs: BundleBlob[] }>> {
  let archive: Record<string, Uint8Array>
  try { archive = unzipSync(bundleBytes) } catch { return unsupported("Failed to unzip bundle") }
  const manifestFile = archive["manifest.json"]
  const automergeFile = archive["workspace.automerge"]
  if (!manifestFile || !automergeFile) return unsupported("Invalid bundle structure")
  let manifest: BundleManifest
  try { manifest = JSON.parse(strFromU8(manifestFile)) as BundleManifest } catch { return unsupported("Corrupt manifest.json") }
  if (!isBundleManifest(manifest)) return unsupported("Unsupported bundle format")
  let doc: Automerge.Doc<WorkspaceDocumentV2>
  try { doc = Automerge.load<WorkspaceDocumentV2>(automergeFile) } catch { return unsupported("Corrupt workspace.automerge bytes") }
  if (manifest.workspaceId !== doc.id) return unsupported("Manifest workspaceId does not match document")
  const validation = validateWorkspaceDoc(doc)
  if (!validation.ok) return { ok: false, error: validation.error }
  const referencedBlobIds = new Set(attachmentReferences(doc).map(referenceBlobId).filter((value): value is string => Boolean(value)))
  if (isPreAttachmentBundle(manifest)) {
    manifest.includedBlobHashes = []
    manifest.missingBlobHashes = [...referencedBlobIds]
  } else if (!validAttachmentManifest(manifest, referencedBlobIds)) return unsupported("Attachment manifest does not match the workspace")
  const blobs = manifest.includedBlobHashes.map(blobId => {
    const bytes = archive[blobArchivePath(blobId)]
    return bytes ? { blobId, bytes } : undefined
  })
  if (blobs.some(blob => !blob)) return unsupported("A declared attachment is missing from the bundle")
  return { ok: true, value: { doc, manifest, blobs: blobs as BundleBlob[] } }
}

/** Creates a content copy without imported authority, history, or identity profiles. */
export function forkWorkspaceDocumentV2(source: WorkspaceDocumentV2, workspaceId: string, ownerPersonId: string): CommandResult<Automerge.Doc<WorkspaceDocumentV2>> {
  const validation = validateWorkspaceDoc(source)
  if (!validation.ok) return { ok: false, error: validation.error }
  if (!workspaceId || !ownerPersonId) return { ok: false, error: { code: "invalid_input", message: "A workspace id and owner are required" } }
  if (workspaceId === source.id) return { ok: false, error: { code: "conflict", message: "Imported workspaces must use a new id" } }
  const content = Object.fromEntries(Object.entries(source.entities).filter(([, entity]) =>
    !hasEntityKind(entity, "member_profile") && !hasEntityKind(entity, "automation")))
  const reservedIds = new Set([workspaceId, ...Object.keys(content)])
  const boardIds = new Map<string, string>()
  for (const [id, entity] of Object.entries(content)) {
    if (hasEntityKind(entity, "board")) {
      const nextId = uniqueBoardId(reservedIds)
      boardIds.set(id, nextId)
      reservedIds.add(nextId)
    }
  }
  const entities = Object.fromEntries(Object.entries(content).map(([id, entity]) => {
    const copied = JSON.parse(JSON.stringify(entity)) as typeof entity
    const nextId = boardIds.get(id) ?? id
    copied.id = nextId
    if (copied.placement.parentId) copied.placement.parentId = boardIds.get(copied.placement.parentId) ?? copied.placement.parentId
    if (hasEntityKind(copied, "application_source")) {
      const data = readApplicationSourceData(copied.data)
      copied.data = canonicalizeJson({ ...data, workspaceId, applicationId: `${workspaceId}:${data.cardId}` })
    }
    return [nextId, copied]
  })) as WorkspaceDocumentV2["entities"]
  const copied: WorkspaceDocumentV2 = { kind: "workspace", formatVersion: 3, id: workspaceId, title: source.title, archivedAt: null, ownerPersonId, entities, migration: null }
  return { ok: true, value: Automerge.from(copied) }
}

function uniqueBoardId(reservedIds: Set<string>): string {
  let id = crypto.randomUUID()
  while (reservedIds.has(id)) id = crypto.randomUUID()
  return id
}

async function bundleBlobs(doc: WorkspaceDocumentV2, readBlob?: ReadBundleBlob) {
  const seen = new Set<string>(), included: BundleBlob[] = [], missing: string[] = []
  for (const reference of attachmentReferences(doc)) {
    const blobId = referenceBlobId(reference)
    if (!blobId || seen.has(blobId)) continue
    seen.add(blobId)
    const bytes = readBlob ? await readBlob(reference) : undefined
    if (bytes) included.push({ blobId, bytes }); else missing.push(blobId)
  }
  return { included, missing }
}

function attachmentReferences(doc: WorkspaceDocumentV2): FileReference[] {
  return Object.values(doc.entities).flatMap(entity => hasEntityKind(entity, "document") ? entity.file ? [entity.file] : [] : hasEntityKind(entity, "artifact") ? [entity.pdf, entity.sourceMarkdown].filter((reference): reference is FileReference => reference !== null) : [])
}

export function referenceBlobId(reference: FileReference): string | undefined {
  if (reference.type !== "blob") return undefined
  return reference.sha256 ? `sha256:${reference.sha256}` : reference.hash ? `blake3:${reference.hash}` : undefined
}

function blobArchivePath(blobId: string): string { return `blobs/${encodeURIComponent(blobId)}` }
function unsupported(message: string): CommandResult<never> { return { ok: false, error: { code: "unsupported_format", message } } }
function uniqueAndReferenced(blobIds: string[], referencedBlobIds: Set<string>): boolean {
  return new Set(blobIds).size === blobIds.length && blobIds.every(blobId => referencedBlobIds.has(blobId))
}
function isPreAttachmentBundle(manifest: BundleManifest): boolean {
  return manifest.proofFormatVersion === 1 && manifest.includedBlobHashes.length === 0 && manifest.missingBlobHashes.length === 0
}
function validAttachmentManifest(manifest: BundleManifest, referencedBlobIds: Set<string>): boolean {
  return uniqueAndReferenced(manifest.includedBlobHashes, referencedBlobIds)
    && uniqueAndReferenced(manifest.missingBlobHashes, referencedBlobIds)
    && !manifest.includedBlobHashes.some(blobId => manifest.missingBlobHashes.includes(blobId))
    && manifest.includedBlobHashes.length + manifest.missingBlobHashes.length === referencedBlobIds.size
}
function isBundleManifest(value: unknown): value is BundleManifest {
  if (!value || typeof value !== "object") return false
  const manifest = value as Record<string, unknown>
  return (manifest.format === "tincanban" || manifest.format === "match") && manifest.version === 2 && typeof manifest.workspaceId === "string" && Array.isArray(manifest.includedBlobHashes) && manifest.includedBlobHashes.every(value => typeof value === "string") && Array.isArray(manifest.missingBlobHashes) && manifest.missingBlobHashes.every(value => typeof value === "string") && (manifest.proofFormatVersion === undefined || manifest.proofFormatVersion === 1)
}
