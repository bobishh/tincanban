export interface HistoryEntry {
  hash: string
  time: number
  actor: string
  action: string
  entityIds: string[]
  personId?: string
  deviceId?: string
  authorLabel: string
  isLegacy: boolean
  message?: string | null
  archive?: { sourceId: string; baselineId: string; historyEpoch: number; observation: "admitted" | "pending" | "quarantined" }
}
