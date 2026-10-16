import type { HistoryEntry } from "../domain/historyTypes"

export interface ItemHistoryProps {
  history: HistoryEntry[]
  readOnly?: boolean
  historyLoading?: boolean
  historyError?: string
  historyNotice?: string
  historyHasMore?: boolean
  restoreSaving?: boolean
  restoreError?: string
  restoreNotice?: string
  verifiedPeople?: Record<string, string>
}
