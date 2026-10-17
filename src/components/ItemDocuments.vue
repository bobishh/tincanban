<script setup lang="ts">
import { attachmentTextPreview } from "../attachmentTextPreview"
import { MarkdownContent } from "../ui/markdownContent"
import { computed, onBeforeUnmount, ref } from "vue"
import type { FileReference } from "../domain/entitySchemas"
import { attachmentMediaType, attachmentName, attachmentSize } from "../domain/filePresentation"
import type { Document, DocumentInput } from "../types"
import { isInlineNarrativeNote } from "../domain/narrative"
import ModalLayer from "./ModalLayer.vue"
import { attachmentCoveragePresentation, type AttachmentCoverageStatus } from "./attachmentCoveragePresentation"

type DocumentDraft = Omit<DocumentInput, "itemId">

const props = defineProps<{
  documents: Document[]
  workspaceId?: string
  attachmentCoverage?: Record<string, AttachmentCoverageStatus[]>
  readOnly?: boolean
  readFile?: (file: FileReference) => Promise<Uint8Array | undefined>
  storeFile?: (file: File) => Promise<FileReference>
  downloadUrl?: (document: Document) => string
  save: (document: DocumentDraft) => Promise<void>
  update: (documentId: string, content: string) => Promise<void>
}>()

const formOpen = ref(false)
const title = ref("")
const file = ref<File | null>(null)
const saving = ref(false)
const error = ref("")
const preview = ref<Document | null>(null)
const previewText = ref("")
const previewUrl = ref("")
const previewError = ref("")
const previewSaving = ref(false)
const previewStatus = ref("")
const previewTruncated = ref(false)
let previewRequest = 0
const visibleDocuments = computed(() => props.documents.filter(document => !isInlineNarrativeNote({ ...document, content: document.content ?? null, documentKind: document.kind })))

function coverageFor(document: Document) {
  return attachmentCoveragePresentation(props.attachmentCoverage, props.workspaceId, document.file)
}

async function attach() {
  const trimmedTitle = title.value.trim()
  if (!trimmedTitle || saving.value) return
  const save = props.save
  saving.value = true
  error.value = ""
  try {
    if (!file.value) {
      error.value = "Choose a file"
      return
    }
    if (!props.storeFile) throw new Error("File attachments are unavailable.")
    const reference = await props.storeFile(file.value)
    await save({
      kind: "attachment",
      title: trimmedTitle,
      format: attachmentMediaType(reference) === "application/pdf" ? "pdf" : "file",
      file: reference,
    })
    resetForm()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}

function selectFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

function resetForm() {
  formOpen.value = false
  title.value = ""
  file.value = null
  error.value = ""
}

async function openPreview(document: Document) {
  closePreview()
  const request = ++previewRequest
  preview.value = document
  previewError.value = ""
  previewStatus.value = ""
  if (document.content !== undefined) {
    previewText.value = document.content
    return
  }
  if (!document.file) {
    previewError.value = document.localPath
      ? "This local path cannot be opened by the browser. Attach the file again."
      : "No preview content is attached."
    return
  }
  previewStatus.value = "Loading preview…"
  try {
    const bytes = await readDocumentFile(document.file)
    if (request !== previewRequest) return
    if (!bytes) {
      previewError.value = "File is not available on this device."
      return
    }
    const mediaType = attachmentMediaType(document.file)
    if (isText(mediaType) || isMarkdown(document)) {
      const decoded = attachmentTextPreview(bytes)
      previewText.value = decoded.text
      previewTruncated.value = decoded.truncated
    } else if (isEmbeddable(mediaType)) {
      previewUrl.value = URL.createObjectURL(blobFrom(bytes, mediaType))
    } else {
      previewError.value = "This file type has no inline preview. Download it to open it."
    }
  } catch (caught) {
    if (request === previewRequest) previewError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    if (request === previewRequest) previewStatus.value = ""
  }
}

function closePreview() {
  previewRequest += 1
  previewTruncated.value = false
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  preview.value = null
  previewText.value = ""
  previewUrl.value = ""
  previewError.value = ""
  previewStatus.value = ""
}

async function updatePreviewMarkdown(markdown: string) {
  if (!preview.value?.content || previewSaving.value) return
  const previous = previewText.value
  previewText.value = markdown
  previewSaving.value = true
  previewError.value = ""
  previewStatus.value = "Saving checklist…"
  try {
    await props.update(preview.value.id, markdown)
    preview.value = { ...preview.value, content: markdown }
    previewStatus.value = "Checklist saved"
  } catch (caught) {
    previewText.value = previous
    previewStatus.value = ""
    previewError.value = `Checklist not saved: ${caught instanceof Error ? caught.message : String(caught)}`
  } finally {
    previewSaving.value = false
  }
}

async function download(document: Document) {
  if (!document.file) return
  error.value = ""
  try {
    const bytes = await readDocumentFile(document.file)
    if (!bytes) {
      error.value = "File is not available on this device."
      return
    }
    const url = URL.createObjectURL(blobFrom(bytes, attachmentMediaType(document.file)))
    const link = window.document.createElement("a")
    link.href = url
    link.download = attachmentName(document.file)
    window.document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

function fileDescription(document: Document): string {
  if (!document.file) return document.format
  const size = attachmentSize(document.file)
  return `${attachmentName(document.file)}${size === undefined ? "" : ` · ${formatBytes(size)}`}`
}

async function readDocumentFile(reference: FileReference): Promise<Uint8Array | undefined> {
  return props.readFile?.(reference)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isMarkdown(document: Document): boolean {
  return document.format === "markdown" || Boolean(document.file && (
    attachmentMediaType(document.file) === "text/markdown" ||
    /\.(md|markdown)$/i.test(attachmentName(document.file))
  ))
}

function isText(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json"
}

function isEmbeddable(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType === "application/pdf"
}

function blobFrom(bytes: Uint8Array, type: string): Blob {
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Blob([data], { type })
}

onBeforeUnmount(closePreview)
</script>

<template>
  <section class="detail-section documents-section">
    <div class="section-heading">
      <div>
        <span class="detail-label">Attached documents</span>
        <h3>{{ visibleDocuments.length ? `${visibleDocuments.length} attached` : "Nothing attached" }}</h3>
      </div>
      <button class="button button-small" type="button" :disabled="readOnly" @click="formOpen = !formOpen">
        + File
      </button>
    </div>

    <form v-if="formOpen" class="document-form" aria-label="Attach document" @submit.prevent="attach">
      <label>
        <span>Title</span>
        <input v-model="title" required />
      </label>
      <label>
        <span>File</span>
        <input type="file" aria-label="File" required @change="selectFile" />
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="button button-primary" type="submit" :disabled="saving">
        {{ saving ? "Attaching…" : "Attach" }}
      </button>
    </form>

    <p v-else-if="error" class="form-error" role="alert">{{ error }}</p>
    <div
      v-for="document in visibleDocuments"
      :key="document.id"
      class="document-row"
      role="group"
      :aria-label="document.title"
    >
      <span class="document-icon">{{ document.file ? "FILE" : "NOTE" }}</span>
      <div>
        <strong>{{ document.title }}</strong>
        <span>{{ fileDescription(document) }}</span>
        <span v-if="document.file?.type === 'blob' && attachmentCoverage" class="attachment-coverage" role="status" aria-label="Encrypted attachment coverage">
          {{ coverageFor(document).label }}
          <small v-if="coverageFor(document).error">{{ coverageFor(document).error }}</small>
        </span>
      </div>
      <div class="document-actions">
        <button class="button button-small button-quiet" type="button" @click="openPreview(document)">Preview</button>
        <a v-if="downloadUrl && document.file" class="button button-small" :href="downloadUrl(document)" :download="attachmentName(document.file)" :aria-label="`Download ${document.title}`">Download</a>
        <button v-else-if="document.file?.type === 'blob'" class="button button-small" type="button" @click="download(document)">Download</button>
      </div>
    </div>

    <ModalLayer v-if="preview" @close="closePreview">
      <section class="dialog document-preview-dialog" role="dialog" aria-modal="true" aria-label="Document preview">
        <div class="detail-head">
          <div>
            <span class="eyebrow">Preview</span>
            <h2>{{ preview.title }}</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Close" @click="closePreview">×</button>
        </div>
        <p v-if="previewError" class="document-preview-message">{{ previewError }}</p>
        <p v-if="previewTruncated" class="document-preview-message">Showing the beginning of this file. Download to read the full text.</p>
        <p v-if="previewStatus" class="document-preview-message" role="status">{{ previewStatus }}</p>
        <iframe
          v-if="preview.content !== undefined && preview.format === 'html'"
          class="document-preview-frame"
          title="HTML document preview"
          sandbox=""
          :srcdoc="previewText"
        ></iframe>
        <MarkdownContent v-else-if="previewText && isMarkdown(preview)" class="document-preview-markdown" :source="previewText" :editable-tasks="!readOnly && preview.content !== undefined && !previewSaving" @task-toggle="updatePreviewMarkdown" />
        <pre v-else-if="previewText" class="document-preview-text">{{ previewText }}</pre>
        <img
          v-else-if="previewUrl && preview.file && attachmentMediaType(preview.file).startsWith('image/')"
          class="document-preview-image"
          :src="previewUrl"
          :alt="preview.title"
        />
        <iframe v-else-if="previewUrl" class="document-preview-frame" title="File preview" :src="previewUrl"></iframe>
      </section>
    </ModalLayer>
  </section>
</template>

<style scoped>
.attachment-coverage { display: block; font-size: .82em; opacity: .78; }
.attachment-coverage small { display: block; }
</style>
