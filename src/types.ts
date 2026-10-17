import type { FileReference, Item } from "./domain/model"

type DocumentKind = string
type DocumentFormat = "markdown" | "html" | "pdf" | "file" | "path"
type ArtifactKind = string

export type Document = {
  id: string
  itemId: string
  kind: DocumentKind
  title: string
  format: DocumentFormat
  content?: string
  file?: FileReference
  localPath?: string
  createdAt: string
  updatedAt: string
}

export type Template = {
  id: string
  name: string
  markdown: string
  createdAt: string
  updatedAt: string
}

export type Artifact = {
  id: string
  itemId: string
  kind: ArtifactKind
  title: string
  pdfPath: string
  templateId: string
  sourceMarkdownPath?: string
  createdAt: string
  updatedAt: string
}

export type Workspace = {
  items: Item[]
  documents: Document[]
  templates: Template[]
  artifacts: Artifact[]
}

export type DocumentInput = Omit<Document, "id" | "createdAt" | "updatedAt">
export type TemplateInput = Omit<Template, "id" | "createdAt" | "updatedAt">
export type ArtifactInput = Omit<Artifact, "id" | "createdAt" | "updatedAt">
