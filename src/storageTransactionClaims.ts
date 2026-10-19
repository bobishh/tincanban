import { WorkspaceRevisionConflict, type WorkspaceRevisionBasis } from "./storageCommitSupport"

export interface WorkspaceTransactionClaim { readonly kind: "workspace-transaction-claim" }

export type RegisteredWorkspaceTransaction = {
  storage: object
  workspaceId: string
  basis: WorkspaceRevisionBasis
  lifecycle: number
  live: boolean
  used: boolean
  context?: object
  lifecycleCurrent: () => boolean
}

const workspaceTransactions = new WeakMap<object, RegisteredWorkspaceTransaction>()
const workspaceClaims = new WeakMap<object, RegisteredWorkspaceTransaction>()

/** Internal registration used only while StorageTransactionAccess holds the workspace lock. */
export function registerWorkspaceTransaction(context: object, state: RegisteredWorkspaceTransaction): void {
  workspaceTransactions.set(context, state)
}

export function isCurrentWorkspaceTransaction(context: object | undefined,
  state: RegisteredWorkspaceTransaction, storage: object): boolean {
  return !!context && workspaceTransactions.get(context) === state && state.storage === storage && state.live && state.lifecycleCurrent()
}

export function isLiveWorkspaceTransaction(context: object, workspaceId: string, storage: object): boolean {
  const state = workspaceTransactions.get(context)
  return !!state && state.storage === storage && state.workspaceId === workspaceId && state.live &&
    workspaceTransactions.get(state.context!) === state && state.lifecycleCurrent()
}

export function claimWorkspaceTransaction(context: object, workspaceId: string): WorkspaceTransactionClaim {
  const state = workspaceTransactions.get(context)
  if (!state || state.workspaceId !== workspaceId || !state.live || state.used ||
      workspaceTransactions.get(state.context!) !== state || !state.lifecycleCurrent()) {
    throw new WorkspaceRevisionConflict()
  }
  state.used = true
  const claim = Object.freeze({ kind: "workspace-transaction-claim" as const })
  workspaceClaims.set(claim, state)
  return claim
}

export function resolveWorkspaceTransactionClaim(claim: WorkspaceTransactionClaim, workspaceId: string): {
  basis: WorkspaceRevisionBasis
  ensureCurrent: () => void
} {
  const state = workspaceClaims.get(claim as object)
  const ensureCurrent = () => assertClaimCurrent(state, workspaceId)
  ensureCurrent()
  return { basis: structuredClone(state!.basis), ensureCurrent }
}

function assertClaimCurrent(state: RegisteredWorkspaceTransaction | undefined, workspaceId: string): asserts state is RegisteredWorkspaceTransaction {
  if (!state || state.workspaceId !== workspaceId || !state.live ||
      workspaceTransactions.get(state.context!) !== state || !state.lifecycleCurrent()) {
    throw new WorkspaceRevisionConflict()
  }
}
