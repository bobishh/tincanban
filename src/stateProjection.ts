import { hasEntityKind } from "./domain/model"
import type * as Automerge from "@automerge/automerge/slim";
import { isEntityVisible } from "./domain/ancestry";
import { archivedItemsForBoard, isArchiveColumn } from "./domain/archive";
import {
  isItem,
  type AttachedDocument,
  type Board,
  type DocumentTemplate,
  type Item,
  type LegacyWritingTemplate,
  type PdfArtifact,
  type WorkspaceDocumentV2,
} from "./domain/model";
import { projectItemPriority } from "./domain/priority";
import type {
  Artifact,
  Document,
  Template,
  Workspace,
} from "./types";

function localFileName(
  reference: AttachedDocument["file"] | PdfArtifact["pdf"],
): string | undefined {
  return reference?.type === "local-file" ? reference.fileName : undefined;
}

function projectDocuments(doc: Automerge.Doc<WorkspaceDocumentV2>): Document[] {
  const documents = Object.values(doc.entities)
    .filter(
      (entity): entity is AttachedDocument =>
        hasEntityKind(entity, "document") && !entity.archivedAt,
    )
    .map((document) => ({
      id: document.id,
      itemId: document.placement.parentId || "",
      kind: document.documentKind,
      title: document.title,
      format: document.format,
      content: document.content || undefined,
      file: document.file ?? undefined,
      localPath: localFileName(document.file),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }));
  const artifacts: Document[] = Object.values(doc.entities).filter((entity): entity is PdfArtifact => hasEntityKind(entity, "artifact") && !entity.archivedAt)
    .map(artifact => ({ id: artifact.id, itemId: artifact.placement.parentId ?? "", kind: artifact.artifactKind,
      title: artifact.title, format: "file", file: artifact.pdf, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt }))
  return [...documents, ...artifacts];

}

function projectTemplates(doc: Automerge.Doc<WorkspaceDocumentV2>): Template[] {
  return Object.values(doc.entities)
    .filter(
      (entity): entity is DocumentTemplate | LegacyWritingTemplate =>
        (hasEntityKind(entity, "document_template") || hasEntityKind(entity, "template")) &&
        !entity.archivedAt,
    )
    .map((template) => ({
      id: template.id,
      name: template.title,
      markdown: template.markdown,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }));
}

function projectArtifacts(doc: Automerge.Doc<WorkspaceDocumentV2>): Artifact[] {
  return Object.values(doc.entities)
    .filter(
      (entity): entity is PdfArtifact =>
        hasEntityKind(entity, "artifact") && !entity.archivedAt,
    )
    .map((artifact) => ({
      id: artifact.id,
      itemId: artifact.placement.parentId || "",
      kind: artifact.artifactKind,
      title: artifact.title,
      templateId: artifact.templateId,
      pdfPath: localFileName(artifact.pdf) ?? artifact.pdf.fileName,
      sourceMarkdownPath: localFileName(artifact.sourceMarkdown),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    }));
}

export function projectWorkspace(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
): Workspace {
  const board = Object.values(doc.entities).find(
    (entity): entity is Board => hasEntityKind(entity, "board"),
  );
  const archiveExists = Boolean(board && (board.archiveColumnId !== undefined
    ? board.archiveColumnId !== null
    : Object.values(doc.entities).some(entity => hasEntityKind(entity, "column") && !entity.archivedAt && entity.placement.parentId === board.id && isArchiveColumn(entity, board))));
  const archivedIds = new Set(board && archiveExists ? archivedItemsForBoard(doc, board.id).map(item => item.id) : []);
  const items = Object.values(doc.entities)
    .filter(
      (entity): entity is Item =>
        isItem(entity) && (isEntityVisible(doc.entities, entity.id) || archivedIds.has(entity.id)),
    )
    .map(item => projectItemPriority(board, item, board?.cardPresentation?.narrativeFieldId));
  return {
    items,
    documents: projectDocuments(doc),
    templates: projectTemplates(doc),
    artifacts: projectArtifacts(doc),
  };
}
