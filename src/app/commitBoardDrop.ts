import { isArchiveColumn, isItemArchived } from "../domain/archive"
import { isItem } from "../domain/model"
import type { AppBoardContext } from "./useAppBoard"
import type { DropMarker } from "./boardDragTarget"

type Drag = { id: string; kind: "item" | "column"; source: HTMLElement; sourceParentId: string; target: DropMarker | null; title: string }
type Presentation = { highlightMoved(id: string, kind: "item" | "column"): void }

export async function commitBoardDrop(drag: Drag, core: AppBoardContext, presentation: Presentation) {
  if (!drag.target || !core.tincanban.activeBoard.value) return
  if (drag.kind === "column") return commitColumnDrop(drag, core, presentation)
  return commitItemDrop(drag, core, presentation)
}

async function commitColumnDrop(drag: Drag, core: AppBoardContext, presentation: Presentation) {
  const columns = core.tincanban.genericColumns.value
  const withoutSource = columns.filter(column => column.id !== drag.id)
  const index = drag.target!.beforeId ? withoutSource.findIndex(column => column.id === drag.target!.beforeId) : withoutSource.length
  const next = [...withoutSource]
  next.splice(index, 0, columns.find(column => column.id === drag.id)!)
  if (columns.every((column, position) => column.id === next[position]?.id)) return
  try {
    await core.tincanban.executeCommandAsync({ kind: "moveEntity", entityId: drag.id, parentId: core.tincanban.activeBoard.value!.id, beforeId: withoutSource[index]?.id ?? null })
    presentation.highlightMoved(drag.id, "column")
    core.notice.value = "Column moved"
  } catch (error) { core.notice.value = moveFailure(error) }
}

async function commitItemDrop(drag: Drag, core: AppBoardContext, presentation: Presentation) {
  const parentId = drag.target!.targetId
  const sourceItem = core.tincanban.getPresentedWorkspaceDoc()?.entities[drag.id]
  const sourceColumn = core.tincanban.genericColumns.value.find(column => column.id === drag.sourceParentId)
  const targetColumn = core.tincanban.genericColumns.value.find(column => column.id === parentId)
  const archiveTarget = Boolean(targetColumn && isArchiveColumn(targetColumn))
  if (!isItem(sourceItem) || archiveTarget && isItemArchived(sourceItem)) return
  if (!archiveTarget && !isItemArchived(sourceItem) && sourceItem.placement.parentId === parentId && unchangedVisiblePosition(drag)) return
  const command = itemMoveCommand(drag, parentId, archiveTarget)
  try {
    await core.tincanban.executeCommandAsync(command)
    presentation.highlightMoved(drag.id, "item")
    if (archiveTarget && sourceColumn) {
      core.archiveUndo.value = { workspaceId: core.tincanban.activeWorkspace.id, itemId: drag.id, title: drag.title }
      core.notice.value = "Item archived"
    } else core.notice.value = "Item moved"
  } catch (error) { core.notice.value = moveFailure(error) }
}

function unchangedVisiblePosition(drag: Drag): boolean {
  // Filtering/priority can differ from stored rank order. An unchanged visible
  // position must not move hidden cards or rewrite a priority-sorted column.
  let next = drag.source.nextElementSibling
  while (next && !next.matches(".lead-card[data-item-id]")) next = next.nextElementSibling
  return (next instanceof HTMLElement ? next.dataset.itemId ?? null : null) === drag.target?.beforeId
}

function itemMoveCommand(drag: Drag, parentId: string, archive: boolean) {
  if (archive) return { kind: "setEntityArchived" as const, entityId: drag.id, archived: true }
  return { kind: "restoreAndMove" as const, entityId: drag.id, parentId, beforeId: drag.target?.beforeId }
}

function moveFailure(error: unknown) { return `Move failed: ${error instanceof Error ? error.message : String(error)}` }
