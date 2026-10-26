export type { SyncStep } from "../sync/useDeviceSync";

export type { OwnerReconnectReview } from "../sync/deviceSyncState"

export interface SuccessionView {
  successorPersonId: string | null
  eligibleEditorPersonIds: string[]
  votes: Array<{ voterPersonId: string; candidatePersonId: string }>
  quorum: number
  conflicted: boolean
}
