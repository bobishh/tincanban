import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./model"
import type { HistoryEntry } from "./historyTypes"
export type { HistoryEntry } from "./historyTypes"

export function projectDocumentHistory(doc: Automerge.Doc<WorkspaceDocumentV2>): HistoryEntry[] {
  const history = Automerge.getChangesMetaSince(doc, [])
  const entries: HistoryEntry[] = []

  for (const change of history) {
    let action = "change"
    let entityIds: string[] = []
    let personId: string | undefined
    let deviceId: string | undefined
    let isLegacy = true
    let authorLabel = "Imported"

    if (change.message) {
      try {
        const meta: unknown = JSON.parse(change.message)
        if (isTransactionMetadata(meta)) {
          action = meta.action || "change"
          entityIds = meta.entityIds
          personId = meta.personId
          deviceId = meta.deviceId
          authorLabel = personId ? "Unverified author" : "System change"
          isLegacy = false
        } else {
          isLegacy = true
          authorLabel = "Imported"
          action = change.message
        }
      } catch {
        isLegacy = true
        authorLabel = "Imported"
        action = change.message
      }
    }

    entries.push({
      hash: change.hash,
      time: change.time,
      actor: change.actor,
      action,
      entityIds,
      personId,
      deviceId,
      authorLabel,
      isLegacy,
      message: change.message,
    })
  }

  return entries
}

function isTransactionMetadata(value: unknown): value is { version: 1; action: string; entityIds: string[]; personId?: string; deviceId?: string } {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return candidate.version === 1 && typeof candidate.action === "string"
    && Array.isArray(candidate.entityIds) && candidate.entityIds.every(id => typeof id === "string")
    && (candidate.personId === undefined || typeof candidate.personId === "string")
    && (candidate.deviceId === undefined || typeof candidate.deviceId === "string")
}

export function projectEntityHistory(doc: Automerge.Doc<WorkspaceDocumentV2>, entityId: string): HistoryEntry[] {
  const allHistory = projectDocumentHistory(doc)
  return allHistory.filter((entry) => entry.entityIds.includes(entityId))
}
