import type { Ref } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { PublicBoardDeliveryPolicyCache } from "../public/publicDeliveryPolicy"

export class PublicBoardSourceChangedError extends Error {
  constructor() { super("Board source changed during publication preparation") }
}

export interface PublicBoardAccessInput {
  origin: () => string
  connected: () => boolean
  boardId: () => string | null | undefined
  boardTitle: () => string
  workspaceId: () => string
  document: () => WorkspaceDocumentV2 | null | undefined
  sourceVersion: () => number
  sourceHeads: () => string[]
  owner: () => boolean
  profile: () => LocalProfile | null | undefined
  debounceMs?: number
}
export type CapturedAccessSource = {
  origin: string; boardId: string; workspaceId: string; profile: LocalProfile; document: WorkspaceDocumentV2
  sourceVersion: number; sourceHeads: string[]; ensureCurrent: () => void
}
export type PublicBoardAccessOperations = {
  input: PublicBoardAccessInput
  availability: Ref<"published" | "withdrawn" | "missing" | "unknown">
  checked: Ref<boolean>; published: Ref<boolean>; busy: Ref<boolean>; error: Ref<string>; revision: Ref<number>; withdrawn: Ref<boolean>; recoveryNeeded: Ref<boolean>; syncPending: Ref<boolean>
  state: { generation: number; syncQueued: boolean; operationRunning: boolean; refreshQueued: boolean; disposed: boolean;
    deliveryGeneration: number | null; deliveryPolicyHash: string | null; deliveryPolicyContentHash: string | null; retryCount: number; lastHash: string;
    projectionComparison?: string; policyCache: PublicBoardDeliveryPolicyCache }
  timers: { debounce?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>; status?: ReturnType<typeof setInterval> }
  capture: (options?: { requireUnchangedSource?: boolean; requireConnection?: boolean }) => CapturedAccessSource
  scheduleSync: (delay?: number) => void
  scheduleRetry: () => void
  refresh: () => Promise<void>
  deliverLatest: () => Promise<void>
}

