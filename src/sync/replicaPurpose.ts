/** Reject private identity-state settings at workspace-only replication boundaries. */
export function assertWorkspaceReplicaPurpose(config: unknown): asserts config is { workspaceId: string; purpose?: "workspace" } {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw invalidPurpose()
  const value = config as Record<string, unknown>
  const hasPurpose = Object.hasOwn(value, "purpose")
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim() ||
      (hasPurpose && value.purpose !== "workspace") || "personId" in value) throw invalidPurpose()
}

function invalidPurpose(): Error {
  return new Error("Identity replica config cannot be used for workspace replication")
}
