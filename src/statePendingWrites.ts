import type { Command } from "./domain/commands"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { beginPendingItemMove } from "./pendingItemMoves"
import { stateRuntime } from "./stateContext"

export function startPendingWrite(doc: WorkspaceDocumentV2 | null, command: Command): () => void {
  if (stateRuntime.pendingWrites === 0) stateRuntime.batchSaveFailed = false
  stateRuntime.pendingWrites += 1
  stateRuntime.saveState.value = "saving"
  const finishPreview = doc ? beginPendingItemMove(doc, command) : () => {}
  return () => {
    finishPreview()
    stateRuntime.pendingWrites -= 1
    stateRuntime.saveState.value = stateRuntime.pendingWrites
      ? "saving" : stateRuntime.batchSaveFailed ? "error" : "saved"
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", event => {
    if (!stateRuntime.pendingWrites) return
    event.preventDefault()
    event.returnValue = ""
  })
}
