export type DropMarker = { targetId: string; beforeId: string | null; vertical?: boolean }
export type DragTarget = { marker: DropMarker }
export type DragHit = { id: string; kind: "item" | "column"; source: HTMLElement; x: number; y: number }

export function findDragTarget(drag: DragHit, board: HTMLElement): DragTarget | null {
  const columns = [...board.querySelectorAll<HTMLElement>(":scope > .column[data-column-id]")]
  const hovered = columns.find(column => inside(column, drag.x, drag.y))
  if (!hovered) return null
  return drag.kind === "column" ? columnTarget(drag, columns, hovered) : cardTarget(drag, hovered)
}

function columnTarget(drag: DragHit, columns: HTMLElement[], hovered: HTMLElement): DragTarget {
  const siblings = columns.filter(column => column !== drag.source)
  const before = siblings.find(column => drag.x < center(column.getBoundingClientRect().left, column.getBoundingClientRect().right))
  return {
    marker: { targetId: hovered.dataset.columnId!, beforeId: before?.dataset.columnId ?? null, vertical: true },
  }
}

function cardTarget(drag: DragHit, column: HTMLElement): DragTarget | null {
  const stack = column.querySelector<HTMLElement>(".card-stack[data-column-id]")
  if (!stack) return archiveTarget(column)
  const cards = [...stack.querySelectorAll<HTMLElement>(":scope > .lead-card[data-item-id]")].filter(card => card !== drag.source)
  const before = cards.find(card => drag.y < center(card.getBoundingClientRect().top, card.getBoundingClientRect().bottom))
  return {
    marker: { targetId: stack.dataset.columnId!, beforeId: before?.dataset.itemId ?? null },
  }
}

function archiveTarget(column: HTMLElement): DragTarget | null {
  if (!column.classList.contains("bin-column")) return null
  return { marker: { targetId: column.dataset.columnId!, beforeId: null } }
}

function inside(element: HTMLElement, x: number, y: number) {
  const bounds = element.getBoundingClientRect()
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
}
function center(start: number, end: number) { return start + (end - start) / 2 }
