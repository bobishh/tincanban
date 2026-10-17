import { hasEntityKind } from "./domain/model"
import { computed } from "vue";
import {
  derivePlacementIssues,
  childrenIndex,
  indexedChildren,
  visibleIndexedChildren,
} from "./domain/ancestry";
import {
  isItem,
  type Board,
  type Column,
  type FieldDefinition,
  type Item,
  type WorkspaceDocumentV2,
} from "./domain/model";
import { projectItemPriority } from "./domain/priority";
import { archivedItemsForBoard, isArchiveColumn, isItemArchived } from "./domain/archive";
import { stateRuntime } from "./stateContext";
import { projectPendingItemMoves } from "./pendingItemMoves";

export function createStateDerived() {
  const activeBoard = computed(() => {
    void stateRuntime.docVersion.value;
    return stateRuntime.activeDoc
      ? (Object.values(stateRuntime.activeDoc.entities).find(
          (entity): entity is Board => hasEntityKind(entity, "board"),
        ) ?? null)
      : null;
  });
  const genericColumns = computed(() =>
    projectGenericColumns(activeBoard.value),
  );
  const boardFields = computed(() => projectBoardFields(activeBoard.value));
  const placementIssues = computed(() => projectPlacementIssues());

  return {
    activeBoard,
    genericColumns,
    boardFields,
    placementIssues,
  };
}

function projectGenericColumns(board: Board | null) {
  void stateRuntime.docVersion.value;
  if (!stateRuntime.activeDoc || !board) return [];
  const doc = projectPendingItemMoves(stateRuntime.activeDoc);
  const childrenByParent = childrenIndex(doc.entities)
  const archivedItems = archivedItemsForBoard(doc, board.id);
  return indexedChildren(childrenByParent, board.id)
    .filter(
      (entity): entity is Column => hasEntityKind(entity, "column") && !entity.archivedAt,
    )
    .map((column) => ({
      ...column,
      ...(isArchiveColumn(column, board) ? { archive: true as const } : {}),
      items: (isArchiveColumn(column, board)
        ? archivedItems
        : visibleIndexedChildren(childrenByParent, doc.entities, column.id).filter((entity): entity is Item => isItem(entity)))
        .map((sourceItem) => ({
          ...projectItemPriority(board, sourceItem, textNotesFieldId(doc.entities, board)),
          subitems: indexedChildren(childrenByParent, sourceItem.id).filter(
            (entity): entity is Item => isItem(entity) && !isItemArchived(entity),
          ),
        })),
    }));
}

function textNotesFieldId(entities: WorkspaceDocumentV2["entities"], board: Board): string | undefined {
  const id = board.cardPresentation?.narrativeFieldId
  return id && entities[id]?.kind === "field" && entities[id].valueType === "text" ? id : undefined
}

function projectBoardFields(board: Board | null): FieldDefinition[] {
  void stateRuntime.docVersion.value;
  const doc = stateRuntime.activeDoc;
  if (!doc || !board) return [];
  return Object.values(doc.entities).filter(
    (entity): entity is FieldDefinition =>
      hasEntityKind(entity, "field") &&
      entity.placement.parentId === board.id &&
      !entity.archivedAt,
  );
}

function projectPlacementIssues() {
  void stateRuntime.docVersion.value;
  return stateRuntime.activeDoc
    ? derivePlacementIssues(stateRuntime.activeDoc.entities)
    : [];
}
