import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { verifyBlobBytes } from "@meta-uber/mesh-blob"
import { exportWorkspaceBundleV2, readWorkspaceBundleV2, referenceBlobId, type BundleBlob } from "../domain/workspaceBundle"
import { zipSync } from "fflate"
import type { FileReference } from "../domain/model"
import { blobDescriptor, readStoredAttachment, writeStoredAttachment } from "../attachments"
import type { useAppCore } from "./useAppCore"

type WorkspaceExportSummary = { id: string; title: string }
export type WorkspaceExportProgress = { completed: number; total: number }

export async function exportActiveWorkspace(core: ReturnType<typeof useAppCore>) {
  const doc = core.tincanban.getActiveDoc()
  if (!doc) {
    core.notice.value = "Export unavailable: the current board is not ready"
    return
  }
  const bundle = await exportWorkspaceBundleV2(doc, reference => {
    const descriptor = blobDescriptor(reference)
    return descriptor ? readStoredAttachment(descriptor) : Promise.resolve(undefined)
  })
  const inspection = await readWorkspaceBundleV2(bundle)
  if (!inspection.ok) throw new Error(inspection.error.message)
  downloadBundle(bundle, doc.title)
  const missing = inspection.value.manifest.missingBlobHashes.length
  core.notice.value = `tincanban bundle exported; ${missing} attachment${missing === 1 ? "" : "s"} unavailable in the file`
}

export async function createAllWorkspaceArchive(options: {
  available: readonly WorkspaceExportSummary[]
  archived: readonly WorkspaceExportSummary[]
  readWorkspaceDoc(id: string): Promise<WorkspaceDocumentV2>
  readAttachment(reference: FileReference): Promise<Uint8Array | undefined>
  onProgress?(progress: WorkspaceExportProgress): void
}): Promise<{ bytes: Uint8Array; workspaceCount: number; missingAttachmentCount: number }> {
  const unique = new Map<string, WorkspaceExportSummary>()
  for (const summary of [...options.available, ...options.archived]) unique.set(summary.id, summary)
  const workspaces = [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
  if (workspaces.length === 0) throw new Error("No locally available boards to export")

  const files: Record<string, Uint8Array> = {}
  let missingAttachmentCount = 0
  options.onProgress?.({ completed: 0, total: workspaces.length })
  for (let index = 0; index < workspaces.length; index++) {
    const summary = workspaces[index]!
    try {
      const doc = await options.readWorkspaceDoc(summary.id)
      if (doc.id !== summary.id) throw new Error("stored document ID does not match its local catalog entry")
      const bundle = await exportWorkspaceBundleV2(doc, options.readAttachment)
      const inspection = await readWorkspaceBundleV2(bundle)
      if (!inspection.ok) throw new Error(inspection.error.message)
      files[workspaceBundleFilename(doc)] = bundle
      missingAttachmentCount += inspection.value.manifest.missingBlobHashes.length
      options.onProgress?.({ completed: index + 1, total: workspaces.length })
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "unknown export error"
      throw new Error(`Could not export “${summary.title}”: ${reason}`, { cause })
    }
  }
  return { bytes: zipSync(files), workspaceCount: workspaces.length, missingAttachmentCount }
}

export async function exportAllAvailableWorkspaces(core: ReturnType<typeof useAppCore>,
  onProgress?: (progress: WorkspaceExportProgress) => void): Promise<void> {
  const result = await createAllWorkspaceArchive({
    available: core.tincanban.availableWorkspaces.value,
    archived: core.tincanban.archivedWorkspaces.value,
    readWorkspaceDoc: id => core.tincanban.readWorkspaceDoc(id),
    readAttachment: reference => {
      const descriptor = blobDescriptor(reference)
      return descriptor ? readStoredAttachment(descriptor) : Promise.resolve(undefined)
    },
    onProgress,
  })
  downloadArchive(result.bytes, `tincanban-boards-${new Date().toISOString().slice(0, 10)}.zip`, "application/zip")
  core.notice.value = `Exported ${result.workspaceCount} local board${result.workspaceCount === 1 ? "" : "s"}; ${result.missingAttachmentCount} attachment${result.missingAttachmentCount === 1 ? " was" : "s were"} unavailable`
}

function downloadBundle(bytes: Uint8Array, title: string) {
  const filename = `${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.tincanban`
  downloadArchive(bytes, filename, "application/vnd.tincanban+zip")
}

function downloadArchive(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

function workspaceBundleFilename(doc: WorkspaceDocumentV2): string {
  const title = safeFilenameStem(doc.title).slice(0, 64) || "board"
  const id = Array.from(doc.id, character => character.codePointAt(0)!.toString(16)).join("-") || "empty"
  return `${title}-${id}.tincanban`
}

function safeFilenameStem(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")
}

export async function importWorkspaceFile(core: ReturnType<typeof useAppCore>, event: Event, state: { busy: boolean; error: string }) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file || state.busy) return
  state.busy = true
  state.error = ""
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const bundle = await readWorkspaceBundleV2(bytes)
    if (!bundle.ok) throw new Error(bundle.error.message)
    const result = await importVersion2Bundle(core, bundle.value)
    const attachmentNotice = result.missingAttachments
      ? `${result.missingAttachments} attachment${result.missingAttachments === 1 ? "" : "s"} unavailable in the file`
      : "all attachments available"
    const automationNotice = result.omittedAutomations
      ? `${result.omittedAutomations} source-approved automation${result.omittedAutomations === 1 ? "" : "s"} omitted because approvals do not transfer to the imported board`
      : ""
    const details = [attachmentNotice, automationNotice].filter(Boolean).join("; ")
    core.notice.value = result.syncError
      ? `Imported as a new board; ${details}; sync setup failed: ${result.syncError}`
      : `Imported as a new board; ${details}`
    core.showWorkspaces.value = false
  } catch (error) { state.error = error instanceof Error ? error.message : "tincanban bundle import failed" }
  finally { state.busy = false }
}

type Version2Bundle = { doc: WorkspaceDocumentV2; blobs: BundleBlob[]; manifest: { missingBlobHashes: string[] } }

async function importVersion2Bundle(core: ReturnType<typeof useAppCore>, bundle: Version2Bundle): Promise<{ missingAttachments: number; omittedAutomations: number; syncError?: string }> {
  const omittedAutomations = Object.values(bundle.doc.entities).filter(entity => hasEntityKind(entity, "automation")).length
  await restoreBundleAttachments(bundle)
  const doc = await core.tincanban.importWorkspaceAsNew(bundle.doc)
  try {
    await core.sync.addOwnerWorkspace(doc.id)
    return { missingAttachments: bundle.manifest.missingBlobHashes.length, omittedAutomations }
  } catch (error) {
    return { missingAttachments: bundle.manifest.missingBlobHashes.length, omittedAutomations, syncError: messageFrom(error) }
  }
}

async function restoreBundleAttachments(bundle: Version2Bundle): Promise<void> {
  const bytesById = new Map(bundle.blobs.map(blob => [blob.blobId, blob.bytes]))
  for (const entity of Object.values(bundle.doc.entities)) {
    const references = hasEntityKind(entity, "document") ? [entity.file]
      : hasEntityKind(entity, "artifact") ? [entity.pdf, entity.sourceMarkdown] : []
    for (const reference of references) {
      if (!reference) continue
      const descriptor = blobDescriptor(reference)
      const blobId = referenceBlobId(reference)
      const bytes = blobId ? bytesById.get(blobId) : undefined
      if (descriptor && bytes) {
        await verifyBlobBytes(descriptor, bytes)
        await writeStoredAttachment(descriptor, bytes)
      }
    }
  }
}


function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "try again"
}

export async function saveWorkspaceTemplate(core: ReturnType<typeof useAppCore>, payload: { id?: string; newId?: string; name: string; markdown: string }) {
    const id = payload.id ?? payload.newId ?? crypto.randomUUID()
    if (payload.id || core.tincanban.workspace.templates.some(template => template.id === id)) await core.tincanban.updateTemplateAsync(id, { name: payload.name, markdown: payload.markdown })
    else await core.tincanban.createTemplateAsync({ id, name: payload.name, markdown: payload.markdown })
    return id
}
