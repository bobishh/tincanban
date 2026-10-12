import { hasEntityKind, type WorkspaceDocumentV2 } from "../domain/model"
import { verifyBlobBytes } from "@meta-uber/mesh-blob"
import { exportWorkspaceBundleV2, readWorkspaceBundleV2, referenceBlobId, type BundleBlob } from "../domain/workspaceBundle"
import { blobDescriptor, readStoredAttachment, writeStoredAttachment } from "../attachments"
import type { useAppCore } from "./useAppCore"

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

function downloadBundle(bytes: Uint8Array, title: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.tincanban+zip" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.tincanban`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
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
    core.notice.value = result.syncError
      ? `Imported as a new board; ${attachmentNotice}; sync setup failed: ${result.syncError}`
      : `Imported as a new board; ${attachmentNotice}`
    core.showWorkspaces.value = false
  } catch (error) { state.error = error instanceof Error ? error.message : "tincanban bundle import failed" }
  finally { state.busy = false }
}

type Version2Bundle = { doc: WorkspaceDocumentV2; blobs: BundleBlob[]; manifest: { missingBlobHashes: string[] } }

async function importVersion2Bundle(core: ReturnType<typeof useAppCore>, bundle: Version2Bundle): Promise<{ missingAttachments: number; syncError?: string }> {
  await restoreBundleAttachments(bundle)
  const doc = await core.tincanban.importWorkspaceAsNew(bundle.doc)
  try {
    await core.sync.addOwnerWorkspace(doc.id)
    return { missingAttachments: bundle.manifest.missingBlobHashes.length }
  } catch (error) {
    return { missingAttachments: bundle.manifest.missingBlobHashes.length, syncError: messageFrom(error) }
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
