import { commitAndPersist } from "./statePersistence";
import { stateRuntime } from "./stateContext";
import type {
  Artifact,
  ArtifactInput,
  Document,
  DocumentInput,
  Template,
  TemplateInput,
} from "./types";

type DocumentInputWithId = DocumentInput & { id?: string };
type TemplateInputWithId = TemplateInput & { id?: string };
type ArtifactInputWithId = ArtifactInput & { id?: string };

export function createContentActions() {
  return {
    createDocumentAsync,
    updateDocumentAsync,
    createTemplateAsync,
    updateTemplateAsync,
    createArtifactAsync,
    documentsFor,
    artifactsFor,
  };
}

async function updateDocumentAsync(documentId: string, content: string): Promise<void> {
  await commitAndPersist({ kind: "patchDocument", documentId, content });
}

async function createDocumentAsync(
  input: DocumentInputWithId,
): Promise<Document> {
  const id = input.id ?? crypto.randomUUID();
  await commitAndPersist({
    kind: "addDocument",
    id,
    itemId: input.itemId,
    documentKind: input.kind,
    title: input.title,
    format: input.format,
    content: input.content,
    file: input.file,
    localPath: input.localPath,
  });
  return (
    stateRuntime.workspace.documents.find((document) => document.id === id) ??
    fallbackDocument(id, input)
  );
}

function fallbackDocument(id: string, input: DocumentInput): Document {
  const now = new Date().toISOString();
  return { id, ...input, createdAt: now, updatedAt: now };
}

async function createTemplateAsync(
  input: TemplateInputWithId,
): Promise<Template> {
  const id = input.id ?? crypto.randomUUID();
  await commitAndPersist({
    kind: "createTemplate",
    id,
    title: input.name,
    markdown: input.markdown,
  });
  return (
    stateRuntime.workspace.templates.find((template) => template.id === id) ??
    fallbackTemplate(id, input)
  );
}

async function updateTemplateAsync(
  templateId: string,
  patch: Partial<TemplateInput>,
): Promise<void> {
  await commitAndPersist({
    kind: "patchTemplate",
    templateId,
    title: patch.name,
    markdown: patch.markdown,
  });
}

function fallbackTemplate(id: string, input: TemplateInput): Template {
  const now = new Date().toISOString();
  return {
    id,
    name: input.name,
    markdown: input.markdown,
    createdAt: now,
    updatedAt: now,
  };
}

async function createArtifactAsync(
  input: ArtifactInputWithId,
): Promise<Artifact> {
  const id = input.id ?? crypto.randomUUID();
  await commitAndPersist({
    kind: "recordArtifact",
    id,
    itemId: input.itemId,
    templateId: input.templateId,
    title: input.title,
    artifactKind: input.kind,
    pdf: localFile(input.pdfPath),
    sourceMarkdown: input.sourceMarkdownPath
      ? localFile(input.sourceMarkdownPath)
      : null,
  });
  return (
    stateRuntime.workspace.artifacts.find((artifact) => artifact.id === id) ??
    fallbackArtifact(id, input)
  );
}

function documentsFor(itemId: string): Document[] {
  return stateRuntime.workspace.documents.filter(
    (document) => document.itemId === itemId,
  );
}

function artifactsFor(itemId: string): Artifact[] {
  return stateRuntime.workspace.artifacts.filter(
    (artifact) => artifact.itemId === itemId,
  );
}

function localFile(fileName: string) {
  return { type: "local-file" as const, fileId: crypto.randomUUID(), fileName };
}

function fallbackArtifact(id: string, input: ArtifactInput): Artifact {
  const now = new Date().toISOString();
  return { id, ...input, createdAt: now, updatedAt: now };
}
