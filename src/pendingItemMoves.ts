import { shallowRef } from "vue"
import { moveEntity, restoreAndMove, setEntityArchived } from "./domain/commandBasicHandlers"
import type { Command } from "./domain/commands"
import { isItem, type WorkspaceDocumentV2 } from "./domain/model"

type ItemMove = Extract<Command, { kind: "moveEntity" | "restoreAndMove" | "setEntityArchived" }>
type PendingMove = { workspaceId: string; command: ItemMove; nowIso: string }
const pending = shallowRef<PendingMove[]>([])

// Presentation only. Commands still validate and commit against durable state.
export function beginPendingItemMove(doc: WorkspaceDocumentV2, command: Command): () => void {
  if ((command.kind !== "moveEntity" && command.kind !== "restoreAndMove" && command.kind !== "setEntityArchived") ||
    !isItem(doc.entities[command.entityId])) return () => {}
  const entry = { workspaceId: doc.id, command, nowIso: new Date().toISOString() }
  pending.value = [...pending.value, entry]
  return () => { pending.value = pending.value.filter(move => move !== entry) }
}

export function clearPendingItemMoves(): void {
  pending.value = []
}

export function projectPendingItemMoves(doc: WorkspaceDocumentV2): WorkspaceDocumentV2 {
  const moves = pending.value.filter(move => move.workspaceId === doc.id)
  if (!moves.length) return doc
  // Move handlers write entity scalars and placement only. Keep large text and
  // nested content shared; never clone or modify the Automerge history.
  const entities = Object.fromEntries(Object.entries(doc.entities).map(([id, entity]) =>
    [id, entity.kind === "application_source" ? entity : { ...entity, placement: { ...entity.placement } }]))
  const projected = { ...doc, entities }
  for (const move of moves) {
    const context = { nowIso: move.nowIso, beforeHeads: [] }
    const command = move.command
    const prepared = command.kind === "moveEntity" ? moveEntity(projected, command, context)
      : command.kind === "restoreAndMove" ? restoreAndMove(projected, command, context)
      : setEntityArchived(projected, command, context)
    // A concurrently removed target cannot be previewed. The durable command
    // reports its validation error and this view keeps the committed placement.
    if (prepared.ok) prepared.value.apply(projected)
  }
  return projected
}
