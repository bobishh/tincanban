import { leadPresentationBindings, presentLead, type LeadPresentationBindings } from "./domain/leadPresentation"
import { hasEntityKind } from "./domain/model"
import type * as Automerge from "@automerge/automerge/slim";
import { isEntityVisible } from "./domain/ancestry";
import { archivedItemsForBoard, effectiveColumnStatus, isArchiveColumn, isItemArchived } from "./domain/archive";
import {
  isItem,
  type AttachedDocument,
  type Board,
  type Column,
  type DocumentTemplate,
  type Item,
  type LegacyWritingTemplate,
  type PdfArtifact,
  type WorkspaceDocumentV2,
  type WorkspaceEntity,
} from "./domain/model";
import { projectItemPriority } from "./domain/priority";
import type {
  Artifact,
  Document,
  Lead,
  Template,
  Workspace,
} from "./types";

function findColumn(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null,
): Column | undefined {
  let current = parentId ? entities[parentId] : undefined;
  const visited = new Set<string>();
  while (current && !hasEntityKind(current, "column")) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    current = current.placement.parentId
      ? entities[current.placement.parentId]
      : undefined;
  }
  return current as Column | undefined;
}

function textNotesFieldId(doc: Automerge.Doc<WorkspaceDocumentV2>, board: Board | undefined): string | undefined {
  const notesFieldId = board?.preset?.bindings["field.notes"]
  const field = notesFieldId ? doc.entities[notesFieldId] : undefined
  return field?.kind === "field" && field.valueType === "text" ? notesFieldId : undefined
}

function projectLead(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  board: Board | undefined,
  source: Item,
  bindings: LeadPresentationBindings,
): Lead | undefined {
  const item = projectItemPriority(board, source, textNotesFieldId(doc, board))
  const column = findColumn(doc.entities, item.placement.parentId);
  if (!column) return undefined;
  if (isArchiveColumn(column, board) && !isItemArchived(item)) return undefined;
  return presentLead(item, isItemArchived(item) ? "archived" : effectiveColumnStatus(column, board, bindings.columnStatuses[column.id]) ?? "lead", bindings);
}

function localFileName(
  reference: AttachedDocument["file"] | PdfArtifact["pdf"],
): string | undefined {
  return reference?.type === "local-file" ? reference.fileName : undefined;
}

function projectDocuments(doc: Automerge.Doc<WorkspaceDocumentV2>): Document[] {
  return Object.values(doc.entities)
    .filter(
      (entity): entity is AttachedDocument =>
        hasEntityKind(entity, "document") && !entity.archivedAt,
    )
    .map((document) => ({
      id: document.id,
      leadId: document.placement.parentId || "",
      kind: document.documentKind,
      title: document.title,
      format: document.format,
      content: document.content || undefined,
      file: document.file ?? undefined,
      localPath: localFileName(document.file),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }));
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
      leadId: artifact.placement.parentId || "",
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
  const bindings = leadPresentationBindings(board?.preset?.bindings ?? {});
  const archiveExists = Boolean(board && (board.archiveColumnId !== undefined
    ? board.archiveColumnId !== null
    : Object.values(doc.entities).some(entity => hasEntityKind(entity, "column") && !entity.archivedAt && entity.placement.parentId === board.id && isArchiveColumn(entity, board))));
  const archivedIds = new Set(board && archiveExists ? archivedItemsForBoard(doc, board.id).map(item => item.id) : []);
  const leads = Object.values(doc.entities)
    .filter(
      (entity): entity is Item =>
        isItem(entity) && (isEntityVisible(doc.entities, entity.id) || archivedIds.has(entity.id)),
    )
    .map((item) => projectLead(doc, board, item, bindings))
    .filter((lead): lead is Lead => lead !== undefined);
  return {
    leads,
    documents: projectDocuments(doc),
    templates: projectTemplates(doc),
    artifacts: projectArtifacts(doc),
  };
}
