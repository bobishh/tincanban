/** Original workspace sources included in private recovery; derived local progress is rebuilt on import. */
export const WORKSPACE_RECOVERY_STORES = [
  "snapshots", "authorizations", "changes", "archivedChanges", "archivedAuthorizations",
  "proofs", "receipts", "frontiers", "deltas", "receivedBaselines", "revisions",
] as const

export type WorkspaceRecoveryStoreName = typeof WORKSPACE_RECOVERY_STORES[number]
