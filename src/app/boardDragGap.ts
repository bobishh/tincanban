import type { DropMarker } from "./boardDragTarget"

export function createBoardDragGap() {
  let element: HTMLElement | null = null
  const clear = () => {
    if (!element) return
    element.classList.remove("board-drop-gap", "board-drop-gap-before", "board-drop-gap-after")
    delete element.dataset.targetId
    delete element.dataset.beforeId
    element = null
  }
  const show = (target: DropMarker | null, source: HTMLElement, board: HTMLElement) => {
    if (!target) return
    const column = board.querySelector<HTMLElement>(`:scope > [data-column-id="${CSS.escape(target.targetId)}"]`)
    if (!column) return
    const siblings = target.vertical
      ? [...board.querySelectorAll<HTMLElement>(":scope > .column")]
      : [...column.querySelectorAll<HTMLElement>(".card-stack > .lead-card[data-item-id]")]
    const cards = siblings.filter(card => card !== source)
    const before = cards.find(card => (target.vertical ? card.dataset.columnId : card.dataset.itemId) === target.beforeId)
    const next = siblings[siblings.indexOf(source) + 1]
    if (siblings.includes(source) && before === next) return
    element = before ?? cards.at(-1) ?? column.querySelector<HTMLElement>(".empty-column, .column-closed, .column-add-button")
    if (!element) return
    element.classList.add("board-drop-gap", before || !cards.length ? "board-drop-gap-before" : "board-drop-gap-after")
    element.dataset.targetId = target.targetId
    if (target.beforeId) element.dataset.beforeId = target.beforeId
  }
  return { clear, show }
}
