import type { HistoryEntry } from "../domain/historyTypes"

const knownActions: Record<string, string> = {
  createItem: "Create item",
  patchItem: "Update item",
  setEntityArchived: "Archive or restore item",
  restoreItem: "Restore item",
  restoreItemVersion: "Restore item version",
  moveEntity: "Move item",
  restoreAndMove: "Restore and move item",
  addDocument: "Add document",
  patchDocument: "Update document",
  reviewQuarantinedChange: "Review quarantined change",
}

export function historyAuthorLabel(entry: HistoryEntry, verifiedPersonName?: string): string {
  if (entry.archive) return "Archived author claim"
  if (entry.isLegacy) return "Imported"
  if (!entry.personId) return "System change"
  return verifiedPersonName?.trim() || "Unverified author"
}

export function historyActionLabel(action: string): string {
  const label = knownActions[action] ?? action.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ").trim().toLowerCase().replace(/^\w/u, letter => letter.toUpperCase())
  return label || "Change"
}
