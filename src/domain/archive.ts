import { getAncestryPath } from "./ancestry"
import { hasEntityKind, isItem, type Board, type Item, type WorkspaceDocumentV2, type WorkspaceEntity } from "./model"
import { isArchiveColumn, type ArchiveColumnLike } from "./archiveColumn"
import { isItemArchived } from "./itemLifecycle"
export { isArchiveColumn, type ArchiveColumnLike } from "./archiveColumn"
export { isItemArchived, itemLifecycle, itemWorkflow, setItemLifecycle, setItemWorkflow, type ItemWorkflow } from "./itemLifecycle"

export function workflowColumnId(entities: Record<string, WorkspaceEntity>, entityId: string): string | undefined {
  return getAncestryPath(entities, entityId).path.find(id => hasEntityKind(entities[id], "column"))
}

export function effectiveColumnStatus<T extends string>(column: ArchiveColumnLike, board: Pick<Board, "archiveColumnId"> | undefined, status: T | undefined): T | undefined {
  return status === "archived" && !isArchiveColumn(column, board) ? undefined : status
}

export function isArchiveColumnInWorkspace(column: ArchiveColumnLike & { placement?: { parentId?: string | null } }, entities: Record<string, unknown>): boolean {
  const boardId = column.placement?.parentId
  const board = boardId ? entities[boardId] as { kind?: string; archiveColumnId?: string | null } | undefined : undefined
  if (board?.kind === "board" && board.archiveColumnId !== undefined) return board.archiveColumnId === column.id
  return column.archive === true
}

export function archivedItemsForBoard(doc: WorkspaceDocumentV2, boardId: string): Item[] {
  return Object.values(doc.entities).filter((entity): entity is Item => {
    if (!isItem(entity) || !isItemArchived(entity)) return false
    const ancestry = getAncestryPath(doc.entities, entity.id)
    return !ancestry.issue && ancestry.path.includes(boardId)
  })
}
