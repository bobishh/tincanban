type CardNodePath = { itemId: string; indices: number[]; text: string | null }
export type SelectionSnapshot = {
  anchorNode: Node; anchorOffset: number; focusNode: Node; focusOffset: number
  anchorPath: CardNodePath | null; focusPath: CardNodePath | null
  range: Range
}

function cardNodePath(node: Node): CardNodePath | null {
  const card = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-item-id]")
  if (!card?.dataset.itemId) return null
  const indices: number[] = []
  let current = node
  while (current !== card) {
    const parent = current.parentNode
    if (!parent) return null
    indices.unshift(Array.from(parent.childNodes).indexOf(current as ChildNode))
    current = parent
  }
  return { itemId: card.dataset.itemId, indices, text: node.textContent }
}

function resolveNode(node: Node, path: CardNodePath | null, board: HTMLElement | null): Node | null {
  if (node.isConnected) return node
  if (!path) return null
  let current: Node | undefined = board?.querySelector(`[data-item-id="${CSS.escape(path.itemId)}"]`) ?? undefined
  for (const index of path.indices) current = current?.childNodes[index]
  return current?.textContent === path.text ? current : null
}

export function captureSelection(): SelectionSnapshot | null {
  const selection = document.getSelection()
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null
  return { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode, focusOffset: selection.focusOffset,
    anchorPath: cardNodePath(selection.anchorNode), focusPath: cardNodePath(selection.focusNode),
    range: selection.getRangeAt(0).cloneRange() }
}

export function restoreSelection(snapshot: SelectionSnapshot | null, board: HTMLElement | null) {
  const selection = document.getSelection()
  if (!selection) return
  if (!snapshot) {
    if (selection.anchorNode && board?.contains(selection.anchorNode)) selection.removeAllRanges()
    return
  }
  // Crossing columns recreates the card's Vue nodes. Restore the same text
  // endpoints after render rather than retaining disconnected DOM references.
  const anchor = resolveNode(snapshot.anchorNode, snapshot.anchorPath, board)
  const focus = resolveNode(snapshot.focusNode, snapshot.focusPath, board)
  if (!anchor || !focus) return
  if (selection.anchorNode === anchor && selection.anchorOffset === snapshot.anchorOffset &&
    selection.focusNode === focus && selection.focusOffset === snapshot.focusOffset) return
  applySelection(selection, snapshot, anchor, focus)
}

function applySelection(selection: Selection, snapshot: SelectionSnapshot, anchor: Node, focus: Node) {
  selection.removeAllRanges()
  if (typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(anchor, snapshot.anchorOffset, focus, snapshot.focusOffset)
  } else {
    const range = snapshot.range.cloneRange()
    const forward = anchor === focus ? snapshot.anchorOffset <= snapshot.focusOffset
      : Boolean(anchor.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING)
    range.setStart(forward ? anchor : focus, forward ? snapshot.anchorOffset : snapshot.focusOffset)
    range.setEnd(forward ? focus : anchor, forward ? snapshot.focusOffset : snapshot.anchorOffset)
    selection.addRange(range)
  }
}
import { nextTick } from "vue"


export function preserveSelectionAfterMove(snapshot: SelectionSnapshot | null, board: () => HTMLElement | null, committed: Promise<unknown>) {
  const restore = () => nextTick(() => restoreSelection(snapshot, board()))
  void restore()
  void committed.then(restore, restore)
}
