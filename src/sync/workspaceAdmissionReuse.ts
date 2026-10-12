import type { WorkspaceAdmissionResult } from "./workspaceAdmissionCore"

// Keep only the latest exact packet result in memory. Durable projection reuse
// uses the separate atomic admission checkpoint, never this network-input cache.
const recent = new Map<string, { key: string; result: WorkspaceAdmissionResult }>()
const maxWorkspaces = 8

export function reusedWorkspaceAdmission(workspaceId: string, key: string): WorkspaceAdmissionResult | undefined {
  const entry = recent.get(workspaceId)
  return entry?.key === key ? structuredClone(entry.result) : undefined
}

export function rememberWorkspaceAdmission(workspaceId: string, key: string, result: WorkspaceAdmissionResult): void {
  recent.delete(workspaceId)
  recent.set(workspaceId, { key, result: structuredClone(result) })
  if (recent.size > maxWorkspaces) recent.delete(recent.keys().next().value!)
}
